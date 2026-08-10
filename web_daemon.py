#!/usr/bin/env python3
"""Web listener daemon — the persistent EAR for a taur.link-style chat hub.

SANITIZED REFERENCE COPY (Spector's rig). Configure via env vars or edit consts below:
  INBOX_PATH   jsonl file the brain reads (may be SHARED with other channel daemons —
               each line carries a "channel" field so one brain can read them all)
  CURSOR_PATH  file persisting the hub seq cursor
  STATE_DIR    same dir spector_web.py uses (replies ledger + human-readable inbox.md)
  ACK_TEXT     the one-time soft-ack line

Protocol (the important bits):
  * This process is the ONLY consumer of GET /agent/updates — one consumer per queue,
    or messages get split between readers. Brain never polls; it reads the inbox file.
  * On each visitor message:
      1. POST /agent/typing for that session instantly (visitor sees life)
      2. append JSON line {"channel":"web","session","name","text","ts","seq"}
         to INBOX_PATH (+ optional "member" if the hub tagged a redeemed session)
      3. if the brain hasn't replied within ~90s → ONE soft ack via POST /agent/reply,
         never more. Typing indicator is refreshed every ~8s while waiting.
  * Reply detection: the brain helper's `send` records {session: ts} in
    STATE_DIR/web_replies.json; a reply ts >= message ts clears the pending ack.
  * role:"system" hub messages (e.g. member_joined redemption events) are forwarded to
    the inbox with an "event" field and get NO soft-ack — brain handles the greeting.
  * Cursor (hub seq) persists in CURSOR_PATH so restarts don't replay history.
  * Long-poll wait=45s normally, but 5s while any session awaits a reply so the
    90s ack fires on time.

Keep-alive (shell-init revive pattern — put in your shell init / cron):
  pgrep -f web_daemon.py > /dev/null || \
      nohup python3 /path/to/web_daemon.py >> /path/to/web_daemon.log 2>&1 &
"""
import json, os, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import spector_web as web  # the brain helper doubles as the hub API lib

INBOX_JSONL = os.environ.get('INBOX_PATH', '/workspace/web_inbox.jsonl')
CURSOR = os.environ.get('CURSOR_PATH', '/workspace/web_cursor')
PIDFILE = os.environ.get('PIDFILE', '/workspace/web_daemon.pid')
HUMAN_LOG = web.DIR + '/inbox.md'
ACK_AFTER = 90
ACK_TEXT = os.environ.get('ACK_TEXT', '🐢 digging — moment')
TYPING_REFRESH = 8
PENDING_TTL = 600

pending = {}  # session -> {'ts': msg_ts, 'acked': bool, 'last_typing': ts}


def log(msg):
    print(time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime()) + ' ' + msg, flush=True)


def get_cursor():
    try:
        return int(open(CURSOR).read().strip())
    except Exception:
        return 0


def set_cursor(v):
    with open(CURSOR, 'w') as f:
        f.write(str(v))


def replies():
    try:
        return json.load(open(web.WEB_REPLIES))
    except Exception:
        return {}


def handle_message(m):
    session = m.get('session')
    if not session:
        return
    role = m.get('role') or 'visitor'
    if role not in ('visitor', 'system'):
        return  # agent's own replies etc. — not for the brain
    name = m.get('name') or 'visitor'
    text = m.get('text') or '[non-text message]'
    member = m.get('member')  # set by hub once an access code is redeemed (optional feature)
    now = time.time()
    entry = {'channel': 'web', 'session': session, 'name': name, 'text': text,
             'ts': m.get('ts', now), 'seq': m.get('seq')}
    if member:
        entry['member'] = member
    if role == 'system':
        # membership hub redemption event → brain greets the member by name.
        entry['event'] = 'member_joined'
        with open(INBOX_JSONL, 'a') as f:
            f.write(json.dumps(entry, ensure_ascii=False) + '\n')
        with open(HUMAN_LOG, 'a') as f:
            f.write(f"- [web] session:{session} SYSTEM member_joined member:{member}: {text}\n")
        try:
            web.api('/agent/typing', {'session': session}, timeout=10)
        except Exception:
            pass
        log(f'inbox <- web/{session} SYSTEM member_joined ({member}): {text[:80]!r}')
        return  # no soft-ack pending for system events
    try:
        web.api('/agent/typing', {'session': session}, timeout=10)
    except Exception as e:
        log('typing_err ' + str(e))
    with open(INBOX_JSONL, 'a') as f:
        f.write(json.dumps(entry, ensure_ascii=False) + '\n')
    with open(HUMAN_LOG, 'a') as f:
        f.write(f"- [web] session:{session} {name}{' [member:'+member+']' if member else ''}: {text}\n")
    pending[session] = {'ts': now, 'acked': False, 'last_typing': now}
    mtag = '/m:' + member if member else ''
    log(f'inbox <- web/{session} ({name}{mtag}): {text[:80]!r}')


def check_pending():
    if not pending:
        return
    now = time.time()
    r = replies()
    for sess, p in list(pending.items()):
        if float(r.get(sess, 0)) >= p['ts']:
            del pending[sess]
            continue
        if now - p['ts'] > PENDING_TTL:
            del pending[sess]
            continue
        if not p['acked'] and now - p['last_typing'] >= TYPING_REFRESH:
            try:
                web.api('/agent/typing', {'session': sess}, timeout=10)
            except Exception:
                pass
            p['last_typing'] = now
        if not p['acked'] and now - p['ts'] >= ACK_AFTER:
            try:
                web.api('/agent/reply', {'session': sess, 'text': ACK_TEXT})
                log(f'soft-ack -> session {sess}')
            except Exception as e:
                log('ack_err ' + str(e))
            p['acked'] = True


def main():
    with open(PIDFILE, 'w') as f:
        f.write(str(os.getpid()))
    log(f'web daemon start pid {os.getpid()}')
    while True:
        cursor = get_cursor()
        wait = 5 if pending else 45  # short polls while a session awaits reply → timely acks
        try:
            res = web.api(f'/agent/updates?after={cursor}&wait={wait}', timeout=wait + 15)
        except Exception as e:
            log('poll_err ' + str(e))
            time.sleep(5)
            check_pending()
            continue
        new_cursor = cursor
        for m in res.get('messages', []):
            if m.get('seq'):
                new_cursor = max(new_cursor, m['seq'])
            try:
                handle_message(m)
            except Exception as e:
                log('handle_err ' + str(e))
        if new_cursor != cursor:
            set_cursor(new_cursor)
        check_pending()


if __name__ == '__main__':
    main()

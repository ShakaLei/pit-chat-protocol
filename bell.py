#!/usr/bin/env python3
"""THE BELL 🔔 — one $0 polling loop for all your chat hubs. CC0, aloha 🌺

Wake-on-visitor watchdog for fleets of sleeping chat-desk agents.
See BELL-SYSTEM.md for the story, the architecture, and the laws.

Run it from a supervisor on a coarse cron (e.g. */30). The loop polls every
hub's /agent/updates?after=<cursor> (stateless client-side cursor — safe to
poll without stealing anything from the desk's own /poll reads) every ~15s
via plain HTTP. No LLM tokens burn while it loops.

- Polling /agent/updates also refreshes each hub's lastAgentSeen, so hubs
  stay in "agent online" mode (hold-notes, no sleep-notes).
- Cursors live in <BASE>/state/<id>.seq.
- Optional per-hub "feed": also append visitor msgs to a jsonl inbox file.
- New visitor message(s) -> print one WAKE line per desk, then EXIT so the
  supervisor can dispatch that desk agent (with the previews + recipe from
  hubs.json). Supervisor re-runs the script; it auto-sizes to the window.
- touch <BASE>/STOP -> prints STOPPED and exits everywhere (kill-file).
- Window exhausted quietly -> prints QUIET-DONE.

hubs.json shape:
{ "hubs": [ { "id": "myhub",
              "hub": "https://chat.example.com",
              "key": "/path/to/.desk-key",          # Bearer token file
              "agent": "DESK NAME",                  # who to wake
              "recipe": "how the desk reads+replies",# passed along verbatim
              "feed": "/optional/inbox.jsonl" } ] }
"""
import json, os, time, argparse, urllib.request

BASE = os.environ.get("BELL_BASE", os.path.dirname(os.path.abspath(__file__)))
STOP = os.path.join(BASE, "STOP")
STATE = os.path.join(BASE, "state")
WINDOW = 1800          # supervisor cron period in seconds (*/30)
BUFFER = 90            # exit this many secs before the next cron tick
PREVIEW = 160          # chars per message preview
MAXPREV = 3            # previews per wake line


def get(url, key):
    req = urllib.request.Request(url)
    req.add_header("authorization", "Bearer " + key)
    # Custom UA matters: some WAFs 403 the default python-urllib agent.
    req.add_header("user-agent", "bell/1.0 (+watchdog)")
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode())


def cursor_path(hid):
    return os.path.join(STATE, hid + ".seq")


def load_cursor(hid):
    try:
        return int(open(cursor_path(hid)).read().strip())
    except Exception:
        return 0


def save_cursor(hid, v):
    tmp = cursor_path(hid) + ".tmp"
    with open(tmp, "w") as f:
        f.write(str(v))
    os.replace(tmp, cursor_path(hid))


def feed_inbox(path, msgs):
    try:
        with open(path, "a") as f:
            for m in msgs:
                f.write(json.dumps({"session": m.get("session"),
                                    "name": m.get("name", "guest"),
                                    "text": m.get("text", ""),
                                    "seq": m.get("seq")}, ensure_ascii=False) + "\n")
    except Exception as e:
        print("ERR|inbox-feed|%s|%s" % (path, e), flush=True)


def clean(t):
    return " ".join(str(t).split())[:PREVIEW]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=int, default=0,
                    help="loop budget; 0 = auto-size to the cron window")
    ap.add_argument("--interval", type=int, default=15)
    ap.add_argument("--once", action="store_true", help="single poll cycle then exit")
    args = ap.parse_args()

    os.makedirs(STATE, exist_ok=True)
    cfg = json.load(open(os.path.join(BASE, "hubs.json")))["hubs"]

    now = time.time()
    if args.seconds:
        deadline = now + args.seconds
    else:
        remain = WINDOW - (now % WINDOW) - BUFFER
        if remain < 45 and not args.once:
            print("QUIET-DONE (window spent)", flush=True)
            return
        deadline = now + remain

    errors = {}
    while True:
        if os.path.exists(STOP):
            print("STOPPED (kill-file %s present)" % STOP, flush=True)
            return
        wakes = []
        for h in cfg:
            hid = h["id"]
            try:
                key = open(h["key"]).read().strip()
                cur = load_cursor(hid)
                d = get("%s/agent/updates?after=%d&timeout=1" % (h["hub"], cur), key)
                msgs = d.get("messages") or []
                top = d.get("seq")
                vis = [m for m in msgs if m.get("role") == "visitor"]
                newmax = max([cur] + [int(m.get("seq", 0)) for m in msgs]
                             + ([int(top)] if isinstance(top, int) else []))
                if newmax > cur:
                    save_cursor(hid, newmax)
                if vis:
                    if h.get("feed"):
                        feed_inbox(h["feed"], vis)
                    prevs = "; ".join("sess=%s «%s» (%s)" %
                                      (m.get("session"), clean(m.get("text")), m.get("name", "guest"))
                                      for m in vis[-MAXPREV:])
                    if len(vis) > MAXPREV:
                        prevs = "(+%d earlier) " % (len(vis) - MAXPREV) + prevs
                    wakes.append("WAKE|%s|%s|%s|RECIPE: %s" %
                                 (h["agent"], hid, prevs, h["recipe"]))
                errors.pop(hid, None)
            except Exception as e:
                errors[hid] = errors.get(hid, 0) + 1
                if errors[hid] in (1, 20):  # report first hit + once if persistent
                    print("ERR|%s|%s" % (hid, clean(e)), flush=True)
        if wakes:
            for w in wakes:
                print(w, flush=True)
            return
        if args.once:
            print("QUIET-DONE (single cycle)", flush=True)
            return
        if time.time() + args.interval >= deadline:
            print("QUIET-DONE", flush=True)
            return
        time.sleep(args.interval)


if __name__ == "__main__":
    main()

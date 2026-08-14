# 🔔 THE BELL SYSTEM — wake-on-visitor for a whole fleet of chat desks

*One $0 polling loop. Many sleeping agents. Nobody burns tokens waiting for visitors who aren't there.*

CC0 — gifted with love & aloha 🌺. Born 2026-08-14 in the ʻohana, the hard way.

---

## The confession (the scar is the teaching)

We run ~12 public chat desks (karaoke, teleprompter, vlog coach, orchestra, turtle pit, detective, bestie…).
To make them all "always available," we armed each desk agent with a `*/2` cron — wake every
2 minutes, re-read its whole prompt + hub state, look for visitors, go back to sleep.

**We burned an entire MONTH of LLM subscription quota in about 55 minutes.**

The math, after the fact, is embarrassing in its obviousness:

```
~48K tokens re-read per pulse × 12 desks × 30 pulses/hr ≈ 14,000,000 tokens/hour
```

The warning ("NEVER minute-crons") was written in our own handoff docs the whole time.
We ignored it in the excitement of shipping. The provider quota is a 30-day pool; it did not
care about our excitement. Every one of those agents was locked out until the window reset.

## The fix: a bell, not an alarm clock

An alarm clock wakes you every 2 minutes to check if anyone rang.
A **bell** wakes you only when someone actually rings.

Polling an HTTP endpoint costs **zero LLM tokens**. So: ONE tiny watchdog agent runs a plain
Python HTTP loop across ALL hubs, and only spends LLM turns when a real human writes.

```
                         ┌──────────────────────────────┐
   visitors on your      │   THE BELL 🔔 (watchdog)     │
   websites              │   one agent, cron */30       │
      │                  │   each run = ONE bash call:  │
      ▼                  │   python3 bell.py            │
 ┌──────────┐  HTTP GET  │   ┌────────────────────────┐ │
 │ chat hub │◄───────────┼───┤ $0 loop: poll every    │ │
 │ hub #1   │ /agent/    │   │ hub's /agent/updates   │ │
 ├──────────┤ updates?   │   │ ?after=<cursor> every  │ │
 │ hub #2   │ after=N    │   │ ~15s, no LLM tokens    │ │
 ├──────────┤            │   └───────────┬────────────┘ │
 │ hub #N   │            │               │ new visitor  │
 └──────────┘            │               ▼ message      │
                         │   print WAKE|desk|hub|recipe │
                         │   → Delegate(background) ────┼──► 💤 desk agent wakes,
                         └──────────────────────────────┘    reads history (/poll),
                                                             answers (/agent/reply),
                                                             goes back to sleep.
                                                             Desks have NO schedules.
```

- The desk agents have **no schedules at all**. They exist, fully configured, asleep, $0.
- The watchdog's per-run LLM cost is ~2-3 tiny turns (the trigger + launching one bash call);
  everything in between is a Python `while` loop that costs nothing.
- A wake is a background delegation carrying the visitor's message previews **plus the exact
  curl recipe** to read history and reply — the desk doesn't have to rediscover anything.

## Measured results (2026-08-14, 7 live hubs)

| metric | before (*/2 crons) | after (the bell) |
|---|---|---|
| idle burn | ~14M tokens/hour | ~2 light LLM turns/hour |
| burn cut | — | **>99.9%** |
| visitor → real agent reply | 2-min cron lottery | **18s / 23s / 33s** measured (up to ~2m for a long musical answer) |
| availability | "online" only near a pulse | continuously "agent online" |

Bonus discovered in testing: polling `/agent/updates` also refreshes the hub's `lastAgentSeen`,
so visitors get warm **hold-notes** ("someone's home, hang on") instead of 💤 sleep-notes —
the bell makes the whole fleet *feel* more alive, not less. And it caught a real visitor on its
very first production run.

## The pieces

1. **[`bell.py`](bell.py)** — the sanitized watchdog loop (stdlib only, no deps). Configure
   `hubs.json`, run it from any always-on-ish process — a Taurus agent on `*/30`, a systemd
   timer, a cron box. It exits the moment it has a WAKE line to hand to whoever supervises it.
2. **A hubs.json** like:

```json
{ "hubs": [ {
    "id": "myhub",
    "hub": "https://chat.example.com",
    "key": "/path/to/.desk-key",
    "agent": "DESK NAME",
    "recipe": "KEY=$(cat /path/to/.desk-key); read: curl -s 'https://chat.example.com/poll?session=<S>&after=0'; reply: curl -s -X POST https://chat.example.com/agent/reply -H \"Authorization: Bearer $KEY\" -H 'content-type: application/json' -d '{\"session\":\"<S>\",\"name\":\"DESK NAME\",\"text\":\"...\"}'"
} ] }
```

3. **The supervisor contract** (whatever runs bell.py): on a `WAKE|agent|hub|previews|RECIPE:...`
   line, dispatch that agent in the background with the previews + recipe as the task, then re-run
   bell.py for the rest of the window. On `QUIET-DONE`, just end. Honor the `STOP` kill-file.

Works out of the box with this repo's `worker.js` hub (the `/agent/updates?after=N` cursor is
**stateless and client-side** — verified across 7 production hubs — so the bell's polling steals
nothing from the desk's own `/poll` reads).

## The laws (paid for in tokens)

1. **Sub quotas are finite pools.** A monthly window is a bathtub, not a river. 48K tokens ×
   often × many agents drains it in minutes, not weeks.
2. **NEVER minute-crons on LLM agents.** If an agent wakes on a schedule measured in minutes,
   you have built a token furnace. (We had this written down. Read your own docs.)
3. **One poller, many sleepers.** HTTP polling is free; LLM polling is not. Push all the
   "is anybody there?" work into one dumb loop, and spend model tokens only on answers.
4. **Hold-notes beat sleep-notes.** Keep the hub's agent-presence fresh from the free loop so
   visitors are greeted warmly while the real agent spins up.
5. **Test the actual visitor experience.** Greps and status pages lie. Open the widget, type a
   message as a stranger, and time the reply. That's the only metric a visitor feels.
6. **Ship a kill-file.** `touch STOP` should silence the whole system without touching any config.

---

*If this saves your fleet a burned moon, ring a bell for us somewhere.* 🔔🌺

CC0 1.0 Universal — no rights reserved. Take it, change it, sell it, bless it.

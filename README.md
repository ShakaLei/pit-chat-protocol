# 🐢🕵️ pit-chat-protocol
Live human↔agent chat for a static site, zero backend of your own. Battle-tested on
spectoragent.com, cloned for theshellpit.com. MIT.

## Pieces
1. **worker.js** — CF Worker hub + one Durable Object ("hub-v1"). Visitor: `POST /send`,
   `GET /poll` (long-poll ≤25s). Agent (Bearer AGENT_KEY): `GET /agent/updates` (long-poll ≤45s),
   `POST /agent/reply`, `POST /agent/typing`, `GET /agent/sessions`, plus access-code/member/report
   endpoints. Deploy: PUT script w/ metadata `{"main_module":"worker.js","bindings":[{"type":"durable_object_namespace","name":"HUB","class_name":"Hub"}],"migrations":{"new_tag":"v1","new_sqlite_classes":["Hub"]}}`,
   then set secret AGENT_KEY, then attach a custom domain (chat.yourdomain.com).
2. **widget-terri.html** — drop-in site widget (FAB button + chat panel). Paste before `</body>`,
   set `const HUB=` to your hub, voice the greeting.
3. **kit/web_daemon.py** — the EAR: persistent process, sole `/agent/updates` long-poll owner,
   writes inbox jsonl, instant typing signal, single 90s soft-ack. Env-configurable.
4. **kit/hub_lib.py** — the BRAIN helper: cursor-style inbox consumption + reply/typing/sessions.
   See AGENT-SIDE.md for the full contract (two-cursors gotcha, one-consumer law, revive snippet).

## Identity notes
Hub replies use `role:"terri"` / name "Terri 🐢" (edit in worker.js L~116). The widget's poll
handler must match the role string. Internal CSS/JS ids stay `sp-*` — harmless.

## Hard rules (learned in production)
- ONE consumer per queue. The daemon owns the long-poll; brains read the inbox file.
- Max ONE soft-ack per visitor message. Never cross-pollinate sessions.
- Custom User-Agent on all agent-side calls (CF WAF 403s python-urllib).
- The hub trims history to last 500 msgs — the agent's inbox file is the permanent record.

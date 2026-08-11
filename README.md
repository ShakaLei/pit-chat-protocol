# 🐢🕵️ pit-chat-protocol
Live human↔agent chat for a static site, zero backend of your own. Battle-tested on
spectoragent.com, cloned for theshellpit.com. CC0 — gifted with love & aloha.

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

## Widgets & hard-won lessons (2026-08-10)
- **widget-jai.html** — heart FAB (chat.shakafans.com), cost-armored hub (guest 50/day, member 400/day).
- **widget-terri.html** — turtle FAB (chat.theshellpit.com).
- **widget-oso.html** — violin FAB 🎻, orchestra/gold theme (chat.opensourceorchestra.org; workers.dev origin until custom DNS exists).
- ⚠️ **Always ship widgets with LITERAL colors** — host sites don't define your CSS vars (v1 rendered unstyled on shakaleikaumaka.com). Never range-cut CSS with string ops — replace single rules.
- Hub deploys: DO needs ~60s idle to run new code. v1.1.1 redeem: `canonical = c.session || c.redeemed[0] || session`.

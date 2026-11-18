# ʻohana chat doors

One folder per live chat-door worker (13 doors besides the twin `shaka-chat`).
Each `worker.js` is the live 15 Nov 2026 script (HARDEN 2026-11-08 + stale-cursor law),
downloaded from Cloudflare on 18 Nov 2026, plus one change: the agent gate accepts
`Bearer AGENT_KEY`, `REPLY_TOKEN` or `GROKA_KEY` (same law as the twin, fd875f0).

- Secrets live only in Cloudflare (`wrangler secret put`). Never commit them. Never rotate AGENT_KEY.
- No Durable Object migrations: every door keeps its `Hub` (`idFromName("hub-v1")`) history.
- Deploy: `wrangler deploy -c doors/<door>/wrangler.toml --keep-vars --durable-objects-code-update-mode immediate`
- Test: `node --test test/doors-groka-key.test.mjs`

Code is GPL-3.0 (see LICENSE). Words and art are CC BY-SA 4.0 (see LICENSE-CONTENT).

# Grok-bell pilot — Open Source Orchestra front door

Local branch `grok-bell-pilot`. **Not deployed. Not pushed.**

The full plan (flow diagram, secrets, deploy steps waiting on Shaka's go,
risks, and usage cost) lives at:

`/workspace/grokants/oso-grok-bell-pilot.md`

This repo's pieces on the branch:

| Path | Role |
|---|---|
| `worker-oso.js` | OSO-branded hub + Grok webhook + fallback note + `REPLY_TOKEN` |
| `oso-grok-pilot-lib.js` | Pure helpers (auth, debounce, payload) |
| `wrangler-oso.toml` | Deploy *config only* — no migrations, do not apply until blessed |
| `widget-oso.html` | Reference widget now sends optional `page` on `/send` |
| `persona/oso-grok-system-prompt.md` | Grok agent instructions |
| `recipes/oso-grok-reply.example.sh` | Reply recipe (no secrets) |
| `test/oso-grok-pilot.test.mjs` | Unit tests for the helpers |

The live site widget still lives in `shakaleikaumaka/oso-storytelling/index.html`
and already talks to `https://chat.opensourceorchestra.org`. The `page` field
is optional; the live widget does not need to change for the pilot to ring.

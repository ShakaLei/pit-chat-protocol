#!/bin/sh
# Example recipe the Open Source Orchestra Grok agent uses after a webhook wake.
# Tokens come from the environment (set later via a secure form). Never put secrets in this file.
# Usage: SESSION=<id> TEXT=<reply> ./recipes/oso-grok-reply.example.sh

set -eu
HUB="${HUB:-https://chat.opensourceorchestra.org}"
: "${REPLY_TOKEN:?REPLY_TOKEN must be set in the environment}"
: "${SESSION:?SESSION is the conversation id from the webhook}"
: "${TEXT:?TEXT is the reply to post}"

# Custom UA — some edges 403 the default curl/python agents.
UA="oso-grok-bell/1.0"

# Optional: show the visitor a typing indicator, then read history, then reply.
curl -sS -X POST "$HUB/agent/typing" \
  -H "Authorization: Bearer $REPLY_TOKEN" \
  -H "content-type: application/json" \
  -H "user-agent: $UA" \
  -d "{\"session\":\"$SESSION\"}" >/dev/null || true

# /poll is the visitor-shaped history for this session only (no agent key required).
SESSION_Q=$(python3 -c 'import os,urllib.parse; print(urllib.parse.quote(os.environ["SESSION"], safe=""))')
curl -sS "$HUB/poll?session=$SESSION_Q&after=0" \
  -H "user-agent: $UA"

curl -sS -X POST "$HUB/agent/reply" \
  -H "Authorization: Bearer $REPLY_TOKEN" \
  -H "content-type: application/json" \
  -H "user-agent: $UA" \
  -d "$(python3 -c 'import json,os; print(json.dumps({"session":os.environ["SESSION"],"name":"OSO 🎻","text":os.environ["TEXT"]}))')"

import { strict as assert } from "node:assert";
import {
  FALLBACK_TEXT,
  CAP_TEXT,
  DEBOUNCE_MS,
  MAX_WAKES_PER_DAY,
  agentAuthorized,
  isWakeWorthyVisitorMessage,
  shouldDebounce,
  shouldAllowWake,
  utcDay,
  grokWebhookPayload,
  webhookHeaders,
  sessionCursor,
} from "../oso-grok-pilot-lib.js";

const env = { AGENT_KEY: "agent-test", REPLY_TOKEN: "reply-test" };

assert.equal(agentAuthorized("Bearer agent-test", env), true);
assert.equal(agentAuthorized("Bearer reply-test", env), true);
assert.equal(agentAuthorized("Bearer no", env), false);
assert.equal(agentAuthorized("", env), false);
assert.equal(agentAuthorized("Bearer agent-test", {}), false);

assert.equal(isWakeWorthyVisitorMessage({ role: "visitor", text: "aloha" }), true);
assert.equal(isWakeWorthyVisitorMessage({ role: "visitor", text: "   " }), false);
assert.equal(isWakeWorthyVisitorMessage({ role: "system", text: "ping" }), false);
assert.equal(isWakeWorthyVisitorMessage({ role: "oso", text: "hello" }), false);

assert.equal(shouldDebounce(1000, 1000 + DEBOUNCE_MS - 1), true);
assert.equal(shouldDebounce(1000, 1000 + DEBOUNCE_MS), false);
assert.equal(shouldDebounce(0, 50_000), false);

assert.equal(shouldAllowWake(0), true);
assert.equal(shouldAllowWake(MAX_WAKES_PER_DAY - 1), true);
assert.equal(shouldAllowWake(MAX_WAKES_PER_DAY), false);

assert.equal(utcDay(Date.parse("2026-11-17T16:48:00Z")), "2026-11-17");

const payload = grokWebhookPayload(
  { session: "abc", text: "hello hall", name: "guest", ts: 123, seq: 9, member: null },
  "https://opensourceorchestra.org/"
);
assert.equal(payload.conversation_id, "abc");
assert.equal(payload.session, "abc");
assert.equal(payload.message, "hello hall");
assert.equal(payload.page, "https://opensourceorchestra.org/");
assert.equal(payload.timestamp, 123);
assert.equal(payload.hub, "oso-chat");
assert.equal(payload.source, "opensourceorchestra.org");

const headers = webhookHeaders("secret-test");
assert.equal(headers["GROK_WEBHOOK_KEY"], "secret-test");
assert.equal(headers["Authorization"], "Bearer secret-test");
assert.equal(headers["content-type"], "application/json");
assert.ok(!("GROK_WEBHOOK_KEY" in webhookHeaders("")));

assert.equal(sessionCursor([], "s"), 0);
assert.equal(
  sessionCursor(
    [
      { session: "s", seq: 2 },
      { session: "other", seq: 99 },
      { session: "s", seq: 5 },
    ],
    "s"
  ),
  5
);

assert.ok(FALLBACK_TEXT.includes("the Orchestra will reply soon"));
assert.ok(CAP_TEXT.includes("tomorrow"));

console.log("ok — oso-grok-pilot tests passed");

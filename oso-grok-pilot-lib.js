// Pure helpers for the Open Source Orchestra Grok-bell pilot.
// No secrets. Safe to import from the Worker and from local tests.

export const FALLBACK_TEXT =
  "🎻 the Orchestra will reply soon — the line is open, hang tight.";
export const CAP_TEXT =
  "🎻 the hall is at rest for today — please come back tomorrow, or leave a note at opensourceorchestra.org.";
export const DEBOUNCE_MS = 20_000;
export const FALLBACK_MS = 90_000;
export const FALLBACK_MS_ON_ERROR = 15_000;
export const MAX_WAKES_PER_DAY = 200;

export function agentAuthorized(authHeader, env) {
  const auth = authHeader || "";
  // AGENT_KEY is the live secret (do not rotate). REPLY_TOKEN and GROKA_KEY are
  // optional extra accepted bearers so Groka/Pono can use a separate key
  // (HUB_KEY_TWIN) without learning or replacing AGENT_KEY.
  const keys = [
    env && env.AGENT_KEY,
    env && env.REPLY_TOKEN,
    env && env.GROKA_KEY,
  ].filter(Boolean);
  return keys.some((k) => auth === `Bearer ${k}`);
}

export function isWakeWorthyVisitorMessage(msg) {
  if (!msg || msg.role !== "visitor") return false;
  return String(msg.text || "").trim().length > 0;
}

export function shouldDebounce(lastWakeTs, now, windowMs = DEBOUNCE_MS) {
  return Boolean(lastWakeTs) && now - lastWakeTs < windowMs;
}

export function shouldAllowWake(dayCount, cap = MAX_WAKES_PER_DAY) {
  return (Number(dayCount) || 0) < cap;
}

export function utcDay(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

export function grokWebhookPayload(msg, page) {
  return {
    conversation_id: msg.session,
    session: msg.session,
    message: msg.text,
    name: msg.name || "guest",
    page: page || msg.page || "",
    timestamp: msg.ts,
    seq: msg.seq,
    member: msg.member || null,
    hub: "oso-chat",
    source: "opensourceorchestra.org",
  };
}

export function webhookHeaders(key) {
  const headers = {
    "content-type": "application/json",
    "user-agent": "oso-grok-bell/1.0",
  };
  if (key) {
    headers["GROK_WEBHOOK_KEY"] = key;
    headers["Authorization"] = `Bearer ${key}`;
  }
  return headers;
}

export function sessionCursor(messages, session) {
  let cursor = 0;
  for (const m of messages || []) {
    if (m.session === session && m.seq > cursor) cursor = m.seq;
  }
  return cursor;
}

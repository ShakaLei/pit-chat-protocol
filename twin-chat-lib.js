// Pure helpers for the Shaka twin chat hub (twin-chat-fix).
// No secrets. Safe to import from the Worker and from local tests.

export const FOOTER_TEXT = "🧠 thinking with Grok · built with Cursor";

export const WAIT_NOTE =
  "💤 the twin will reply soon — leave your word, or write aloha@shakaleikaumaka.com 🤙";

export const AGENT_STALE_MS = 300000; // 5 minutes
export const WAIT_NOTE_EVERY_MS = 300000;
export const THREAD_HISTORY_CAP = 40;

// Historical bubbles that must never be fed back as "what the twin said".
const COMPOSING_RE =
  /^\s*(\.{2,}|…+|composing\.?|\[composing\]|typing[.…]*)\s*$/i;
const COMPOSING_PHRASE_RE =
  /heard you — Shaka is composing|composing his answer with aloha, one sweet moment|shaka is composing/i;
const SLEEP_NOTE_RE =
  /💤|\bwill reply soon\b|leave your word|is resting right now|all the way to Tokyo|asleep in tokyo|sleeping in tokyo|tokyo.{0,60}sleep/i;

const AGENT_ROLES = new Set(["jai", "shaka", "twin", "spector", "oso", "agent"]);

export function isAgentRole(role) {
  return AGENT_ROLES.has(String(role || "").toLowerCase());
}

export function isJunkHistoryMessage(m) {
  if (!m) return true;
  if (m.sleepNote || m.placeholder || m.composing || m.holdNote || m.fallbackNote) {
    return true;
  }
  const text = String(m.text || "").trim();
  if (COMPOSING_RE.test(text) || COMPOSING_PHRASE_RE.test(text)) return true;
  const role = String(m.role || "").toLowerCase();
  if (role !== "visitor" && SLEEP_NOTE_RE.test(text)) return true;
  return false;
}

export function stripJunkHistory(msgs) {
  return (msgs || []).filter((m) => !isJunkHistoryMessage(m));
}

export function threadHistory(msgs, session, cap = THREAD_HISTORY_CAP) {
  const cleaned = stripJunkHistory(msgs).filter((m) => m.session === session);
  return cleaned.length > cap ? cleaned.slice(-cap) : cleaned;
}

export function lastVisitorMessage(msgs, session) {
  const list = (msgs || []).filter(
    (m) => m.session === session && m.role === "visitor" && !isJunkHistoryMessage(m)
  );
  return list.length ? list[list.length - 1] : null;
}

export function replyAlreadyPosted(msgs, session) {
  const last = lastVisitorMessage(msgs, session);
  if (!last) return { yes: false, existing: null };
  const existing = (msgs || []).find(
    (m) =>
      m.session === session &&
      isAgentRole(m.role) &&
      !isJunkHistoryMessage(m) &&
      m.seq > last.seq
  );
  return { yes: Boolean(existing), existing: existing || null };
}

export function canPostReply(msgs, session) {
  const last = lastVisitorMessage(msgs, session);
  if (!last) return { ok: false, reason: "no visitor message to answer" };
  const posted = replyAlreadyPosted(msgs, session);
  if (posted.yes) {
    return {
      ok: false,
      reason: "already replied",
      existingSeq: posted.existing && posted.existing.seq,
    };
  }
  return { ok: true, inReplyTo: last.seq };
}

// 🔁 STALE-CURSOR LAW 2026-11-15 (Shaka: "you have to hit refresh to see the response"):
// a cursor AHEAD of this hub's own seq can only come from another hub (a door swapped hubs
// under the same localStorage keys) or a reset DO. Honouring it hides every new reply until
// seq catches up. Resume from this session's newest message and tell the widget {stale,cursor}.
export function applyStaleCursorLaw(after, hubSeq, sessionMax) {
  let stale = false;
  let resume = after;
  if (!(resume >= 0) || resume > hubSeq) {
    stale = true;
    resume = sessionMax;
  }
  return { after: resume, stale };
}

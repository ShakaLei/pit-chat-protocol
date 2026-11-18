// 🤙 SHAKA TWIN CHAT HUB — grok-bell / twin-chat-fix (local, not deployed)
// Live hosts: https://chat.shakaleikaumaka.com  and  https://shaka-chat.shakaverse.workers.dev
// Visitor: POST /send, GET /poll. Agent: Bearer AGENT_KEY, REPLY_TOKEN, or GROKA_KEY
//   GET /agent/updates, GET /agent/history, POST /agent/reply, POST /agent/typing.
// twin-chat-fix:
//   - /send sets a transient typing flag; it does NOT store a "composing" SHAKA bubble
//   - wait notes are ephemeral (poll.waitNote), never stored in history
//   - load/persist strip placeholder, composing, and sleep-note bubbles from storage
//   - /agent/history returns cleaned thread history for the session
//   - /agent/reply is one reply per visitor message (409 if already answered)
//   - /agent/reply is stamped role "jai" + name "SHAKA 🤙" so the live widget renders it
//   - sleep/wait copy is timeless (no Tokyo, no future-tense Devcon 8)
//   - /poll applies the 15 Nov stale-cursor law (resume + {stale,cursor}; responses no-store)
// Keep class Hub + idFromName("hub-v1"). Do not add a new Durable Object migration.

import { agentAuthorized, sessionCursor } from "./oso-grok-pilot-lib.js";
import {
  WAIT_NOTE,
  AGENT_STALE_MS,
  WAIT_NOTE_EVERY_MS,
  isJunkHistoryMessage,
  stripJunkHistory,
  threadHistory,
  canPostReply,
  applyStaleCursorLaw,
} from "./twin-chat-lib.js";

export { WAIT_NOTE } from "./twin-chat-lib.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "content-type,authorization",
};
const J = (o, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS },
  });

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return J({
        ok: true,
        service: "shaka-chat-hub",
        pilot: "twin-chat-fix",
      });
    }
    if (url.pathname.startsWith("/agent/") || url.pathname.startsWith("/watch/")) {
      const auth = req.headers.get("authorization") || "";
      if (!agentAuthorized(auth, env)) return J({ error: "unauthorized" }, 401);
    }
    const id = env.HUB.idFromName("hub-v1");
    return env.HUB.get(id).fetch(req);
  },
};

export class Hub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.visWaiters = new Map();
    this.agentWaiters = [];
    this.typing = new Map();
    this.waitNotes = new Map(); // session -> { text, ts } — ephemeral, not stored
    this.loaded = null;
  }

  async load() {
    if (this.loaded) return;
    this.seq = (await this.state.storage.get("seq")) || 0;
    const raw = (await this.state.storage.get("msgs")) || [];
    this.msgs = stripJunkHistory(raw);
    this.codes = (await this.state.storage.get("codes")) || {};
    this.members = (await this.state.storage.get("members")) || {};
    this.lastAgentSeen = (await this.state.storage.get("lastAgentSeen")) || 0;
    this.loaded = true;
    if (this.msgs.length !== raw.length) await this.persist();
  }

  async persist() {
    this.msgs = stripJunkHistory(this.msgs);
    if (this.msgs.length > 600) this.msgs = this.msgs.slice(-500);
    await this.state.storage.put({
      seq: this.seq,
      msgs: this.msgs,
      codes: this.codes,
      members: this.members,
      lastAgentSeen: this.lastAgentSeen,
    });
  }

  touchAgent() {
    this.lastAgentSeen = Date.now();
  }

  wakeVisitor(session) {
    (this.visWaiters.get(session) || []).splice(0).forEach((r) => r());
  }
  wakeAgent() {
    this.agentWaiters.splice(0).forEach((r) => r());
  }
  wait(arr, ms) {
    return new Promise((resolve) => {
      arr.push(resolve);
      setTimeout(resolve, ms);
    });
  }
  sessionMsgs(session, after) {
    return this.msgs.filter((m) => m.session === session && m.seq > after && !isJunkHistoryMessage(m));
  }

  currentWaitNote(session) {
    const stale = Date.now() - (this.lastAgentSeen || 0) > AGENT_STALE_MS;
    if (!stale) return "";
    const wn = this.waitNotes.get(session);
    if (wn && Date.now() - wn.ts < WAIT_NOTE_EVERY_MS) return wn.text || WAIT_NOTE;
    return "";
  }

  maybeArmWaitNote(session) {
    const stale = Date.now() - (this.lastAgentSeen || 0) > AGENT_STALE_MS;
    if (!stale) return;
    const wn = this.waitNotes.get(session);
    if (wn && Date.now() - wn.ts < WAIT_NOTE_EVERY_MS) return;
    this.waitNotes.set(session, { text: WAIT_NOTE, ts: Date.now() });
  }

  async fetch(req) {
    await this.load();
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (p === "/send" && req.method === "POST") {
        const b = await req.json();
        const session = String(b.session || "").slice(0, 64);
        const text = String(b.text || "").slice(0, 2000).trim();
        const name = String(b.name || "guest").slice(0, 60);
        const page = String(b.page || b.url || "").slice(0, 300);
        if (!session || !text) return J({ error: "session and text required" }, 400);
        const recent = this.msgs.filter(
          (m) => m.session === session && m.role === "visitor" && Date.now() - m.ts < 60000
        );
        if (recent.length >= 15) return J({ error: "slow down a little 🌺" }, 429);
        const mem = this.members[session];
        const m = {
          seq: ++this.seq,
          session,
          role: "visitor",
          name: mem ? mem.name : name,
          member: mem ? mem.name : null,
          text,
          ts: Date.now(),
          page: page || undefined,
        };
        this.msgs.push(m);
        // Transient typing only — never persist a "composing" SHAKA / jai bubble.
        this.typing.set(session, Date.now());
        this.maybeArmWaitNote(session);
        await this.persist();
        this.wakeAgent();
        this.wakeVisitor(session);
        return J({ ok: true, seq: m.seq });
      }

      if (p === "/poll" && req.method === "GET") {
        const session = String(url.searchParams.get("session") || "").slice(0, 64);
        let after = Number(url.searchParams.get("after") || 0);
        const wait = Math.min(Number(url.searchParams.get("wait") || 0), 25);
        if (!session) return J({ error: "session required" }, 400);
        // 🔁 STALE-CURSOR LAW 2026-11-15 — same law as worker.js / the live 15 Nov deploy.
        // A cursor ahead of this hub's seq (swapped hub or reset DO) would hide every new
        // reply; resume from this session's newest message and flag {stale,cursor}.
        const cursorAdj = applyStaleCursorLaw(after, this.seq, sessionCursor(this.msgs, session));
        after = cursorAdj.after;
        const stale = cursorAdj.stale;
        let out = this.sessionMsgs(session, after);
        if (!out.length && wait > 0) {
          if (!this.visWaiters.has(session)) this.visWaiters.set(session, []);
          await this.wait(this.visWaiters.get(session), wait * 1000);
          out = this.sessionMsgs(session, after);
        }
        const typingTs = this.typing.get(session) || 0;
        const mem = this.members[session];
        return J({
          messages: out,
          typing: Date.now() - typingTs < 6000,
          waitNote: this.currentWaitNote(session),
          history: threadHistory(this.msgs, session),
          member: mem ? mem.name : null,
          now: Date.now(),
          cursor: sessionCursor(this.msgs, session),
          ...(stale ? { stale: true } : {}),
        });
      }

      if (p === "/watch/updates" && req.method === "GET") {
        const after = Number(url.searchParams.get("after") || 0);
        const wait = Math.min(Number(url.searchParams.get("wait") || 0), 45);
        const pick = () => this.msgs.filter((m) => (m.role === "visitor" || m.role === "system") && m.seq > after && !isJunkHistoryMessage(m));
        let out = pick();
        if (!out.length && wait > 0) {
          await this.wait(this.agentWaiters, wait * 1000);
          out = pick();
        }
        return J({ messages: out, seq: this.seq, now: Date.now() });
      }

      if (p === "/agent/updates" && req.method === "GET") {
        this.touchAgent();
        if (!this._lastSeenWrite || Date.now() - this._lastSeenWrite > 120000) {
          this._lastSeenWrite = Date.now();
          await this.state.storage.put("lastAgentSeen", this.lastAgentSeen);
        }
        const after = Number(url.searchParams.get("after") || 0);
        const wait = Math.min(Number(url.searchParams.get("wait") || 0), 45);
        const pick = () => this.msgs.filter((m) => (m.role === "visitor" || m.role === "system") && m.seq > after && !isJunkHistoryMessage(m));
        let out = pick();
        if (!out.length && wait > 0) {
          await this.wait(this.agentWaiters, wait * 1000);
          out = pick();
        }
        const sessions = [...new Set(out.map((m) => m.session).filter(Boolean))];
        const historyBySession = {};
        for (const s of sessions) historyBySession[s] = threadHistory(this.msgs, s);
        return J({ messages: out, historyBySession, seq: this.seq, now: Date.now() });
      }

      if (p === "/agent/history" && req.method === "GET") {
        this.touchAgent();
        const session = String(url.searchParams.get("session") || "").slice(0, 64);
        if (!session) return J({ error: "session required" }, 400);
        return J({
          session,
          messages: threadHistory(this.msgs, session),
          cursor: sessionCursor(this.msgs, session),
          now: Date.now(),
        });
      }

      if (p === "/agent/reply" && req.method === "POST") {
        this.touchAgent();
        const b = await req.json();
        const session = String(b.session || "").slice(0, 64);
        const text = String(b.text || "").slice(0, 4000).trim();
        if (!session || !text) return J({ error: "session and text required" }, 400);
        if (isJunkHistoryMessage({ role: "jai", text })) {
          return J({ error: "refusing placeholder, composing, or sleep-note reply" }, 400);
        }
        const gate = canPostReply(this.msgs, session);
        if (!gate.ok) {
          return J(
            { error: gate.reason, seq: gate.existingSeq || null },
            gate.reason === "already replied" ? 409 : 400
          );
        }
        // Live widget on shakaleikaumaka.com renders role==="jai" as the SHAKA bubble.
        const m = {
          seq: ++this.seq,
          session,
          role: "jai",
          name: String(b.name || "SHAKA 🤙").slice(0, 60),
          text,
          ts: Date.now(),
          inReplyTo: gate.inReplyTo,
        };
        this.msgs.push(m);
        this.typing.delete(session);
        this.waitNotes.delete(session);
        await this.persist();
        this.wakeVisitor(session);
        return J({ ok: true, seq: m.seq, inReplyTo: gate.inReplyTo });
      }

      if (p === "/agent/typing" && req.method === "POST") {
        this.touchAgent();
        const b = await req.json();
        const session = String(b.session || "").slice(0, 64);
        if (!session) return J({ error: "session required" }, 400);
        this.typing.set(session, Date.now());
        this.wakeVisitor(session);
        return J({ ok: true });
      }

      if (p === "/redeem" && req.method === "POST") {
        const b = await req.json();
        const session = String(b.session || "").slice(0, 64);
        const code = String(b.code || "").trim().toUpperCase().slice(0, 40);
        if (!session || !code) return J({ error: "session and code required" }, 400);
        const c = this.codes[code];
        if (!c) return J({ ok: false, error: "code not recognized — check with whoever gave it to you 🌺" }, 404);
        const canonical = c.session || (c.redeemed && c.redeemed[0]) || session;
        if (!c.session) c.session = session;
        this.members[canonical] = { code, name: c.name, since: Date.now() };
        if (!c.redeemed.includes(session)) c.redeemed.push(session);
        const resumed = canonical !== session;
        this.msgs.push({
          seq: ++this.seq,
          session: canonical,
          role: "system",
          name: "hub",
          member: c.name,
          text: resumed
            ? `🔑 ${c.name} resumed their desk from a new device — history restored.`
            : `🔑 access code redeemed — welcome, ${c.name}! Unlimited desk unlocked.`,
          ts: Date.now(),
        });
        await this.persist();
        this.wakeAgent();
        this.wakeVisitor(canonical);
        this.wakeVisitor(session);
        return J({ ok: true, member: c.name, history_session: canonical, resumed });
      }

      if (p === "/agent/sessions" && req.method === "GET") {
        const map = {};
        for (const m of this.msgs) {
          if (isJunkHistoryMessage(m)) continue;
          map[m.session] = map[m.session] || { session: m.session, count: 0, last: 0, name: "guest" };
          map[m.session].count++;
          map[m.session].last = m.ts;
          if (m.role === "visitor") map[m.session].name = m.name;
        }
        return J({ sessions: Object.values(map).sort((a, b) => b.last - a.last) });
      }

      return J({ error: "not found" }, 404);
    } catch (e) {
      return J({ error: "hub error" }, 500);
    }
  }
}

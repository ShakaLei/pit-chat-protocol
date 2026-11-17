// 🤙 SHAKA TWIN CHAT HUB — grok-bell / twin-chat-fix (local, not deployed)
// Live hosts: https://chat.shakaleikaumaka.com  and  https://shaka-chat.shakaverse.workers.dev
// Visitor: POST /send, GET /poll. Agent: Bearer AGENT_KEY or REPLY_TOKEN
//   GET /agent/updates, POST /agent/reply, POST /agent/typing.
// twin-chat-fix:
//   - /send sets a transient typing flag; it does NOT store a "composing" SHAKA bubble
//   - if no agent has been seen recently, a SYSTEM wait-note is posted (not role jai)
//   - /agent/reply is stamped role "jai" + name "SHAKA 🤙" so the live widget renders it
//   - sleep/wait copy is timeless (no Tokyo, no future-tense Devcon 8)
// Keep class Hub + idFromName("hub-v1"). Do not add a new Durable Object migration.

import { agentAuthorized, sessionCursor } from "./oso-grok-pilot-lib.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "content-type,authorization",
};
const J = (o, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { "content-type": "application/json", ...CORS },
  });

export const WAIT_NOTE =
  "💤 the twin will reply soon — leave your word, or write aloha@shakaleikaumaka.com 🤙";
const AGENT_STALE_MS = 300000; // 5 minutes
const WAIT_NOTE_EVERY_MS = 300000;

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
    this.loaded = null;
  }

  async load() {
    if (this.loaded) return;
    this.seq = (await this.state.storage.get("seq")) || 0;
    this.msgs = (await this.state.storage.get("msgs")) || [];
    this.codes = (await this.state.storage.get("codes")) || {};
    this.members = (await this.state.storage.get("members")) || {};
    this.lastAgentSeen = (await this.state.storage.get("lastAgentSeen")) || 0;
    this.loaded = true;
  }

  async persist() {
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
    return this.msgs.filter((m) => m.session === session && m.seq > after);
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
        const stale = Date.now() - (this.lastAgentSeen || 0) > AGENT_STALE_MS;
        if (stale) {
          const already = this.msgs.some(
            (x) => x.session === session && x.sleepNote && Date.now() - x.ts < WAIT_NOTE_EVERY_MS
          );
          if (!already) {
            this.msgs.push({
              seq: ++this.seq,
              session,
              role: "system",
              name: "hub",
              text: WAIT_NOTE,
              sleepNote: true,
              ts: Date.now(),
            });
          }
        }
        await this.persist();
        this.wakeAgent();
        this.wakeVisitor(session);
        return J({ ok: true, seq: m.seq });
      }

      if (p === "/poll" && req.method === "GET") {
        const session = String(url.searchParams.get("session") || "").slice(0, 64);
        const after = Number(url.searchParams.get("after") || 0);
        const wait = Math.min(Number(url.searchParams.get("wait") || 0), 25);
        if (!session) return J({ error: "session required" }, 400);
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
          member: mem ? mem.name : null,
          now: Date.now(),
          cursor: sessionCursor(this.msgs, session),
        });
      }

      if (p === "/watch/updates" && req.method === "GET") {
        const after = Number(url.searchParams.get("after") || 0);
        const wait = Math.min(Number(url.searchParams.get("wait") || 0), 45);
        const pick = () => this.msgs.filter((m) => (m.role === "visitor" || m.role === "system") && m.seq > after);
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
        const pick = () => this.msgs.filter((m) => (m.role === "visitor" || m.role === "system") && m.seq > after);
        let out = pick();
        if (!out.length && wait > 0) {
          await this.wait(this.agentWaiters, wait * 1000);
          out = pick();
        }
        return J({ messages: out, seq: this.seq, now: Date.now() });
      }

      if (p === "/agent/reply" && req.method === "POST") {
        this.touchAgent();
        const b = await req.json();
        const session = String(b.session || "").slice(0, 64);
        const text = String(b.text || "").slice(0, 4000).trim();
        if (!session || !text) return J({ error: "session and text required" }, 400);
        // Live widget on shakaleikaumaka.com renders role==="jai" as the SHAKA bubble.
        const m = {
          seq: ++this.seq,
          session,
          role: "jai",
          name: String(b.name || "SHAKA 🤙").slice(0, 60),
          text,
          ts: Date.now(),
        };
        this.msgs.push(m);
        this.typing.delete(session);
        await this.persist();
        this.wakeVisitor(session);
        return J({ ok: true, seq: m.seq });
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

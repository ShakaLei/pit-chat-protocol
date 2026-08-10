// 🐢 TERRI CHAT HUB — Telegram-equivalent message queue for theshellpit.com
// Visitor side: POST /send, GET /poll (long-poll). Agent side (Bearer AGENT_KEY):
// GET /agent/updates (long-poll, all sessions), POST /agent/reply, POST /agent/typing.
// One singleton Durable Object ("hub") holds all sessions — tiny volume, strong consistency.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "content-type,authorization",
};
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", ...CORS } });

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    if (url.pathname === "/health") return J({ ok: true, service: "shellpit-chat-hub" });
    // agent auth for /agent/*
    if (url.pathname.startsWith("/agent/")) {
      const auth = req.headers.get("authorization") || "";
      if (auth !== `Bearer ${env.AGENT_KEY}`) return J({ error: "unauthorized" }, 401);
    }
    const id = env.HUB.idFromName("hub-v1");
    return env.HUB.get(id).fetch(req);
  },
};

export class Hub {
  constructor(state) {
    this.state = state;
    this.visWaiters = new Map(); // session -> [resolve]
    this.agentWaiters = []; // [resolve]
    this.typing = new Map(); // session -> ts (transient)
    this.loaded = null;
  }
  async load() {
    if (!this.loaded) {
      this.seq = (await this.state.storage.get("seq")) || 0;
      this.msgs = (await this.state.storage.get("msgs")) || []; // [{seq,session,role,name,text,ts}]
      this.codes = (await this.state.storage.get("codes")) || {}; // code -> {name, note, created, redeemed:[session,...]}
      this.members = (await this.state.storage.get("members")) || {}; // session -> {code, name, since}
      this.loaded = true;
    }
  }
  async persist() {
    if (this.msgs.length > 600) this.msgs = this.msgs.slice(-500);
    await this.state.storage.put({ seq: this.seq, msgs: this.msgs, codes: this.codes, members: this.members });
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
        if (!session || !text) return J({ error: "session and text required" }, 400);
        const recent = this.msgs.filter((m) => m.session === session && m.role === "visitor" && Date.now() - m.ts < 60000);
        if (recent.length >= 15) return J({ error: "slow down a little 🌺" }, 429);
        const mem = this.members[session];
        const m = { seq: ++this.seq, session, role: "visitor", name: mem ? mem.name : name, member: mem ? mem.name : null, text, ts: Date.now() };
        this.msgs.push(m);
        await this.persist();
        this.wakeAgent();
        this.wakeVisitor(session); // echo back so all visitor tabs sync
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
        return J({ messages: out, typing: Date.now() - typingTs < 6000, member: mem ? mem.name : null, now: Date.now() });
      }
      if (p === "/agent/updates" && req.method === "GET") {
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
        const b = await req.json();
        const session = String(b.session || "").slice(0, 64);
        const text = String(b.text || "").slice(0, 4000).trim();
        if (!session || !text) return J({ error: "session and text required" }, 400);
        const m = { seq: ++this.seq, session, role: "terri", name: "Terri 🐢", text, ts: Date.now() };
        this.msgs.push(m);
        this.typing.delete(session);
        await this.persist();
        this.wakeVisitor(session);
        return J({ ok: true, seq: m.seq });
      }
      if (p === "/agent/typing" && req.method === "POST") {
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
        // v1.1 PORTABLE HISTORY: each code owns ONE canonical session (the first device that
        // redeemed it). Every later device adopts that session -> history follows the code.
        const canonical = c.session || (c.redeemed && c.redeemed[0]) || session; // v1.1.1: pre-v1.1 codes adopt their first-ever session's history (Spector's one-liner)
        if (!c.session) c.session = session;
        this.members[canonical] = { code, name: c.name, since: Date.now() };
        if (!c.redeemed.includes(session)) c.redeemed.push(session);
        const resumed = canonical !== session;
        const m = { seq: ++this.seq, session: canonical, role: "system", name: "hub", member: c.name, text: resumed ? `🔑 ${c.name} resumed their desk from a new device — history restored.` : `🔑 access code redeemed — welcome, ${c.name}! Unlimited desk unlocked.`, ts: Date.now() };
        this.msgs.push(m);
        await this.persist();
        this.wakeAgent();
        this.wakeVisitor(canonical);
        this.wakeVisitor(session);
        return J({ ok: true, member: c.name, history_session: canonical, resumed });
      }
      if (p === "/account/profile" && req.method === "POST") {
        const b = await req.json();
        const code = String(b.code || "").trim().toUpperCase().slice(0, 40);
        if (!code) return J({ error: "code required" }, 400);
        const c = this.codes[code];
        if (!c) { await new Promise((r) => setTimeout(r, 900)); return J({ ok: false, error: "code not recognized — check with whoever gave it to you 🌺" }, 404); }
        const reports = (c.reports || []).slice().sort((a, b2) => String(b2.date || "").localeCompare(String(a.date || "")));
        return J({ ok: true, member: { name: c.name, since: c.created, note: c.note || "", plan: "Founding member 🔑", reports } });
      }
      if (p === "/agent/reports" && req.method === "POST") {
        const b = await req.json();
        const code = String(b.code || "").trim().toUpperCase().slice(0, 40);
        if (b.action === "add") {
          const c = this.codes[code];
          if (!c) return J({ error: "unknown code" }, 404);
          const r = b.report || {};
          const rid = String(r.id || "r" + Date.now()).slice(0, 60);
          c.reports = (c.reports || []).filter((x) => x.id !== rid);
          c.reports.push({ id: rid, title: String(r.title || "").slice(0, 120), property: String(r.property || "").slice(0, 160), date: String(r.date || "").slice(0, 10), url: String(r.url || "").slice(0, 300), summary: String(r.summary || "").slice(0, 300) });
          await this.persist();
          return J({ ok: true, count: c.reports.length });
        }
        if (b.action === "remove") {
          const c = this.codes[code];
          if (c) { c.reports = (c.reports || []).filter((x) => x.id !== String(b.id)); await this.persist(); }
          return J({ ok: true });
        }
        if (b.action === "list") {
          const c = this.codes[code];
          return J({ ok: !!c, reports: (c && c.reports) || [] });
        }
        return J({ error: "action add|remove|list" }, 400);
      }
      if (p === "/agent/codes" && req.method === "POST") {
        const b = await req.json();
        if (b.action === "add") {
          const code = String(b.code || "").trim().toUpperCase().slice(0, 40);
          if (!code || !b.name) return J({ error: "code and name required" }, 400);
          this.codes[code] = { name: String(b.name).slice(0, 60), note: String(b.note || "").slice(0, 200), created: Date.now(), redeemed: [] };
          await this.persist();
          return J({ ok: true, code });
        }
        if (b.action === "remove") {
          delete this.codes[String(b.code || "").trim().toUpperCase()];
          await this.persist();
          return J({ ok: true });
        }
        return J({ codes: this.codes });
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
      return J({ error: String(e) }, 500);
    }
  }
}

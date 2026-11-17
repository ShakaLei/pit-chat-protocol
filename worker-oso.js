// 🎻 OPEN SOURCE ORCHESTRA CHAT HUB — grok-bell pilot (local branch, not deployed)
// Live hosts: https://chat.opensourceorchestra.org  and  https://oso-chat.shakaverse.workers.dev
// Public template ancestor: worker.js (Terri). Production service name observed: "oso-chat-hub".
// Visitor: POST /send, GET /poll (long-poll). Agent: Bearer AGENT_KEY or REPLY_TOKEN
//   GET /agent/updates, POST /agent/reply, POST /agent/typing.
// Pilot: on a new visitor message, the hub POSTs to GROK_WEBHOOK_URL (secret) with a
// GROK_WEBHOOK_KEY header; if no agent reply arrives, a system fallback note is posted.
// One singleton Durable Object ("hub") — keep class Hub + idFromName("hub-v1") in place.
// Do not add a new Durable Object migration on deploy; that can reset live history.

import {
  FALLBACK_TEXT,
  CAP_TEXT,
  DEBOUNCE_MS,
  FALLBACK_MS,
  FALLBACK_MS_ON_ERROR,
  MAX_WAKES_PER_DAY,
  agentAuthorized,
  isWakeWorthyVisitorMessage,
  shouldDebounce,
  shouldAllowWake,
  utcDay,
  grokWebhookPayload,
  webhookHeaders,
  sessionCursor,
} from "./oso-grok-pilot-lib.js";

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

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return J({
        ok: true,
        service: "oso-chat-hub",
        pilot: "grok-bell",
        webhook_configured: Boolean(env.GROK_WEBHOOK_URL && env.GROK_WEBHOOK_KEY),
      });
    }
    if (url.pathname.startsWith("/agent/")) {
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
    this.lastWake = new Map(); // session -> ts (memory only; debounce)
    this.loaded = null;
  }

  async load() {
    if (this.loaded) return;
    this.seq = (await this.state.storage.get("seq")) || 0;
    this.msgs = (await this.state.storage.get("msgs")) || [];
    this.codes = (await this.state.storage.get("codes")) || {};
    this.members = (await this.state.storage.get("members")) || {};
    this.lastAgentSeen = (await this.state.storage.get("lastAgentSeen")) || 0;
    this.fallbacks = (await this.state.storage.get("fallbacks")) || {};
    this.wakeBudget = (await this.state.storage.get("wakeBudget")) || { day: "", count: 0 };
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
      fallbacks: this.fallbacks,
      wakeBudget: this.wakeBudget,
    });
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

  hasAgentReplySince(session, since) {
    return this.msgs.some(
      (x) =>
        x.session === session &&
        x.role === "oso" &&
        !x.fallbackNote &&
        !x.holdNote &&
        !x.sleepNote &&
        x.ts >= since
    );
  }

  async armFallbackAlarm() {
    const dues = Object.values(this.fallbacks || {})
      .filter((f) => !f.noteSent)
      .map((f) => f.due);
    if (!dues.length) return;
    if (typeof this.state.storage.setAlarm === "function") {
      await this.state.storage.setAlarm(Math.min(...dues));
    }
  }

  async scheduleFallback(session, delayMs, since) {
    this.fallbacks = this.fallbacks || {};
    const existing = this.fallbacks[session];
    // A newer visitor message resets the timer; don't stack notes.
    this.fallbacks[session] = {
      due: Date.now() + delayMs,
      since: since || (existing && existing.since) || Date.now(),
      noteSent: false,
    };
    await this.state.storage.put("fallbacks", this.fallbacks);
    await this.armFallbackAlarm();
  }

  async postSystemNote(session, text, flags) {
    const m = {
      seq: ++this.seq,
      session,
      role: "system",
      name: "hub",
      text,
      ts: Date.now(),
      ...flags,
    };
    this.msgs.push(m);
    await this.persist();
    this.wakeVisitor(session);
    return m;
  }

  takeWakeBudget(now) {
    const day = utcDay(now);
    if (!this.wakeBudget || this.wakeBudget.day !== day) {
      this.wakeBudget = { day, count: 0 };
    }
    if (!shouldAllowWake(this.wakeBudget.count, MAX_WAKES_PER_DAY)) return false;
    this.wakeBudget.count += 1;
    return true;
  }

  async notifyGrok(msg, page) {
    const env = this.env || {};
    const url = env.GROK_WEBHOOK_URL;
    const key = env.GROK_WEBHOOK_KEY;
    if (!isWakeWorthyVisitorMessage(msg)) return;
    if (!url || !key) {
      await this.scheduleFallback(msg.session, FALLBACK_MS_ON_ERROR, msg.ts);
      return;
    }
    const now = Date.now();
    if (shouldDebounce(this.lastWake.get(msg.session), now, DEBOUNCE_MS)) {
      // Agent already waking for this session; they should read full /poll history.
      await this.scheduleFallback(msg.session, FALLBACK_MS, msg.ts);
      return;
    }
    if (!this.takeWakeBudget(now)) {
      await this.postSystemNote(msg.session, CAP_TEXT, { capNote: true });
      return;
    }
    this.lastWake.set(msg.session, now);
    this.typing.set(msg.session, now);
    this.wakeVisitor(msg.session);
    await this.state.storage.put("wakeBudget", this.wakeBudget);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: webhookHeaders(key),
        body: JSON.stringify(grokWebhookPayload(msg, page)),
      });
      if (!res.ok) throw new Error("webhook-not-ok");
      this.lastAgentSeen = Date.now();
      await this.scheduleFallback(msg.session, FALLBACK_MS, msg.ts);
    } catch (_err) {
      await this.scheduleFallback(msg.session, FALLBACK_MS_ON_ERROR, msg.ts);
    }
  }

  async alarm() {
    await this.load();
    const now = Date.now();
    let changed = false;
    for (const [session, f] of Object.entries(this.fallbacks || {})) {
      if (!f || f.noteSent || f.due > now) continue;
      if (!this.hasAgentReplySince(session, f.since || 0)) {
        await this.postSystemNote(session, FALLBACK_TEXT, { fallbackNote: true });
      }
      f.noteSent = true;
      changed = true;
    }
    // Drop fallbacks older than a day so storage stays small.
    for (const [session, f] of Object.entries(this.fallbacks || {})) {
      if (f && f.noteSent && now - (f.due || 0) > 86400000) {
        delete this.fallbacks[session];
        changed = true;
      }
    }
    if (changed) await this.state.storage.put("fallbacks", this.fallbacks);
    await this.armFallbackAlarm();
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
        await this.persist();
        this.wakeAgent();
        this.wakeVisitor(session);
        const notify = this.notifyGrok(m, page);
        if (typeof this.state.waitUntil === "function") this.state.waitUntil(notify);
        else if (this.state.ctx && typeof this.state.ctx.waitUntil === "function") this.state.ctx.waitUntil(notify);
        else await notify;
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

      if (p === "/agent/updates" && req.method === "GET") {
        this.lastAgentSeen = Date.now();
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
        this.lastAgentSeen = Date.now();
        const b = await req.json();
        const session = String(b.session || "").slice(0, 64);
        const text = String(b.text || "").slice(0, 4000).trim();
        if (!session || !text) return J({ error: "session and text required" }, 400);
        const m = {
          seq: ++this.seq,
          session,
          role: "oso",
          name: String(b.name || "OSO 🎻").slice(0, 60),
          text,
          ts: Date.now(),
        };
        this.msgs.push(m);
        this.typing.delete(session);
        if (this.fallbacks && this.fallbacks[session]) {
          this.fallbacks[session].noteSent = true;
        }
        await this.persist();
        this.wakeVisitor(session);
        return J({ ok: true, seq: m.seq });
      }

      if (p === "/agent/typing" && req.method === "POST") {
        this.lastAgentSeen = Date.now();
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
        const m = {
          seq: ++this.seq,
          session: canonical,
          role: "system",
          name: "hub",
          member: c.name,
          text: resumed
            ? `🔑 ${c.name} resumed their desk from a new device — history restored.`
            : `🔑 access code redeemed — welcome, ${c.name}! Unlimited desk unlocked.`,
          ts: Date.now(),
        };
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
        if (!c) {
          await new Promise((r) => setTimeout(r, 900));
          return J({ ok: false, error: "code not recognized — check with whoever gave it to you 🌺" }, 404);
        }
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
          c.reports.push({
            id: rid,
            title: String(r.title || "").slice(0, 120),
            property: String(r.property || "").slice(0, 160),
            date: String(r.date || "").slice(0, 10),
            url: String(r.url || "").slice(0, 300),
            summary: String(r.summary || "").slice(0, 300),
          });
          await this.persist();
          return J({ ok: true, count: c.reports.length });
        }
        if (b.action === "remove") {
          const c = this.codes[code];
          if (c) {
            c.reports = (c.reports || []).filter((x) => x.id !== String(b.id));
            await this.persist();
          }
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
          this.codes[code] = {
            name: String(b.name).slice(0, 60),
            note: String(b.note || "").slice(0, 200),
            created: Date.now(),
            redeemed: [],
          };
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
      return J({ error: "hub error" }, 500);
    }
  }
}

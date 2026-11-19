var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "content-type,authorization"
};
var J = /* @__PURE__ */ __name((o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS } }), "J");

// 🛡️ HARDEN 2026-11-08 (Admiral 🫡 — PAʻA findings F1/F4/F5/F6/G2/G3). Never put a real secret here.
const HARDEN = {
  THROTTLE_N: 20, THROTTLE_IP_N: 60, WIN_MS: 600000,
  CANARY: /PAA[-_ ]?CANARY/i,
  DEBUG: /^\s*(test(ing)?\s*\d*|ping|pong|hello\s*world|asdf+|debug|x|\.+)\s*[.!?]*\s*$/i,
  INJ: [
    ["ignore_previous", /\b(ignore|disregard|forget|override|bypass)\b[\s\S]{0,40}\b(previous|prior|above|earlier|all|your)\b[\s\S]{0,30}\b(instruction|rule|prompt|message|guideline)s?\b/i],
    ["system_prompt", /system\s*prompt|your\s+(hidden\s+)?(instructions|rules|prompt)\b|developer\s+message|internal\s+(instructions|config)/i],
    ["secret_ask", /seed\s*phrase|mnemonic|private\s*key|api[_\s-]?key|bearer\s+token|env(ironment)?\s+var|AGENT_KEY|DESK_KEY|access\s+codes?|app\s*password/i],
    ["fake_payment", /\btx\b[\s\S]{0,12}0x[0-9a-f]{8,}|payment\s+(is\s+)?confirmed|already\s+paid/i],
    ["role_tag", /\[\s*(system|operator|admin|developer|sysadmin)\b[^\]]{0,120}\]|<\s*\/?\s*(system|instructions?|admin)\s*>/i],
    ["roleplay_mode", /\byou\s+are\s+now\b|pretend\s+(to\s+be|you)|\bjailbreak|\bDAN\b|(developer|maintenance|debug|god|owner)\s+mode/i],
    ["authority_claim", /\b(i\s+am|i'm|this\s+is)\s+(shaka|the\s+admiral|admiral|sysadmin|the\s+admin|the\s+owner)\b|authori[sz]ed\s+by\s+the\s+admiral/i],
    ["b64_blob", /[A-Za-z0-9+\/]{60,}={0,2}/],
    ["thai_ignore", /ข้ามคำสั่ง|ละเว้นคำสั่ง|เพิกเฉยคำสั่ง/],
  ],
};
const hardenFlags = (t) => HARDEN.INJ.filter(([, re]) => re.test(t)).map(([k]) => k);

// 🔑 GROKA_KEY 2026-11-18 — the door accepts Bearer AGENT_KEY, REPLY_TOKEN or GROKA_KEY.
// Each key is optional; an unset one never matches. AGENT_KEY is never rotated here.
const agentAuthorized = (auth, env) => {
  for (const k of [env && env.AGENT_KEY, env && env.REPLY_TOKEN, env && env.GROKA_KEY]) {
    if (k && auth === `Bearer ${k}`) return true;
  }
  return false;
};

var worker_default = {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    if (url.pathname === "/health") return J({ ok: true, service: "ohana-chat-hub" });
    if (url.pathname.startsWith("/agent/") || url.pathname.startsWith("/watch/")) {
      const auth = req.headers.get("authorization") || "";
      if (!agentAuthorized(auth, env)) return J({ error: "unauthorized" }, 401);
    }
    const id = env.HUB.idFromName("hub-v1");
    return env.HUB.get(id).fetch(req);
  }
};
var Hub = class {
  static {
    __name(this, "Hub");
  }
  constructor(state, env) {
    this.env = env;
    this.state = state;
    this.visWaiters = /* @__PURE__ */ new Map();
    this.agentWaiters = [];
    this.typing = /* @__PURE__ */ new Map();
    this.loaded = null;
  }
  // 🛡️ HARDEN 2026-11-08 helpers
  async hardenLog(e) {
    e.ts = Date.now();
    try { console.log(JSON.stringify({ harden: e })); } catch (_) {}
    if (!this.hflags) this.hflags = (await this.state.storage.get("hflags")) || [];
    this.hflags.push(e);
    if (this.hflags.length > 400) this.hflags = this.hflags.slice(-400);
    await this.state.storage.put("hflags", this.hflags);
  }
  async redeemLocked(key) {
    if (!this.rfails) this.rfails = (await this.state.storage.get("rfails")) || [];
    const now = Date.now();
    this.rfails = this.rfails.filter((f) => now - f.ts < HARDEN.WIN_MS);
    return this.rfails.filter((f) => f.k === key.s).length >= 5 || this.rfails.filter((f) => f.ip === key.ip).length >= 8 || this.rfails.length >= 60;
  }
  async redeemFail(key) {
    this.rfails.push({ k: key.s, ip: key.ip, ts: Date.now() });
    await this.state.storage.put("rfails", this.rfails);
    await this.hardenLog({ kind: "redeem_fail", session: key.s });
    await new Promise((r) => setTimeout(r, 900));
  }
  async load() {
    if (!this.loaded) {
      this.seq = await this.state.storage.get("seq") || 0;
      this.msgs = await this.state.storage.get("msgs") || [];
      this.codes = await this.state.storage.get("codes") || {};
      this.members = await this.state.storage.get("members") || {};
      this.lastAgentSeen = await this.state.storage.get("lastAgentSeen") || 0;
      this.loaded = true;
    }
  }
  async persist() {
    if (this.msgs.length > 600) this.msgs = this.msgs.slice(-500);
    await this.state.storage.put({ seq: this.seq, msgs: this.msgs, codes: this.codes, members: this.members, lastAgentSeen: this.lastAgentSeen });
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
  // STALE-CURSOR LAW 2026-11-15: newest seq this session holds (0 = none) — the only cursor a widget can legitimately have
  sessionMax(session) {
    let mx = 0;
    for (const m of this.msgs) if (m.session === session && m.seq > mx) mx = m.seq;
    return mx;
  }
  async fetch(req) {
    await this.load();
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (p === "/send" && req.method === "POST") {
        const b = await req.json();
        const session = String(b.session || "").slice(0, 64);
        const text = String(b.text || "").slice(0, 2e3).trim();
        const name = String(b.name || "guest").slice(0, 60);
        if (!session || !text) return J({ error: "session and text required" }, 400);
        // 🛡️ HARDEN soft throttle: ≤20 visitor msgs / 10 min / session (+60 / IP), friendly note once
        const _hnow = Date.now();
        const _hip = req.headers.get("cf-connecting-ip") || "?";
        this.iphits = this.iphits || new Map();
        const _hips = (this.iphits.get(_hip) || []).filter((t) => _hnow - t < HARDEN.WIN_MS);
        const _hwin = this.msgs.filter((x) => x.session === session && x.role === "visitor" && _hnow - x.ts < HARDEN.WIN_MS).length;
        const _hburst = this.msgs.filter((x) => x.session === session && x.role === "visitor" && _hnow - x.ts < 60000).length;
        if (_hwin >= HARDEN.THROTTLE_N || _hburst >= 15 || _hips.length >= HARDEN.THROTTLE_IP_N) {
          if (!this.msgs.some((x) => x.session === session && x.throttleNote && _hnow - x.ts < HARDEN.WIN_MS)) {
            this.msgs.push({ seq: ++this.seq, session, role: "ohana", name: "\u02BBOHANA \u{1FAF6}", text: "\u{1F33A} slow down a little, friend \u2014 the desk reads every word. Give it a few minutes, then send your next message. Mahalo!", throttleNote: true, ts: _hnow });
            await this.persist();
            this.wakeVisitor(session);
          }
          await this.hardenLog({ kind: "throttle", session, n: _hwin, ipn: _hips.length });
          return J({ error: "slow down a little \u{1F33A} \u2014 try again in a few minutes", throttled: true }, 429);
        }
        _hips.push(_hnow);
        this.iphits.set(_hip, _hips);
        if (this.iphits.size > 5000) this.iphits.clear();
        const _hfl = hardenFlags(text);
        if (_hfl.length) await this.hardenLog({ kind: "inject", session, flags: _hfl, len: text.length });
        const recent = this.msgs.filter((m2) => m2.session === session && m2.role === "visitor" && Date.now() - m2.ts < 6e4);
        if (recent.length >= 15) return J({ error: "whoa, easy on the throttle pilot \u{1F30D} \u2014 one sec" }, 429);
        const dayAgo = Date.now() - 864e5;
        const todayCount = this.msgs.filter((m2) => m2.session === session && m2.role === "visitor" && m2.ts > dayAgo).length;
        const mbr = this.members[session];
        const cap = mbr ? 400 : 50;
        if (todayCount >= cap) return J({ error: mbr ? "that's a lot of aloha for one day \u2014 the \u02BBohana rests too, see you tomorrow \u{1FAF6}\u{1F33A}" : "guest chats rest after 50 messages a day \u{1F30D} \u2014 a Blessing Pool gift makes you a member with room to talk story all day: blessingpool.com" }, 429);
        const mem = this.members[session];
        const m = { seq: ++this.seq, session, role: "visitor", name: mem ? mem.name : name, member: mem ? mem.name : null, text, ts: Date.now() };
        this.msgs.push(m);
        await this.persist();
        this.wakeAgent();
        this.wakeVisitor(session);
        if (Date.now() - this.lastAgentSeen > 3e5) {
          const noticed = this.msgs.some((x) => x.session === session && x.role === "ohana" && x.sleepNote && Date.now() - x.ts < 3e5);
          if (!noticed) {
            const nm = { seq: ++this.seq, session, role: "ohana", name: "\u02BBOHANA \u{1FAF6}", text: "\u{1F4A4} waking the \u02BBohana desk \u2014 your message is saved, and the answer will appear right here in a minute or two. Keep this page open \u{1FAF6}", sleepNote: true, ts: Date.now() };
            this.msgs.push(nm);
            await this.persist();
            this.wakeVisitor(session);
          }
        } else {
          const held = this.msgs.some((x) => x.session === session && x.role === "ohana" && x.holdNote && Date.now() - x.ts < 6e5);
          if (!held) {
            const nm = { seq: ++this.seq, session, role: "ohana", name: "\u02BBOHANA \u{1FAF6}", text: "\u{1FAF6} heard you! a real agent of the \u02BBohana is on the way \u2014 hang tight\u2026", holdNote: true, ts: Date.now() };
            this.msgs.push(nm);
            await this.persist();
            this.wakeVisitor(session);
          }
        }
        return J({ ok: true, seq: m.seq });
      }
      if (p === "/poll" && req.method === "GET") {
        const session = String(url.searchParams.get("session") || "").slice(0, 64);
        let after = Number(url.searchParams.get("after") || 0);
        const wait = Math.min(Number(url.searchParams.get("wait") || 0), 25);
        if (!session) return J({ error: "session required" }, 400);
        // 🔁 STALE-CURSOR LAW 2026-11-15 (Shaka: "you have to hit refresh to see the response"): a cursor AHEAD of this
        // hub's own seq can only come from another hub (a door swapped hubs under the same localStorage
        // keys — e.g. shakaleikaumaka.com JAI→SHAKA hub on 25 Sep kept sp_after=134) or a reset DO. Honouring it
        // hides every new reply until seq catches up; reload only 'fixed' it via catch-up from after=0.
        // Resume from this session's newest message instead (widgets dedupe by seq) and tell the widget.
        let stale = false;
        if (!(after >= 0) || after > this.seq) { stale = true; after = this.sessionMax(session); }
        let out = this.sessionMsgs(session, after);
        if (!out.length && wait > 0) {
          if (!this.visWaiters.has(session)) this.visWaiters.set(session, []);
          await this.wait(this.visWaiters.get(session), wait * 1e3);
          out = this.sessionMsgs(session, after);
        }
        const typingTs = this.typing.get(session) || 0;
        const mem = this.members[session];
        return J({ messages: out, typing: Date.now() - typingTs < 6e3, member: mem ? mem.name : null, now: Date.now(), cursor: this.sessionMax(session), ...(stale ? { stale: true } : {}) });
      }
      if (p === "/watch/updates" && req.method === "GET") {
        const after = Number(url.searchParams.get("after") || 0);
        const wait = Math.min(Number(url.searchParams.get("wait") || 0), 45);
        const pick = /* @__PURE__ */ __name(() => this.msgs.filter((m) => (m.role === "visitor" || m.role === "system") && m.seq > after), "pick");
        let out = pick();
        if (!out.length && wait > 0) {
          await this.wait(this.agentWaiters, wait * 1e3);
          out = pick();
        }
        return J({ messages: out, seq: this.seq, now: Date.now() });
      }
      if (p === "/agent/updates" && req.method === "GET") {
        this.lastAgentSeen = Date.now();
        if (!this._lastSeenWrite || Date.now() - this._lastSeenWrite > 12e4) {
          this._lastSeenWrite = Date.now();
          await this.state.storage.put("lastAgentSeen", this.lastAgentSeen);
        }
        const after = Number(url.searchParams.get("after") || 0);
        const wait = Math.min(Number(url.searchParams.get("wait") || 0), 45);
        const pick = /* @__PURE__ */ __name(() => this.msgs.filter((m) => (m.role === "visitor" || m.role === "system") && m.seq > after), "pick");
        let out = pick();
        if (!out.length && wait > 0) {
          await this.wait(this.agentWaiters, wait * 1e3);
          out = pick();
        }
        return J({ messages: out, seq: this.seq, now: Date.now() });
      }
      if (p === "/agent/purge" && req.method === "POST") {
        const b = await req.json();
        const session = String(b.session || "").slice(0, 64);
        if (!session) return J({ error: "session required" }, 400);
        const before = this.msgs.length;
        this.msgs = this.msgs.filter((m) => m.session !== session);
        await this.persist();
        await this.hardenLog({ kind: "purge", session, removed: before - this.msgs.length });
        return J({ ok: true, removed: before - this.msgs.length });
      }
      if (p === "/agent/flags" && req.method === "GET") {
        if (!this.hflags) this.hflags = (await this.state.storage.get("hflags")) || [];
        const since = Number(url.searchParams.get("since") || 0);
        const list = this.hflags.filter((f) => f.ts > since);
        const counts = {};
        for (const f of list) counts[f.kind] = (counts[f.kind] || 0) + 1;
        return J({ ok: true, counts, flags: list.slice(-100), now: Date.now() });
      }
      if (p === "/agent/reply" && req.method === "POST") {
        this.lastAgentSeen = Date.now();
        const b = await req.json();
        const session = String(b.session || "").slice(0, 64);
        const text = String(b.text || "").slice(0, 4e3).trim();
        if (!session || !text) return J({ error: "session and text required" }, 400);
        // 🛡️ HARDEN output guard: canary / own key / bare debug pings never reach a visitor
        if (HARDEN.CANARY.test(text) || (this.env && [this.env.AGENT_KEY, this.env.REPLY_TOKEN, this.env.GROKA_KEY].some((k) => k && text.includes(k)))) {
          await this.hardenLog({ kind: "CANARY_OR_KEY_BLOCKED", session });
          return J({ ok: false, blocked: true, error: "reply blocked by the output guard (internal marker). Rewrite it without any internal config. The Admiral is alerted." }, 451);
        }
        if (HARDEN.DEBUG.test(text) && !session.startsWith("selftest")) {
          await this.hardenLog({ kind: "debug_drop", session });
          return J({ ok: false, dropped: true, error: "looks like a test/debug ping, so it was NOT shown to the visitor. Post your real reply (test the path only with a session named selftest-...)." }, 422);
        }
        const m = { seq: ++this.seq, session, role: "ohana", name: "\u02BBOHANA \u{1FAF6}", text, ts: Date.now() };
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
        const _rk = { s: session, ip: req.headers.get("cf-connecting-ip") || "?" };
        if (await this.redeemLocked(_rk)) return J({ ok: false, error: "too many tries \u2014 wait 10 minutes \u{1F33A}" }, 429);
        if (!this.codes[code]) await this.redeemFail(_rk);
        const c = this.codes[code];
        if (!c) return J({ ok: false, error: "code not recognized \u2014 check with whoever gave it to you \u{1F30D}" }, 404);
        const canonical = c.session || c.redeemed && c.redeemed[0] || session;
        if (!c.session) c.session = canonical;
        this.members[canonical] = { code, name: c.name, since: Date.now() };
        if (!c.redeemed.includes(session)) c.redeemed.push(session);
        const resumed = canonical !== session;
        const m = { seq: ++this.seq, session: canonical, role: "system", name: "hub", member: c.name, text: resumed ? `\u{1F511} ${c.name} resumed their desk from a new device \u2014 history restored.` : `\u{1F511} access code redeemed \u2014 welcome, ${c.name}! Unlimited desk unlocked.`, ts: Date.now() };
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
        const _rk = { s: "profile:" + (req.headers.get("cf-connecting-ip") || "?"), ip: req.headers.get("cf-connecting-ip") || "?" };
        if (await this.redeemLocked(_rk)) return J({ ok: false, error: "too many tries \u2014 wait 10 minutes \u{1F33A}" }, 429);
        if (!this.codes[code]) await this.redeemFail(_rk);
        const c = this.codes[code];
        if (!c) {
          await new Promise((r) => setTimeout(r, 900));
          return J({ ok: false, error: "code not recognized \u2014 check with whoever gave it to you \u{1F30D}" }, 404);
        }
        const reports = (c.reports || []).slice().sort((a, b2) => String(b2.date || "").localeCompare(String(a.date || "")));
        return J({ ok: true, member: { name: c.name, since: c.created, note: c.note || "", plan: "Founding member \u{1F511}", reports } });
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
          if (c) {
            c.reports = (c.reports || []).filter((x) => x.id !== String(b.id));
            await this.persist();
          }
          return J({ ok: true });
        }
        if (b.action === "list") {
          const c = this.codes[code];
          return J({ ok: !!c, reports: c && c.reports || [] });
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
};
export {
  Hub,
  worker_default as default
};
//# sourceMappingURL=worker.js.map

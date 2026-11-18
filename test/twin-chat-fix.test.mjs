import { strict as assert } from "node:assert";
import {
  FOOTER_TEXT,
  WAIT_NOTE,
  isJunkHistoryMessage,
  stripJunkHistory,
  threadHistory,
  lastVisitorMessage,
  replyAlreadyPosted,
  canPostReply,
  applyStaleCursorLaw,
} from "../twin-chat-lib.js";

assert.equal(FOOTER_TEXT, "🧠 thinking with Grok · built with Cursor");
assert.ok(!/Tokyo/i.test(WAIT_NOTE));
assert.ok(!/Devcon/i.test(WAIT_NOTE));
assert.ok(WAIT_NOTE.includes("will reply soon"));

const composing = { session: "s", seq: 2, role: "jai", text: "heard you — Shaka is composing his answer with aloha, one sweet moment." };
const composingShort = { session: "s", seq: 3, role: "jai", text: "composing" };
const tokyo = { session: "s", seq: 4, role: "jai", text: "💤 Shaka is resting right now, all the way to Tokyo — leave a word." };
const flagged = { session: "s", seq: 5, role: "system", text: WAIT_NOTE, sleepNote: true };
const visitor = { session: "s", seq: 1, role: "visitor", text: "aloha — how was Devcon 8?" };
const reply = { session: "s", seq: 6, role: "jai", text: "Devcon 8 in Mumbai already happened, 3–6 November 2026. The next named gathering on the Open Source Orchestra site is Lisbon, 12–14 October 2027." };
const other = { session: "t", seq: 9, role: "visitor", text: "hello" };
const visitorTokyo = { session: "s", seq: 7, role: "visitor", text: "I used to sleep in Tokyo — tell me about the road." };

assert.equal(isJunkHistoryMessage(composing), true);
assert.equal(isJunkHistoryMessage(composingShort), true);
assert.equal(isJunkHistoryMessage(tokyo), true);
assert.equal(isJunkHistoryMessage(flagged), true);
assert.equal(isJunkHistoryMessage(visitor), false);
assert.equal(isJunkHistoryMessage(reply), false);
assert.equal(isJunkHistoryMessage(visitorTokyo), false, "visitor mentions of Tokyo stay in the thread");

const raw = [visitor, composing, composingShort, tokyo, flagged, reply, other, visitorTokyo];
const cleaned = stripJunkHistory(raw);
assert.deepEqual(cleaned.map((m) => m.seq), [1, 6, 9, 7]);

const thread = threadHistory(raw, "s");
assert.deepEqual(thread.map((m) => m.seq), [1, 6, 7]);
assert.ok(thread.every((m) => !isJunkHistoryMessage(m)));
assert.equal(thread.some((m) => /composing/i.test(m.text)), false);
assert.equal(thread.some((m) => /Tokyo/i.test(m.text) && m.role !== "visitor"), false);

assert.equal(lastVisitorMessage(raw, "s").seq, 7);
assert.equal(replyAlreadyPosted([visitor, reply], "s").yes, true);
assert.equal(replyAlreadyPosted([visitor, composing, tokyo], "s").yes, false, "junk replies do not count");
assert.equal(canPostReply([visitor, reply], "s").ok, false);
assert.equal(canPostReply([visitor, reply], "s").reason, "already replied");
assert.equal(canPostReply([visitor, composing], "s").ok, true);
assert.equal(canPostReply([visitor, reply, visitorTokyo], "s").ok, true, "a new visitor message opens a new reply");
assert.equal(canPostReply([], "s").ok, false);

// Agent must read cleaned history before posting a reply.
const historyBeforeReply = threadHistory([visitor, composing, tokyo], "s");
assert.deepEqual(historyBeforeReply.map((m) => m.role), ["visitor"]);
assert.equal(canPostReply([visitor, composing, tokyo], "s").inReplyTo, 1);

console.log("ok — twin-chat-fix tests passed");

// 🔁 STALE-CURSOR LAW 2026-11-15
assert.deepEqual(applyStaleCursorLaw(0, 10, 4), { after: 0, stale: false });
assert.deepEqual(applyStaleCursorLaw(3, 10, 4), { after: 3, stale: false });
assert.deepEqual(applyStaleCursorLaw(4, 10, 4), { after: 4, stale: false });
assert.deepEqual(applyStaleCursorLaw(10, 10, 4), { after: 10, stale: false }, "equal to hub seq is not stale");
assert.deepEqual(applyStaleCursorLaw(134, 133, 133), { after: 133, stale: true }, "cursor ahead of hub seq resumes at session max");
assert.deepEqual(applyStaleCursorLaw(50, 10, 8), { after: 8, stale: true });
assert.deepEqual(applyStaleCursorLaw(Number("nope"), 10, 4), { after: 4, stale: true }, "NaN after is stale");
assert.deepEqual(applyStaleCursorLaw(-1, 10, 4), { after: 4, stale: true });
assert.deepEqual(applyStaleCursorLaw(0, 0, 0), { after: 0, stale: false });

console.log("ok — stale-cursor law tests passed");


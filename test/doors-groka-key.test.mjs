// GPL-3.0 — every ʻohana chat door accepts AGENT_KEY, REPLY_TOKEN or GROKA_KEY; nothing else.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";

const doors = readdirSync(new URL("../doors/", import.meta.url));

for (const door of doors) {
  test(`${door}: agent gate`, async () => {
    const mod = await import(new URL(`../doors/${door}/worker.js`, import.meta.url));
    const seen = [];
    const HUB = { idFromName: () => "id", get: () => ({ fetch: async () => { seen.push(1); return new Response("{}"); } }) };
    const call = (auth, env) => mod.default.fetch(
      new Request("https://x/agent/updates?after=0&wait=0", { headers: auth ? { authorization: auth } : {} }),
      { HUB, ...env });
    const env = { AGENT_KEY: "a-test", GROKA_KEY: "g-test" };
    assert.equal((await call("Bearer a-test", env)).status, 200);
    assert.equal((await call("Bearer g-test", env)).status, 200);
    assert.equal((await call("Bearer nope", env)).status, 401);
    assert.equal((await call("", env)).status, 401);
    // unset keys never match an empty or "undefined" bearer
    assert.equal((await call("Bearer undefined", { AGENT_KEY: "a-test" })).status, 401);
    assert.equal((await call("Bearer ", {})).status, 401);
    assert.equal(seen.length, 2);
    const h = await mod.default.fetch(new Request("https://x/health"), { HUB });
    assert.equal(h.status, 200);
    assert.match((await h.json()).service, new RegExp(`^${door}-hub$`));
  });
}

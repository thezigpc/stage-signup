// Per-phone limits, dropping out, the device id, notes privacy, the runner's lease, and the
// signup rate limit.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { startServer, newDevice, sleep } from "../harness.mjs";

describe("limits and privacy", () => {
  let server, token;
  before(async () => {
    server = await startServer();
    token = await server.staff();
  });
  after(async () => server.stop());

  const song = (name) => ({ name, song: "Song" });
  const run = (action, body) => server.run(token, "main", action, body);
  const setStage = (patch) => server.http("/api/admin/stages/main", { method: "PUT", body: patch, token });

  test("one active signup per phone; again after the turn; the setting is staff's", async () => {
    await run("new-night");
    await setStage({ oneActive: true, maxPerNight: 0 });
    const p = await server.patron();
    await p.ok("signUp", song("Ann"));
    let v = await p.waitFor((x) => x.mine.length === 1 && !x.gate.ok, "gate closes");
    assert.match(v.gate.reason, /already on the list/i);
    assert.equal((await p.emit("signUp", song("Ann 2"))).ok, false);
    await run("next");
    assert.equal((await p.emit("signUp", song("Ann 2"))).ok, false, "still active while on stage");
    await run("done");
    await p.waitFor((x) => x.gate.ok, "gate opens after the turn");
    await p.ok("signUp", song("Ann 2"));
    await setStage({ oneActive: false });
    await p.ok("signUp", song("Ann 3"));
    await setStage({ oneActive: true });
  });

  test("most signups per phone per night; drop-outs don't count; walk-ups aren't limited", async () => {
    await run("new-night");
    await setStage({ oneActive: false, maxPerNight: 2 });
    const p = await server.patron();
    const first = await p.ok("signUp", song("A"));
    await p.ok("dropOut", first.entryId);
    await p.ok("signUp", song("B"));
    await p.ok("signUp", song("C"));
    const v = await p.waitFor((x) => !x.gate.ok, "limit");
    assert.match(v.gate.reason, /limit/i);
    assert.match((await p.emit("signUp", song("D"))).error, /limit/i);
    assert.equal(v.mine.find((e) => e.name === "A").status, "dropped");
    assert.equal((await run("add", song("D"))).ok, true);
    await setStage({ oneActive: true, maxPerNight: 0 });
  });

  test("dropping out: only your own, only while waiting", async () => {
    await run("new-night");
    const [p, q] = [await server.patron(), await server.patron()];
    const { entryId } = await p.ok("signUp", song("Ann"));
    assert.equal((await q.emit("dropOut", entryId)).ok, false, "someone else's");
    await run("next");
    assert.equal((await p.emit("dropOut", entryId)).ok, false, "on stage");
    await run("to-end", { entryId });
    await p.ok("dropOut", entryId);
    await p.waitFor((x) => x.queue.length === 0 && x.mine[0].status === "dropped");
  });

  test("the device id is who you are: a new tab finds its place; another phone doesn't", async () => {
    await run("new-night");
    const device = newDevice();
    const a = await server.patron("", device);
    await a.ok("signUp", song("Ann"));
    a.socket.close();
    const b = await server.patron("", device);
    const v = await b.waitFor((x) => x.mine.length === 1);
    assert.equal(v.mine[0].status, "waiting");
    assert.equal(v.queue[0].mine, true);
    assert.equal((await b.emit("signUp", song("Ann again"))).ok, false);

    const other = await server.patron();
    const ov = await other.waitFor((x) => x.queue.length === 1);
    assert.equal(ov.queue[0].mine, false);
    assert.equal(ov.mine.length, 0);

    // No (or a malformed) device id: can watch, can't sign up.
    const bad = await server.patron("", "x");
    assert.match((await bad.emit("signUp", song("Bad"))).error, /private mode/i);
    const tv = await server.tv();
    assert.equal((await tv.emit("signUp", song("TV"))).ok, false, "a TV can't sign up");
  });

  test("open mic notes: only the runner and the writer see them; the lease ends the runner's view", async () => {
    await run("new-night");
    await setStage({ mode: "openmic" });
    const [p, q] = [await server.patron(), await server.patron()];
    await p.ok("signUp", { name: "Ann", note: "I need a guitar stand", with: "The Bandmates" });
    const host = await server.runner("main", { token });
    const hv = await host.waitFor((x) => x.queue.length === 1);
    assert.equal(hv.stage.mode, "openmic");
    assert.equal(hv.queue[0].note, "I need a guitar stand");
    assert.equal((await p.waitFor((x) => x.queue.length === 1)).queue[0].note, "I need a guitar stand");
    const qv = await q.waitFor((x) => x.queue.length === 1);
    assert.equal(qv.queue[0].note, undefined, "other phones don't see the note");
    assert.equal(qv.history.length, 0);
    const tv = await server.tv();
    assert.equal(tv.state.queue[0].note, undefined, "the TV doesn't show the note");

    // A runner socket without a lease gets the public view.
    const sneaky = await server.client();
    await sneaky.ok("watch", { stage: "main", role: "runner" });
    const sv = await sneaky.waitFor((x) => x.queue.length === 1);
    assert.equal(sv.role, "tv");
    assert.equal(sv.queue[0].note, undefined);
    // A lease for someone else's socket, or without auth, is refused.
    assert.equal((await server.http("/api/run/lease", { body: { stage: "main", socketId: sneaky.socket.id } })).status, 401);
    assert.equal((await server.http("/api/run/lease", { body: { stage: "main", socketId: "nope" }, token })).status, 400);
    await setStage({ mode: "karaoke" });
  });
});

describe("runner lease expiry", () => {
  let server;
  // 150 s in production; short here.
  before(async () => (server = await startServer({ RUNNER_LEASE_MS: "600" })));
  after(async () => server.stop());

  test("the runner's view falls back to public when the lease isn't renewed", async () => {
    const token = await server.staff();
    await server.run(token, "main", "add", { name: "Ann", note: "secret note" });
    const host = await server.runner("main", { token });
    assert.equal(host.state.queue[0].note, "secret note");
    const v = await host.waitFor((x) => x.role === "tv", "lease lapsed", 3000);
    assert.equal(v.queue[0].note, undefined, "no notes without a lease");
    // Renewing brings it back.
    await server.http("/api/run/lease", { body: { stage: "main", socketId: host.socket.id }, token });
    await host.waitFor((x) => x.role === "runner", "renewed");
    // Switching role drops it at once.
    await host.ok("watch", { stage: "main", role: "tv" });
    await host.ok("watch", { stage: "main", role: "runner" });
    await sleep(50);
    assert.equal(host.state.role, "tv", "no lease until the page renews it");
  });
});

describe("signup rate limit", () => {
  let server;
  before(async () => (server = await startServer({ SIGNUPS_PER_MINUTE_PER_IP: "5" })));
  after(async () => server.stop());

  test("signups are rate limited per IP", async () => {
    const results = [];
    for (let i = 0; i < 6; i++) {
      const c = await server.patron();
      results.push(await c.emit("signUp", { name: `P${i}`, song: "Song" }));
    }
    assert.deepEqual(
      results.map((r) => r.ok),
      [true, true, true, true, true, false],
    );
    assert.match(results[5].error, /too many/i);
  });
});

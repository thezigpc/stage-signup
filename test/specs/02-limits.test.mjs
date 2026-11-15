// The host's limits: one signup per phone at a time, the most per night, pausing signups,
// dropping out, open mic notes, and the same phone finding its seat again.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { startServer, setupRoom, newDevice } from "../harness.mjs";

describe("limits", () => {
  let server;
  before(async () => (server = await startServer()));
  after(async () => server.stop());

  const song = (name) => ({ name, song: "Song" });

  test("one active signup per phone; again after the turn", async () => {
    const { host, patrons } = await setupRoom(server, 1);
    const [p] = patrons;
    await p.ok("signUp", song("Ann"));
    let v = await p.waitFor((x) => x.mine.length === 1 && !x.gate.ok, "gate closes");
    assert.match(v.gate.reason, /already on the list/i);
    const again = await p.emit("signUp", song("Ann 2"));
    assert.equal(again.ok, false);
    assert.match(again.error, /already on the list/i);

    await host.ok("nextPerformer");
    assert.equal((await p.emit("signUp", song("Ann 2"))).ok, false, "still active while on stage");
    await host.ok("finishCurrent");
    v = await p.waitFor((x) => x.gate.ok, "gate opens after the turn");
    await p.ok("signUp", song("Ann 2"));

    // Turned off: several at once.
    await host.ok("updateSettings", { oneActive: false });
    await p.ok("signUp", song("Ann 3"));
    v = await host.waitFor((x) => x.queue.length === 2);
  });

  test("most signups per phone tonight; drop-outs don't count", async () => {
    const { host, patrons } = await setupRoom(server, 1);
    const [p] = patrons;
    await host.ok("updateSettings", { oneActive: false, maxPerNight: 2 });
    const first = await p.ok("signUp", song("A"));
    await p.ok("dropOut", first.entryId);
    await p.ok("signUp", song("B"));
    await p.ok("signUp", song("C"));
    const v = await p.waitFor((x) => !x.gate.ok, "limit");
    assert.match(v.gate.reason, /limit/i);
    const over = await p.emit("signUp", song("D"));
    assert.equal(over.ok, false);
    assert.match(over.error, /limit/i);
    assert.equal(v.mine.length, 3);
    assert.equal(v.mine.find((e) => e.name === "A").status, "dropped");
    // The host can still add them by hand.
    await host.ok("addEntry", song("D"));
    assert.equal((await host.emit("updateSettings", { maxPerNight: 99 })).ok, false, "out of range");
    assert.equal((await host.emit("updateSettings", { minutesPerTurn: 0 })).ok, false, "out of range");
    assert.equal((await host.emit("updateSettings", { mode: "disco" })).ok, false);
  });

  test("pausing signups; the host's message; the line keeps its place", async () => {
    const { host, patrons } = await setupRoom(server, 2);
    const [p, q] = patrons;
    await p.ok("signUp", song("Ann"));
    await host.ok("setSignupsOpen", false);
    await host.ok("setMessage", "  10 minute   break ");
    const v = await q.waitFor((x) => !x.settings.signupsOpen && x.settings.message, "paused with a message");
    assert.equal(v.settings.message, "10 minute break");
    assert.match(v.gate.reason, /paused/i);
    const refused = await q.emit("signUp", song("Bo"));
    assert.equal(refused.ok, false);
    assert.match(refused.error, /paused/i);
    assert.equal(v.queue.length, 1, "Ann keeps her place");
    await host.ok("addEntry", song("Walk-in"));
    await host.ok("setSignupsOpen", true);
    await host.ok("setMessage", "");
    await q.ok("signUp", song("Bo"));
    const after = await host.waitFor((x) => x.queue.length === 3 && x.settings.message === "");
    assert.deepEqual(
      after.queue.map((e) => e.name),
      ["Ann", "Walk-in", "Bo"],
    );
  });

  test("dropping out: only your own, only while waiting", async () => {
    const { host, patrons } = await setupRoom(server, 2);
    const [p, q] = patrons;
    const { entryId } = await p.ok("signUp", song("Ann"));
    assert.equal((await q.emit("dropOut", entryId)).ok, false, "someone else's");
    await host.ok("nextPerformer");
    const onStage = await p.emit("dropOut", entryId);
    assert.equal(onStage.ok, false, "on stage");
    await host.ok("moveToEnd", entryId);
    await p.ok("dropOut", entryId);
    const v = await host.waitFor((x) => x.queue.length === 0 && x.history.some((e) => e.status === "dropped"));
    assert.equal(v.history[0].name, "Ann");
  });

  test("the same phone (device id) gets its seat back; another phone doesn't", async () => {
    const { code, host } = await setupRoom(server, 0);
    const device = newDevice();
    const a = await server.client();
    const first = await a.ok("joinRoom", { code, role: "patron", device });
    await a.ok("signUp", song("Ann"));
    a.socket.close();

    // A new tab (no stored seat), same device: same seat, still in line, limit still holds.
    const b = await server.client();
    const again = await b.ok("joinRoom", { code, role: "patron", device });
    assert.equal(again.memberId, first.memberId);
    const v = await b.waitFor((x) => x.mine.length === 1);
    assert.equal(v.mine[0].status, "waiting");
    assert.equal(v.queue[0].mine, true);
    assert.equal((await b.emit("signUp", song("Ann again"))).ok, false);

    const other = await server.client();
    const o = await other.ok("joinRoom", { code, role: "patron", device: newDevice() });
    assert.notEqual(o.memberId, first.memberId);
    const ov = await other.waitFor((x) => x.queue.length === 1);
    assert.equal(ov.queue[0].mine, false);
    assert.equal(ov.mine.length, 0);

    // A malformed device id is ignored (a new seat), never matched.
    const bad = await server.client();
    const b2 = await bad.ok("joinRoom", { code, role: "patron", device: "x" });
    assert.notEqual(b2.memberId, first.memberId);
    await host.waitFor((x) => x.patrons === 3, "three phones");
  });

  test("open mic: a free note only the host and its writer see", async () => {
    const { host, patrons } = await setupRoom(server, 2, { mode: "openmic" });
    const [p, q] = patrons;
    await p.ok("signUp", { name: "Ann", note: "I need a guitar stand", with: "The Bandmates" });
    const hv = await host.waitFor((x) => x.queue.length === 1);
    assert.equal(hv.settings.mode, "openmic");
    assert.equal(hv.queue[0].note, "I need a guitar stand");
    assert.equal(hv.queue[0].with, "The Bandmates");
    const pv = await p.waitFor((x) => x.queue.length === 1);
    assert.equal(pv.queue[0].note, "I need a guitar stand");
    const qv = await q.waitFor((x) => x.queue.length === 1);
    assert.equal(qv.queue[0].note, undefined, "other phones don't see the note");
    assert.equal(qv.history.length, 0, "patrons don't get the host's history");
    const tv = await server.client();
    await tv.ok("joinRoom", { code: hv.code, role: "table" });
    const tvv = await tv.waitFor((x) => x.queue.length === 1);
    assert.equal(tvv.queue[0].note, undefined, "the TV doesn't show the note");
  });

});

describe("signup rate limit", () => {
  let server;
  before(async () => (server = await startServer({ SIGNUPS_PER_MINUTE_PER_IP: "5" })));
  after(async () => server.stop());

  test("signups are rate limited per IP", async () => {
    const { code } = await setupRoom(server, 0);
    const results = [];
    for (let i = 0; i < 6; i++) {
      const c = await server.client();
      await c.ok("joinRoom", { code, role: "patron", device: newDevice() });
      results.push(await c.emit("signUp", { name: `P${i}`, song: "Song" }));
    }
    assert.deepEqual(
      results.map((r) => r.ok),
      [true, true, true, true, true, false],
    );
    assert.match(results[5].error, /too many/i);
  });
});

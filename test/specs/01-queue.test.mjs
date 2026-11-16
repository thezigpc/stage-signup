// The list: signing up, the order, now on, next, done, skip, move to end, drag to reorder,
// put back, New night, and the estimated wait.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { estimatedWait } from "@signup/shared";
import { startServer, lineOf } from "../harness.mjs";

describe("the list", () => {
  let server, token;
  before(async () => {
    server = await startServer();
    token = await server.staff();
  });
  after(async () => server.stop());

  const song = (name, s = "Song") => ({ name, song: s, artist: "Artist" });
  const run = (action, body) => server.run(token, "main", action, body);
  const ok = async (action, body) => {
    const r = await run(action, body);
    assert.equal(r.ok, true, `${action}: ${r.error}`);
    return r;
  };
  const fresh = async () => ok("new-night");

  test("patrons sign up in order; the host brings them up one by one", async () => {
    await fresh();
    const host = await server.runner("main", { token });
    const [ann, bo, cy] = [await server.patron(), await server.patron(), await server.patron()];
    assert.equal(ann.state.stage.id, "main", "one stage: no picking");
    await ann.ok("signUp", song("Ann", "Valerie"));
    await bo.ok("signUp", song("Bo"));
    await cy.ok("signUp", song("Cy"));
    let v = await host.waitFor((x) => x.queue.length === 3, "three in line");
    assert.deepEqual(lineOf(v), ["Ann", "Bo", "Cy"]);
    assert.equal(v.queue[0].song, "Valerie");

    await ok("next");
    v = await host.waitFor((x) => x.now?.name === "Ann", "Ann up");
    assert.equal(v.now.turn, 1);
    assert.deepEqual(lineOf(v), ["Bo", "Cy"]);
    const annView = await ann.waitFor((x) => x.mine[0]?.status === "up", "Ann sees she's up");
    assert.equal(annView.now.mine, true);

    await ok("next");
    v = await host.waitFor((x) => x.now?.name === "Bo", "Bo up");
    assert.equal(v.history[0].name, "Ann");
    assert.equal(v.history[0].status, "done");

    await ok("done");
    v = await host.waitFor((x) => x.now === null && x.history.length === 2, "stage empty");
    assert.equal((await run("done")).ok, false, "nobody on stage");

    await ok("next");
    await ok("next");
    v = await host.waitFor((x) => x.now === null && x.queue.length === 0, "all done");
    assert.equal(v.turns, 3);
    const empty = await run("next");
    assert.equal(empty.ok, false);
    assert.equal(empty.status, 400);
    assert.match(empty.error, /waiting/);
  });

  test("drag to reorder, move to end, now on, skip and put back", async () => {
    await fresh();
    const host = await server.runner("main", { token });
    for (const n of ["A", "B", "C", "D"]) await ok("add", song(n));
    let v = await host.waitFor((x) => x.queue.length === 4);
    const ids = Object.fromEntries(v.queue.map((e) => [e.name, e.id]));
    const id = (n) => ids[n];

    await ok("move", { entryId: id("D"), toIndex: 0 });
    await host.waitFor((x) => lineOf(x).join() === "D,A,B,C", "D first");
    await ok("move", { entryId: id("D"), toIndex: 99 });
    await host.waitFor((x) => lineOf(x).join() === "A,B,C,D", "past the end clamps");
    await ok("move", { entryId: id("A"), toIndex: 2 });
    await host.waitFor((x) => lineOf(x).join() === "B,C,A,D", "A to third");
    assert.equal((await run("move", { entryId: id("A"), toIndex: 1.5 })).ok, false, "not an index");

    await ok("to-end", { entryId: id("B") });
    await host.waitFor((x) => lineOf(x).join() === "C,A,D,B", "B to the end");

    await ok("now-on", { entryId: id("D") });
    v = await host.waitFor((x) => x.now?.name === "D", "D on");
    assert.deepEqual(lineOf(v), ["C", "A", "B"]);
    await ok("now-on", { entryId: id("A") });
    v = await host.waitFor((x) => x.now?.name === "A", "A on");
    assert.equal(v.history.find((e) => e.name === "D").status, "done");

    await ok("to-end", { entryId: id("A") });
    await host.waitFor((x) => x.now === null && lineOf(x).join() === "C,B,A", "A back in line");

    await ok("skip", { entryId: id("B") });
    v = await host.waitFor((x) => lineOf(x).join() === "C,A", "B skipped");
    assert.equal(v.history.find((e) => e.name === "B").status, "skipped");
    await ok("next");
    await ok("skip", { entryId: id("C") });
    await host.waitFor((x) => x.now === null && x.history.find((e) => e.name === "C")?.status === "skipped", "C skipped");
    assert.equal((await run("skip", { entryId: id("C") })).ok, false, "already out of line");
    assert.equal((await run("now-on", { entryId: id("C") })).ok, false, "not waiting");

    await ok("restore", { entryId: id("B") });
    await host.waitFor((x) => lineOf(x).join() === "A,B", "B back");
    assert.equal((await run("restore", { entryId: id("A") })).ok, false, "already waiting");
    assert.equal((await run("fly")).status, 404, "unknown action");
    assert.equal((await server.run(token, "nope", "next")).status, 404, "unknown stage");
  });

  test("walk-ups by hand, editing, the message and pausing; patrons can't run the list", async () => {
    await fresh();
    const host = await server.runner("main", { token });
    const p = await server.patron();
    const { entryId } = await ok("add", { name: "Grandma Jo" });
    await ok("edit", { entryId, name: "Grandma Jo", song: "Jolene", artist: "Dolly Parton", with: "Sam" });
    let v = await host.waitFor((x) => x.queue[0]?.song === "Jolene", "edited");
    assert.equal(v.queue[0].byHost, true);
    assert.equal((await run("add", { name: "   " })).ok, false, "a name is required");

    await ok("message", { message: "  10 minute   break " });
    await ok("signups", { open: false });
    const pv = await p.waitFor((x) => !x.live.signupsOpen && x.live.message, "paused with a message");
    assert.equal(pv.live.message, "10 minute break");
    assert.match(pv.gate.reason, /paused/i);

    // A patron's socket has no run intents, and the run API needs staff or a guest.
    for (const [action, body] of [["next"], ["signups", { open: true }], ["new-night"], ["add", { name: "X" }]]) {
      const r = await server.run(undefined, "main", action, body);
      assert.equal(r.status, 401, action);
    }
    assert.equal((await server.http("/api/run/me")).status, 401);
    await ok("signups", { open: true });
    v = await host.waitFor((x) => x.live.signupsOpen);
  });

  test("New night clears the list, the history, the counts and the message", async () => {
    await fresh();
    const host = await server.runner("main", { token });
    const p = await server.patron();
    await p.ok("signUp", song("Ann"));
    await ok("next");
    await ok("add", song("Walk-in"));
    await ok("message", { message: "Last call" });
    await ok("signups", { open: false });
    const before = (await host.waitFor((x) => x.turns === 1 && x.queue.length === 1)).nightStartedAt;
    await ok("new-night");
    const v = await host.waitFor((x) => x.turns === 0 && x.queue.length === 0 && x.now === null, "cleared");
    assert.equal(v.history.length, 0);
    assert.equal(v.live.message, "");
    assert.equal(v.live.signupsOpen, true);
    assert.ok(v.nightStartedAt >= before);
    const pv = await p.waitFor((x) => x.mine.length === 0 && x.gate.ok, "the phone can sign up again");
    assert.equal(pv.turns, 0);
  });

  test("text is trimmed and capped; a karaoke signup needs a song", async () => {
    await fresh();
    const host = await server.runner("main", { token });
    const p = await server.patron();
    const noSong = await p.emit("signUp", { name: "Ann" });
    assert.equal(noSong.ok, false);
    assert.match(noSong.error, /song/i);
    await p.ok("signUp", { name: `  ${"N".repeat(80)}  `, song: "S\n\n  x", artist: 42 });
    const v = await host.waitFor((x) => x.queue.length === 1);
    assert.equal(v.queue[0].name.length, 30);
    assert.equal(v.queue[0].song, "S x");
    assert.equal(v.queue[0].artist, undefined);
  });

  test("estimated wait", () => {
    const now = 1_000_000_000;
    assert.equal(estimatedWait(1, 5, undefined, now), 1, "nobody up: next, about a minute");
    assert.equal(estimatedWait(3, 5, undefined, now), 10);
    assert.equal(estimatedWait(1, 5, now - 2 * 60_000, now), 3, "3 minutes left of the current turn");
    assert.equal(estimatedWait(2, 5, now - 2 * 60_000, now), 8);
    assert.equal(estimatedWait(1, 5, now - 20 * 60_000, now), 1, "an overrunning turn counts a minute");
  });
});

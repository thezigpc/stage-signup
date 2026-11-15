// The queue: signing up, the order, now on, next, done, skip, move to end, drag to reorder,
// put back, and the estimated wait.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { estimatedWait } from "@signup/shared";
import { startServer, setupRoom, lineOf } from "../harness.mjs";

describe("the queue", () => {
  let server;
  before(async () => (server = await startServer()));
  after(async () => server.stop());

  const song = (name, s = "Song") => ({ name, song: s, artist: "Artist" });

  test("patrons sign up in order; the host brings them up one by one", async () => {
    const { host, patrons } = await setupRoom(server, 3);
    const [ann, bo, cy] = patrons;
    await ann.ok("signUp", song("Ann", "Valerie"));
    await bo.ok("signUp", song("Bo"));
    await cy.ok("signUp", song("Cy"));
    const s = await host.waitFor((v) => v.queue.length === 3, "three in line");
    assert.deepEqual(lineOf(s), ["Ann", "Bo", "Cy"]);
    assert.equal(s.now, null);
    assert.equal(s.queue[0].song, "Valerie");

    await host.ok("nextPerformer");
    let v = await host.waitFor((x) => x.now?.name === "Ann", "Ann up");
    assert.equal(v.now.turn, 1);
    assert.equal(v.turns, 1);
    assert.deepEqual(lineOf(v), ["Bo", "Cy"]);
    const annView = await ann.waitFor((x) => x.mine[0]?.status === "up", "Ann sees she's up");
    assert.equal(annView.now.mine, true);

    await host.ok("nextPerformer");
    v = await host.waitFor((x) => x.now?.name === "Bo", "Bo up");
    assert.equal(v.history[0].name, "Ann");
    assert.equal(v.history[0].status, "done");

    // Done: the stage stays empty.
    await host.ok("finishCurrent");
    v = await host.waitFor((x) => x.now === null && x.history.length === 2, "stage empty");
    assert.deepEqual(lineOf(v), ["Cy"]);
    const nobody = await host.emit("finishCurrent");
    assert.equal(nobody.ok, false, "nobody on stage");

    await host.ok("nextPerformer");
    await host.ok("nextPerformer");
    v = await host.waitFor((x) => x.now === null && x.queue.length === 0, "all done");
    assert.equal(v.turns, 3);
    const empty = await host.emit("nextPerformer");
    assert.equal(empty.ok, false);
    assert.match(empty.error, /waiting/);
  });

  test("drag to reorder, move to end, now on, skip and put back", async () => {
    const { host } = await setupRoom(server, 0);
    for (const n of ["A", "B", "C", "D"]) await host.ok("addEntry", song(n));
    let v = await host.waitFor((x) => x.queue.length === 4);
    const ids = Object.fromEntries(v.queue.map((e) => [e.name, e.id]));
    const id = (name) => ids[name];

    await host.ok("moveEntry", { entryId: id("D"), toIndex: 0 });
    v = await host.waitFor((x) => lineOf(x).join() === "D,A,B,C", "D first");
    await host.ok("moveEntry", { entryId: id("D"), toIndex: 99 });
    v = await host.waitFor((x) => lineOf(x).join() === "A,B,C,D", "past the end clamps");
    await host.ok("moveEntry", { entryId: id("A"), toIndex: 2 });
    v = await host.waitFor((x) => lineOf(x).join() === "B,C,A,D", "A to third");
    assert.equal((await host.emit("moveEntry", { entryId: id("A"), toIndex: 1.5 })).ok, false, "not an index");

    await host.ok("moveToEnd", id("B"));
    v = await host.waitFor((x) => lineOf(x).join() === "C,A,D,B", "B to the end");

    // Now on: out of order. Then again: the first one is done.
    await host.ok("nowOn", id("D"));
    v = await host.waitFor((x) => x.now?.name === "D", "D on");
    assert.deepEqual(lineOf(v), ["C", "A", "B"]);
    await host.ok("nowOn", id("A"));
    v = await host.waitFor((x) => x.now?.name === "A", "A on");
    assert.equal(v.history.find((e) => e.name === "D").status, "done");

    // The performer on stage back in line, at the end.
    await host.ok("moveToEnd", id("A"));
    v = await host.waitFor((x) => x.now === null && lineOf(x).join() === "C,B,A", "A back in line");

    // Skip a waiting one, and the one on stage.
    await host.ok("skipEntry", id("B"));
    v = await host.waitFor((x) => lineOf(x).join() === "C,A", "B skipped");
    assert.equal(v.history.find((e) => e.name === "B").status, "skipped");
    await host.ok("nextPerformer");
    await host.ok("skipEntry", id("C"));
    v = await host.waitFor((x) => x.now === null && x.history.find((e) => e.name === "C")?.status === "skipped", "C skipped");
    assert.equal((await host.emit("skipEntry", id("C"))).ok, false, "already out of line");
    assert.equal((await host.emit("nowOn", id("C"))).ok, false, "not waiting");

    // Put back: at the end of the line.
    await host.ok("restoreEntry", id("B"));
    v = await host.waitFor((x) => lineOf(x).join() === "A,B", "B back");
    assert.equal((await host.emit("restoreEntry", id("A"))).ok, false, "already waiting");
  });

  test("the host adds and edits by hand; patrons can't run the list", async () => {
    const { host, patrons } = await setupRoom(server, 1);
    const [p] = patrons;
    // A name alone is fine for the host (the song can come later).
    const { entryId } = await host.ok("addEntry", { name: "Grandma Jo" });
    await host.ok("editEntry", { entryId, name: "Grandma Jo", song: "Jolene", artist: "Dolly Parton", with: "Sam" });
    const v = await host.waitFor((x) => x.queue[0]?.song === "Jolene", "edited");
    assert.equal(v.queue[0].byHost, true);
    assert.equal(v.queue[0].with, "Sam");
    assert.equal((await host.emit("addEntry", { name: "   " })).ok, false, "a name is required");

    for (const ev of ["nextPerformer", "finishCurrent"]) assert.equal((await p.emit(ev)).ok, false, ev);
    for (const ev of ["skipEntry", "moveToEnd", "nowOn", "restoreEntry"]) assert.equal((await p.emit(ev, entryId)).ok, false, ev);
    assert.equal((await p.emit("moveEntry", { entryId, toIndex: 0 })).ok, false);
    assert.equal((await p.emit("addEntry", { name: "X" })).ok, false);
    assert.equal((await p.emit("setSignupsOpen", false)).ok, false);
    assert.equal((await p.emit("closeRoom")).ok, false);
    assert.equal((await host.emit("signUp", song("Host"))).ok, false, "the host isn't a patron");
  });

  test("text is trimmed and capped; a karaoke signup needs a song", async () => {
    const { host, patrons } = await setupRoom(server, 1);
    const [p] = patrons;
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

// Co-hosts (the kit's HostSeats): single-use invites, what a co-host may do, removing one,
// reconnecting, and closing the list.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { startServer, setupRoom, newDevice } from "../harness.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("co-hosts and the host seat", () => {
  let server;
  before(async () => (server = await startServer()));
  after(async () => server.stop());

  test("a co-host invite works once; a co-host runs the list but can't close it", async () => {
    const { code, host, patrons } = await setupRoom(server, 1);
    await patrons[0].ok("signUp", { name: "Ann", song: "S" });
    const inv = await host.ok("cohostInvite");
    const token = new URL(inv.path, "http://x").searchParams.get("cohost");
    assert.ok(Date.parse(inv.expiresAt) > Date.now());

    const co = await server.client();
    const seat = await co.ok("joinRoom", { code, role: "patron", cohost: token, name: "Cora", device: newDevice() });
    assert.equal(seat.role, "cohost");
    const reuse = await (await server.client()).emit("joinRoom", { code, role: "patron", cohost: token, name: "Eve" });
    assert.equal(reuse.ok, false, "single use");
    assert.match(reuse.error, /expired|used/);

    // Runs the list...
    await co.ok("nextPerformer");
    await co.ok("setSignupsOpen", false);
    await co.ok("addEntry", { name: "Walk-in" });
    // ...but can't close it or invite more.
    assert.equal((await co.emit("closeRoom")).ok, false);
    assert.equal((await co.emit("cohostInvite")).ok, false);
    const hv = await host.waitFor((x) => x.cohosts.length === 1 && x.now?.name === "Ann");
    assert.equal(hv.cohosts[0].name, "Cora");
    const cv = await co.waitFor((x) => x.you.role === "cohost");
    assert.deepEqual(cv.cohosts, [], "only the host sees the co-host list");
    assert.equal(cv.mine.length, 0);

    // Removed: a patron again, with a notice.
    let notice = null;
    co.socket.on("notice", (n) => (notice = n.message));
    await host.ok("removeCohost", seat.memberId);
    await co.waitFor((x) => x.you.role === "patron", "patron again");
    await sleep(50);
    assert.match(notice, /not a co-host/);
    assert.equal((await co.emit("nextPerformer")).ok, false);
    assert.equal((await host.emit("removeCohost", seat.memberId)).ok, false, "not a co-host any more");
  });

  test("reconnect: resume keeps the seat; a bad token doesn't", async () => {
    const { code, host, patrons } = await setupRoom(server, 1);
    await patrons[0].ok("signUp", { name: "Ann", song: "S" });
    const again = await server.client();
    const r = await again.ok("resume", { code, token: patrons[0].token });
    assert.equal(r.memberId, patrons[0].memberId);
    const v = await again.waitFor((x) => x.mine.length === 1);
    assert.equal(v.mine[0].name, "Ann");
    const bad = await (await server.client()).emit("resume", { code, token: "nope" });
    assert.equal(bad.ok, false);
    assert.equal((await (await server.client()).emit("resume", { code, token: "" })).ok, false, "an empty token");  });

  test("closing the list: everyone is told; a patron leaving keeps their place", async () => {
    const { code, host, patrons } = await setupRoom(server, 2);
    await patrons[0].ok("signUp", { name: "Ann", song: "S" });
    await patrons[0].ok("leaveRoom");
    const v = await host.waitFor((x) => x.queue.length === 1);
    assert.equal(v.queue[0].name, "Ann", "leaving the page isn't dropping out");
    const tv = await server.client();
    await tv.ok("joinRoom", { code, role: "table" });
    await host.ok("closeRoom");
    await sleep(100);
    assert.match(patrons[1].closedReason, /closed/);
    assert.match(tv.closedReason, /closed/);
    const gone = await (await server.client()).emit("joinRoom", { code, role: "patron" });
    assert.equal(gone.ok, false);
  });

  test("unknown rooms and bad requests", async () => {
    const c = await server.client();
    assert.equal((await c.emit("joinRoom", { code: "QQQQ", role: "patron" })).ok, false);
    assert.equal((await c.emit("roomInfo", { code: "QQQQ" })).ok, false);
    assert.equal((await c.emit("signUp", { name: "x", song: "y" })).ok, false, "not in a room");
    const { code } = await setupRoom(server, 0);
    assert.equal((await c.emit("joinRoom", { code, role: "host" })).ok, false, "can't join as host");
    const info = await c.ok("roomInfo", { code });
    assert.equal(info.mode, "karaoke");
  });
});

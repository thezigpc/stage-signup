// Stages (staff only): the default stage, adding, renaming, turning off, ordering, removing;
// patrons and TVs follow; tonight's lists survive a restart; the admin login.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer, sleep } from "../harness.mjs";

describe("stages", () => {
  let server, token;
  before(async () => {
    server = await startServer();
    token = await server.staff();
  });
  after(async () => server.stop());

  const admin = (p, init = {}) => server.http(`/api/admin${p}`, { ...init, token });

  test("a fresh install has one stage; the stages admin is staff only", async () => {
    const r = await admin("/stages");
    assert.equal(r.stages.length, 1);
    assert.deepEqual(
      { ...r.stages[0] },
      { id: "main", name: "Main stage", enabled: true, mode: "karaoke", oneActive: true, maxPerNight: 0, minutesPerTurn: 5, tvNextCount: 5 },
    );
    assert.equal((await server.http("/api/admin/stages")).status, 401);
    assert.equal((await server.http("/api/admin/stages", { body: { name: "X" } })).status, 401);
    const pub = await server.http("/api/stages");
    assert.deepEqual(pub.stages, [{ id: "main", name: "Main stage", mode: "karaoke" }]);
  });

  test("add, rename, order, turn off and remove; patrons and TVs follow", async () => {
    let r = await admin("/stages", { body: { name: "Back Room" } });
    assert.equal(r.stages[1].id, "back-room");
    r = await admin("/stages", { body: { name: "Back Room" } });
    assert.equal(r.stages[2].id, "back-room-2", "ids stay unique");
    await admin("/stages/back-room-2", { method: "DELETE" });
    assert.equal((await admin("/stages", { body: { name: "  " } })).status, 400);

    // Each stage has its own list.
    const back = await server.patron("back-room");
    const main = await server.patron("main");
    await back.ok("signUp", { name: "Ann", song: "S" });
    await main.waitFor((x) => x.stage.id === "main");
    assert.equal(main.state.queue.length, 0, "the main stage's list is separate");
    const backTv = await server.tv("back-room");
    assert.equal(backTv.state.queue.length, 1);
    const pub = await server.http("/api/stages");
    assert.deepEqual(
      pub.stages.map((s) => s.id),
      ["main", "back-room"],
    );

    // Order.
    await admin("/stage-order", { method: "PUT", body: { ids: ["back-room", "main"] } });
    assert.deepEqual(
      (await server.http("/api/stages")).stages.map((s) => s.id),
      ["back-room", "main"],
    );
    const tvDefault = await server.tv("");
    assert.equal(tvDefault.state.stage.id, "back-room", "no ?stage=: the first stage that's on");

    // Rename and settings: the views follow.
    await admin("/stages/back-room", { method: "PUT", body: { name: "Patio", mode: "openmic", tvNextCount: 3 } });
    await backTv.waitFor((x) => x.stage.name === "Patio" && x.stage.mode === "openmic" && x.config.tvNextCount === 3, "TV follows");
    assert.equal((await admin("/stages/back-room", { method: "PUT", body: { name: "" } })).status, 400, "a stage needs a name");

    // Turned off: patrons are told; signups refused; it leaves the public list.
    await admin("/stages/back-room", { method: "PUT", body: { enabled: false } });
    await sleep(100);
    assert.match(back.goneReason, /isn't taking signups/);
    assert.match(backTv.goneReason, /isn't taking signups/);
    assert.deepEqual(
      (await server.http("/api/stages")).stages.map((s) => s.id),
      ["main"],
    );
    const late = await server.client();
    assert.equal((await late.emit("watch", { stage: "back-room", role: "patron", device: "testdevice-late1" })).ok, false);
    const tvFallback = await server.tv("back-room");
    assert.equal(tvFallback.state.stage.id, "main", "a TV on a stage that's off shows the first one on");
    // A runner can still see it (to run it or turn it back on).
    const host = await server.runner("back-room", { token });
    assert.equal(host.state.stage.enabled, false);
    assert.equal(host.state.queue.length, 1);

    // Removed: its list goes.
    await admin("/stages/back-room", { method: "DELETE" });
    await sleep(100);
    assert.match(host.goneReason, /removed/);
    assert.equal((await admin("/stages/main", { method: "DELETE" })).status, 400, "the last stage stays");
  });

  test("bad values fall back; unknown fields are dropped", async () => {
    const r = await admin("/stages/main", { method: "PUT", body: { maxPerNight: 99, minutesPerTurn: 0, mode: "disco", id: "hacked", secret: 1 } });
    const main = r.stages.find((s) => s.id === "main");
    assert.equal(main.maxPerNight, 0);
    assert.equal(main.minutesPerTurn, 5);
    assert.equal(main.mode, "karaoke");
    assert.equal("secret" in main, false);
  });
});

describe("tonight's lists survive a restart", () => {
  test("stages and the queue come back after SIGTERM", async () => {
    let server = await startServer();
    const token = await server.staff();
    await server.http("/api/admin/stages", { body: { name: "Patio" }, token });
    const p = await server.patron("patio");
    await p.ok("signUp", { name: "Ann", song: "Valerie" });
    await server.run(token, "patio", "add", { name: "Bo", song: "S" });
    await server.run(token, "patio", "next");
    await server.run(token, "patio", "message", { message: "Back soon" });
    await sleep(150);
    const dataDir = server.dataDir;
    await server.stop({ keepData: true });

    server = await startServer({}, { dataDir });
    try {
      const tv = await server.tv("patio");
      assert.equal(tv.state.now.name, "Ann");
      assert.deepEqual(
        tv.state.queue.map((e) => e.name),
        ["Bo"],
      );
      assert.equal(tv.state.live.message, "Back soon");
      assert.equal(tv.state.turns, 1);
      // The same phone is still Ann.
      const again = await server.patron("patio", p.device);
      assert.equal(again.state.now.mine, true);
    } finally {
      await server.stop();
    }
  });

  test("0.1.0's data dir (admin.json, settings.json, no stages) starts with one stage", async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "signup-test-"));
    writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify({ roomIdleMinutes: 240 }));
    writeFileSync(path.join(dataDir, "tonight.json"), "{ not json");
    const server = await startServer({}, { dataDir });
    try {
      const r = await server.http("/api/stages");
      assert.deepEqual(
        r.stages.map((s) => s.id),
        ["main"],
      );
      const tv = await server.tv();
      assert.equal(tv.state.queue.length, 0, "a damaged list file is ignored");
    } finally {
      await server.stop();
    }
  });
});

describe("admin login", () => {
  let server;
  before(async () => (server = await startServer({ ADMIN_PASSWORD: "" })));
  after(async () => server.stop());

  test("setup once, sign in, health and config", async () => {
    assert.equal((await server.http("/api/admin/status")).setupNeeded, true);
    assert.equal((await server.http("/api/admin/setup", { body: { password: "correct horse" } })).status, 200);
    assert.ok((await server.http("/api/admin/setup", { body: { password: "another" } })).status >= 400, "only once");
    assert.ok((await server.http("/api/admin/login", { body: { password: "wrong" } })).status >= 400);
    const { token } = await server.http("/api/admin/login", { body: { password: "correct horse" } });
    assert.ok(token);
    const me = await server.http("/api/run/me", { token });
    assert.equal(me.kind, "staff");
    assert.equal(me.canAddCohosts, false);
    assert.equal((await server.http("/health")).ok, true);
    assert.deepEqual(await (await fetch(`${server.url}/api/config`)).json(), { gameName: "Stage Signup" });
  });
});

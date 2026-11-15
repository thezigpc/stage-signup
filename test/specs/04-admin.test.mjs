// The standalone admin: first-run setup, sign in, the list of rooms, closing one, settings.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { startServer, setupRoom } from "../harness.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("admin", () => {
  let server;
  before(async () => (server = await startServer()));
  after(async () => server.stop());

  const api = async (path, { token, method = "GET", body } = {}) => {
    const res = await fetch(`${server.url}/api/admin${path}`, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  test("setup once, sign in, overview, close a room, settings", async () => {
    let s = await api("/status");
    assert.equal(s.body.setupNeeded, true);
    assert.equal((await api("/overview")).status, 401, "signed out");

    const setup = await api("/setup", { method: "POST", body: { password: "correct horse" } });
    assert.equal(setup.status, 200);
    assert.equal((await api("/setup", { method: "POST", body: { password: "another" } })).status >= 400, true, "only once");
    assert.equal((await api("/login", { method: "POST", body: { password: "wrong" } })).status >= 400, true);
    const login = await api("/login", { method: "POST", body: { password: "correct horse" } });
    const token = login.body.token;
    assert.ok(token);

    const { code, host, patrons } = await setupRoom(server, 1, { title: "Friday Karaoke" });
    await patrons[0].ok("signUp", { name: "Ann", song: "S" });
    await host.ok("nextPerformer");
    const o = await api("/overview", { token });
    const row = o.body.rooms.find((r) => r.code === code);
    assert.equal(row.title, "Friday Karaoke");
    assert.equal(row.now, "Ann");
    assert.equal(row.patrons, 1);
    assert.equal(row.turns, 1);
    assert.equal(row.hostConnected, true);
    assert.equal(o.body.settings.roomIdleMinutes, 360);

    assert.equal((await api(`/rooms/${code}/close`, { token, method: "POST" })).status, 200);
    await sleep(100);
    assert.match(host.closedReason, /administrator/);
    assert.equal((await api(`/rooms/${code}/close`, { token, method: "POST" })).status, 404);

    assert.equal((await api("/settings", { token, method: "PUT", body: { roomIdleMinutes: 2 } })).status, 400);
    const saved = await api("/settings", { token, method: "PUT", body: { roomIdleMinutes: 240 } });
    assert.equal(saved.body.settings.roomIdleMinutes, 240);
  });

  test("health and config", async () => {
    assert.equal((await (await fetch(`${server.url}/health`)).json()).ok, true);
    assert.deepEqual(await (await fetch(`${server.url}/api/config`)).json(), { gameName: "Stage Signup" });
  });
});

describe("admin password from the environment", () => {
  let server;
  before(async () => (server = await startServer({ ADMIN_PASSWORD: "from-env" })));
  after(async () => server.stop());

  test("ADMIN_PASSWORD signs in; no setup", async () => {
    const res = await fetch(`${server.url}/api/admin/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "from-env" }),
    });
    assert.equal(res.status, 200);
  });
});

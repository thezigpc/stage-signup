// Bar Games: standalone is a plain web app, and on a (fake) box the commands, status,
// events and hosting from the box work.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startServer, setupRoom, newDevice } from "../harness.mjs";

const TOKEN = "test-token";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A fake box core: serves the venue context, records every event, checks the venue password. */
async function fakeCore() {
  const events = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return void res.writeHead(401).end();
      if (req.url === "/internal/events") {
        events.push(JSON.parse(body));
        return void res.writeHead(204).end();
      }
      if (req.url === "/internal/venue-password") {
        const b = JSON.parse(body);
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ ok: b.password === "box-password" }));
      }
      if (req.url === "/internal/venue") {
        res.writeHead(200, { "content-type": "application/json" });
        const theme = { colors: { background: "#0b2a2a", surface: "#12403f", text: "#f2fffd", primary: "#ff4fa3", accent: "#ffd23f" } };
        return void res.end(
          JSON.stringify({
            protocol: 1,
            venue: { name: "Test Bar", theme },
            game: { id: "signup", displayName: "Karaoke at Test Bar", theme },
            standalone: false,
            generatedAt: new Date().toISOString(),
          }),
        );
      }
      res.writeHead(404).end();
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${srv.address().port}`,
    events,
    of: (type, code) => events.filter((e) => e.type === type && (!code || e.roomCode === code)),
    async waitFor(pred, label, ms = 5000) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const hit = events.find(pred);
        if (hit) return hit;
        await sleep(25);
      }
      throw new Error(`no event: ${label}; got ${JSON.stringify(events.map((e) => e.type))}`);
    },
    close: () => new Promise((r) => srv.close(r)),
  };
}

describe("standalone (no BG_* env)", () => {
  let server;
  before(async () => (server = await startServer({ GAME_NAME: "" })));
  after(async () => server.stop());

  test("/api/config keeps the app's own name; venue.json says standalone", async () => {
    assert.deepEqual(await (await fetch(`${server.url}/api/config`)).json(), { gameName: "Stage Signup" });
    const venue = await (await fetch(`${server.url}/__bargames/venue.json`)).json();
    assert.equal(venue.standalone, true);
  });

  test("box endpoints are closed and no events go anywhere", async () => {
    const res = await fetch(`${server.url}/__bargames/command`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ command: "create_room", args: {} }),
    });
    assert.ok(res.status >= 400);
    const status = await fetch(`${server.url}/__bargames/status`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.ok(status.status >= 400);
    // The list works as a plain web app.
    const { host, patrons } = await setupRoom(server, 1);
    await patrons[0].ok("signUp", { name: "Ann", song: "S" });
    await host.ok("nextPerformer");
  });

  test("a spoofed gateway staff header doesn't sign anyone in", async () => {
    const res = await fetch(`${server.url}/api/admin/status`, { headers: { "x-bargames-via": "1", "x-bargames-staff": "1" } });
    const s = await res.json();
    assert.notEqual(s.trusted, true);
  });
});

describe("on a box", () => {
  let server, core;
  before(async () => {
    core = await fakeCore();
    server = await startServer({ BG_GAME_ID: "signup", BG_CORE_URL: core.url, BG_GAME_TOKEN: TOKEN });
  });
  after(async () => {
    await server.stop();
    await core.close();
  });

  const command = async (command, roomCode, args, token = TOKEN) => {
    const res = await fetch(`${server.url}/__bargames/command`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ command, roomCode, args }),
    });
    return { status: res.status, ...(await res.json()) };
  };
  const status = async () =>
    (await (await fetch(`${server.url}/__bargames/status`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()).rooms;

  test("name comes from the venue; the token is never served or logged", async () => {
    assert.deepEqual(await (await fetch(`${server.url}/api/config`)).json(), { gameName: "Karaoke at Test Bar" });
    const venue = await (await fetch(`${server.url}/__bargames/venue.json`)).text();
    assert.equal(JSON.parse(venue).standalone, false);
    assert.ok(!venue.includes(TOKEN));
    assert.ok(!server.output.includes(TOKEN));
  });

  test("commands need the token", async () => {
    assert.equal((await command("next_round", "ABCD", undefined, "wrong")).status, 401);
  });

  test("next_round: good room, unknown room, nobody waiting", async () => {
    const { code, host, patrons } = await setupRoom(server, 2);
    const empty = await command("next_round", code);
    assert.equal(empty.ok, false, "nobody waiting");
    assert.match(empty.message, /waiting/);
    await patrons[0].ok("signUp", { name: "Ann", song: "S" });
    await patrons[1].ok("signUp", { name: "Bo", song: "S" });
    const ok = await command("next_round", code);
    assert.equal(ok.ok, true, ok.message);
    await host.waitFor((s) => s.now?.name === "Ann", "Ann up");
    assert.equal((await command("next_round", code)).ok, true);
    await host.waitFor((s) => s.now?.name === "Bo", "Bo up");
    // The last one off: the stage is empty.
    assert.equal((await command("next_round", code)).ok, true);
    await host.waitFor((s) => s.now === null && s.turns === 2, "stage empty");
    assert.equal((await command("next_round", "QQQQ")).ok, false, "unknown room");
  });

  test("status and end", async () => {
    const { code, host, patrons } = await setupRoom(server, 2, { title: "Friday" });
    await patrons[0].ok("signUp", { name: "Ann", song: "S" });
    const tv = await server.client();
    await tv.ok("joinRoom", { code, role: "table" });
    const mine = (await status()).find((r) => r.code === code);
    assert.deepEqual(
      { ...mine, createdAt: undefined, lastActivityAt: undefined },
      {
        code,
        kind: "patron",
        players: 2,
        phase: "open",
        round: 0,
        title: "Friday · Stage empty · 1 waiting",
        hostConnected: true,
        hostName: "Host",
        tables: 1,
        maxPlayers: 500,
        createdAt: undefined,
        lastActivityAt: undefined,
        joinPath: `/join/${code}`,
      },
    );
    await host.ok("setSignupsOpen", false);
    assert.equal((await status()).find((r) => r.code === code).phase, "paused");

    assert.equal((await command("end", code)).ok, true);
    await sleep(100);
    assert.equal(host.closedReason, "The host closed tonight's list.");
    assert.equal(tv.closedReason, "The host closed tonight's list.");
    assert.equal((await command("end", code)).ok, false, "already gone");
    await core.waitFor((e) => e.type === "room_closed" && e.roomCode === code && e.data.reason === "host", "room_closed");
    assert.equal((await status()).some((r) => r.code === code), false, "gone from status");
  });

  test("events: created, players, added, next, round started and ended", async () => {
    const { code, host, patrons } = await setupRoom(server, 1);
    await core.waitFor((e) => e.type === "room_created" && e.roomCode === code, "room_created");
    await core.waitFor((e) => e.type === "players_changed" && e.roomCode === code, "players_changed", 6000);
    await patrons[0].ok("signUp", { name: "Ann", song: "Valerie", artist: "Amy Winehouse", with: "Bo", note: "secret" });
    await host.ok("addEntry", { name: "Walk-in" });
    const added = await core.waitFor((e) => e.type === "x-signup-added" && e.roomCode === code, "added");
    assert.deepEqual(added.data, { name: "Ann", waiting: 1, byHost: false });
    assert.equal(added.sessionKind, "patron");
    await host.ok("nextPerformer");
    const next = await core.waitFor((e) => e.type === "x-signup-next" && e.roomCode === code, "next");
    assert.deepEqual(next.data, { round: 1, name: "Ann", song: "Valerie", artist: "Amy Winehouse", with: "Bo", mode: "karaoke", waiting: 1 });
    assert.ok(!JSON.stringify(core.events).includes("secret"), "notes never leave the room");
    const started = await core.waitFor((e) => e.type === "round_started" && e.roomCode === code, "round_started");
    assert.deepEqual(started.data, { round: 1, name: "Ann" });
    await host.ok("nextPerformer");
    const ended = await core.waitFor((e) => e.type === "round_ended" && e.roomCode === code, "round_ended");
    assert.deepEqual(ended.data, { round: 1, name: "Ann", result: "done" });
    await host.ok("skipEntry", host.state.now.id);
    await core.waitFor((e) => e.type === "round_ended" && e.roomCode === code && e.data.result === "skipped", "skipped");
  });

  test("create_room: a venue room with no host phone; hostUrl opens the host seat", async () => {
    const created = await command("create_room", undefined, { kind: "venue", title: "Karaoke Night" });
    assert.equal(created.ok, true, created.message);
    const { roomCode: code, hostUrl } = created.data;
    assert.match(code, /^[A-Z]{4}$/);
    const ev = await core.waitFor((e) => e.type === "room_created" && e.roomCode === code, "room_created");
    assert.equal(ev.sessionKind, "venue");
    const mine = (await status()).find((r) => r.code === code);
    assert.equal(mine.kind, "venue");
    assert.equal(mine.hostConnected, false);
    assert.match(mine.title, /^Karaoke Night · /);

    const tv = await server.client();
    assert.equal((await tv.ok("joinRoom", { code, role: "table" })).role, "table");
    const ann = await server.client();
    assert.equal((await ann.ok("joinRoom", { code, role: "patron", device: newDevice() })).role, "patron");
    await ann.ok("signUp", { name: "Ann", song: "S" });
    assert.equal((await command("next_round", code)).ok, true);
    await tv.waitFor((s) => s.now?.name === "Ann", "TV shows Ann");

    const url = new URL(hostUrl, server.url);
    assert.equal(url.pathname, `/join/${code}`);
    const ipad = await server.client();
    const seat = await ipad.ok("resume", { code, token: url.searchParams.get("host") });
    assert.equal(seat.role, "host");
    assert.notEqual(seat.token, url.searchParams.get("host"), "the phone keeps the seat's own token");
    await ipad.ok("finishCurrent");

    assert.equal((await command("end", code)).ok, true);
    await sleep(100);
    assert.equal(tv.closedReason, "The host closed tonight's list.");
  });

  test("firstJoinerHosts: the first phone hosts; once anyone holds the seat, the next is a patron", async () => {
    const created = await command("create_room", undefined, { kind: "venue", firstJoinerHosts: true });
    const code = created.data.roomCode;
    const tv = await server.client();
    assert.equal((await tv.ok("joinRoom", { code, role: "table" })).role, "table", "the TV isn't the host");
    const cat = await server.client();
    const first = await cat.ok("joinRoom", { code, role: "patron", device: newDevice() });
    assert.equal(first.role, "host");
    await cat.ok("setSignupsOpen", false);
    const dan = await server.client();
    assert.equal((await dan.ok("joinRoom", { code, role: "patron", device: newDevice() })).role, "patron");

    // Staff open the host link before anyone joins: the offer closes.
    const other = await command("create_room", undefined, { kind: "venue", firstJoinerHosts: true });
    const staff = await server.client();
    const key = new URL(other.data.hostUrl, server.url).searchParams.get("host");
    assert.equal((await staff.ok("resume", { code: other.data.roomCode, token: key })).role, "host");
    const eve = await server.client();
    assert.equal((await eve.ok("joinRoom", { code: other.data.roomCode, role: "patron", device: newDevice() })).role, "patron");
    await command("end", code);
    await command("end", other.data.roomCode);
  });

  test("host_link: staff take over; the old host stays on as a co-host", async () => {
    const { code, host } = await setupRoom(server, 0);
    let notice = null;
    host.socket.on("notice", (n) => (notice = n.message));
    const r = await command("host_link", code);
    assert.equal(r.ok, true, r.message);
    const url = new URL(r.data.url, server.url);
    assert.equal(url.pathname, `/join/${code}`);
    await host.waitFor((s) => s.you.role === "cohost", "old host is a co-host");
    await sleep(50);
    assert.match(notice, /took over/);
    await host.ok("addEntry", { name: "Still runs it" });
    assert.equal((await host.emit("closeRoom")).ok, false, "but can't close it");

    const staff = await server.client();
    const seat = await staff.ok("resume", { code, token: url.searchParams.get("host") });
    assert.equal(seat.role, "host");
    const hv = await staff.waitFor((s) => s.cohosts.length === 1);
    assert.equal(hv.cohosts[0].name, "Host");
    // A second take-over gives a new link; the old one stops working.
    const r2 = await command("host_link", code);
    assert.notEqual(r2.data.url, r.data.url);
    const stale = await (await server.client()).emit("resume", { code, token: url.searchParams.get("host") });
    assert.equal(stale.ok, false);
    assert.equal((await command("host_link", "QQQQ")).ok, false);
  });

  test("cohost_link and remove_cohost", async () => {
    const { code, host } = await setupRoom(server, 0);
    const inv = await command("cohost_link", code, { minutes: 5 });
    assert.equal(inv.ok, true, inv.message);
    const left = Date.parse(inv.data.expiresAt) - Date.now();
    assert.ok(left > 4 * 60_000 && left <= 5 * 60_000 + 1000, "expires in 5 minutes");
    const token = new URL(inv.data.url, server.url).searchParams.get("cohost");
    const co = await server.client();
    const seat = await co.ok("joinRoom", { code, role: "patron", cohost: token, name: "Cora" });
    assert.equal(seat.role, "cohost");
    assert.equal((await (await server.client()).emit("joinRoom", { code, role: "patron", cohost: token, name: "X" })).ok, false, "single use");

    assert.equal((await command("remove_cohost", code, { memberId: "nobody" })).ok, false);
    const rm = await command("remove_cohost", code, { memberId: seat.memberId });
    assert.equal(rm.ok, true, rm.message);
    await co.waitFor((s) => s.you.role === "patron", "a patron again");
    await host.waitFor((s) => s.cohosts.length === 0);
  });

  test("the venue's admin password opens this admin", async () => {
    const login = (password) =>
      fetch(`${server.url}/api/admin/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
    const st = await (await fetch(`${server.url}/api/admin/status`)).json();
    assert.equal(st.venueLogin, true);
    assert.equal((await login("box-password")).status, 200);
    assert.notEqual((await login("nope")).status, 200);
  });
});

describe("venue room idle close", () => {
  let server, core;
  before(async () => {
    core = await fakeCore();
    server = await startServer({
      BG_GAME_ID: "signup",
      BG_CORE_URL: core.url,
      BG_GAME_TOKEN: TOKEN,
      ROOM_SWEEP_INTERVAL_MS: "200",
    });
    // The shortest idle time the admin allows is 5 minutes; tests fake an old room instead.
  });
  after(async () => {
    await server.stop();
    await core.close();
  });

  test("status lists a venue room while its TV is connected", async () => {
    const res = await fetch(`${server.url}/__bargames/command`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ command: "create_room", args: { kind: "venue" } }),
    });
    const code = (await res.json()).data.roomCode;
    const tv = await server.client();
    await tv.ok("joinRoom", { code, role: "table" });
    await sleep(500);
    const rooms = (await (await fetch(`${server.url}/__bargames/status`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()).rooms;
    const mine = rooms.find((r) => r.code === code);
    assert.equal(mine.tables, 1);
  });
});

// Bar Games: standalone is a plain web app (guest headers mean nothing), and on a (fake) box
// guest hosts and co-hosts run the list but never the setup, co-host links go through the
// box, and the stage events go out.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startServer, sleep } from "../harness.mjs";

const TOKEN = "test-token";

/** The gateway's headers for a guest from a guest link. */
const guest = (id, role = "host", name = "Dana") => ({
  "x-bargames-via": "1",
  "x-bargames-guest": id,
  "x-bargames-guest-role": role,
  "x-bargames-guest-name": encodeURIComponent(name),
});
const boxStaff = { "x-bargames-via": "1", "x-bargames-staff": "1" };

/** A fake box core: venue context, events, the venue password, and guest links. */
async function fakeCore() {
  const events = [];
  const links = [];
  let allowCohosts = true;
  let seq = 0;
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const json = (status, v) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(v));
      };
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return void res.writeHead(401).end();
      if (req.url === "/internal/events") {
        events.push(JSON.parse(body));
        return void res.writeHead(204).end();
      }
      if (req.url === "/internal/venue-password") return json(200, { ok: JSON.parse(body).password === "box-password" });
      if (req.url === "/internal/guests" && req.method === "GET") return json(200, links);
      if (req.url === "/internal/guests/cohost" && req.method === "POST") {
        const b = JSON.parse(body);
        if (!allowCohosts) return json(403, { error: "The venue hasn't turned on co-hosts for Stage Signup." });
        const link = {
          id: `co${++seq}`,
          label: b.label,
          role: "cohost",
          parentId: b.guestId,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        };
        links.push(link);
        return json(200, { ...link, url: `https://play.example.net/__bargames/guest/${link.id}?k=secret` });
      }
      const del = req.url.match(/^\/internal\/guests\/(.+)$/);
      if (del && req.method === "DELETE") {
        const i = links.findIndex((l) => l.id === decodeURIComponent(del[1]));
        if (i < 0) return void res.writeHead(404).end();
        links.splice(i, 1);
        return void res.writeHead(204).end();
      }
      if (req.url === "/internal/venue") {
        const theme = { colors: { background: "#0b2a2a", surface: "#12403f", text: "#f2fffd", primary: "#ff4fa3", accent: "#ffd23f" } };
        return json(200, {
          protocol: 1,
          venue: { name: "Test Bar", theme },
          game: { id: "signup", displayName: "Karaoke at Test Bar", theme },
          standalone: false,
          generatedAt: new Date().toISOString(),
        });
      }
      res.writeHead(404).end();
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${srv.address().port}`,
    events,
    links,
    set allowCohosts(v) {
      allowCohosts = v;
    },
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

  test("venue.json says standalone; the app's own name", async () => {
    assert.deepEqual(await (await fetch(`${server.url}/api/config`)).json(), { gameName: "Stage Signup" });
    const venue = await (await fetch(`${server.url}/__bargames/venue.json`)).json();
    assert.equal(venue.standalone, true);
  });

  test("spoofed guest or staff headers get nobody in", async () => {
    assert.equal((await server.http("/api/run/me", { headers: guest("g1") })).status, 401);
    assert.equal((await server.run(undefined, "main", "next", {}, guest("g1"))).status, 401);
    assert.equal((await server.run(undefined, "main", "new-night", {}, boxStaff)).status, 401);
    assert.notEqual((await server.http("/api/admin/status", { headers: boxStaff })).trusted, true);
    // The app password still works.
    const token = await server.staff();
    assert.equal((await server.run(token, "main", "new-night")).ok, true);
    assert.equal((await server.http("/api/run/cohosts", { token })).status, 403, "co-hosts are a box thing");
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

  test("name comes from the venue; the token is never served or logged", async () => {
    assert.deepEqual(await (await fetch(`${server.url}/api/config`)).json(), { gameName: "Karaoke at Test Bar" });
    const venue = await (await fetch(`${server.url}/__bargames/venue.json`)).text();
    assert.equal(JSON.parse(venue).standalone, false);
    assert.ok(!venue.includes(TOKEN));
    assert.ok(!server.output.includes(TOKEN));
  });

  test("a guest host runs the list, but never the setup", async () => {
    const g = guest("g-host", "host", "Dana – karaoke");
    const me = await server.http("/api/run/me", { headers: g });
    assert.equal(me.kind, "guest");
    assert.deepEqual(me.guest, { id: "g-host", role: "host", name: "Dana – karaoke" });
    assert.equal(me.canAddCohosts, true);

    const host = await server.runner("main", { headers: g });
    const p = await server.patron();
    await p.ok("signUp", { name: "Ann", song: "Valerie" });
    for (const [action, body] of [["add", { name: "Walk-up" }], ["next"], ["signups", { open: false }], ["message", { message: "Break" }], ["signups", { open: true }]]) {
      const r = await server.run(undefined, "main", action, body, g);
      assert.equal(r.ok, true, `${action}: ${r.error}`);
    }
    await host.waitFor((x) => x.now?.name === "Ann" && x.live.message === "Break", "guest's changes");
    assert.equal((await server.run(undefined, "main", "new-night", {}, g)).ok, true, "New night is the guest's too");

    // The setup is staff only.
    assert.equal((await server.http("/api/admin/stages", { headers: g })).status, 401);
    assert.equal((await server.http("/api/admin/stages/main", { method: "PUT", body: { name: "Mine" }, headers: g })).status, 401);
    assert.equal((await server.http("/api/admin/stages", { body: { name: "X" }, headers: g })).status, 401);
    assert.notEqual((await server.http("/api/admin/status", { headers: g })).trusted, true, "a guest isn't staff");

    // The link ended (closing time, staff turned it off): the next request has no guest.
    assert.equal((await server.run(undefined, "main", "next", {}, { "x-bargames-via": "1" })).status, 401);
  });

  test("a guest co-host runs the list but can't add anyone", async () => {
    const c = guest("g-co", "cohost", "Sam");
    const me = await server.http("/api/run/me", { headers: c });
    assert.equal(me.guest.role, "cohost");
    assert.equal(me.canAddCohosts, false);
    await server.run(undefined, "main", "new-night", {}, c);
    assert.equal((await server.run(undefined, "main", "add", { name: "Walk-up" }, c)).ok, true);
    assert.equal((await server.run(undefined, "main", "next", {}, c)).ok, true);
    assert.equal((await server.http("/api/run/cohosts", { body: { name: "X" }, headers: c })).status, 403);
    assert.equal((await server.http("/api/run/cohosts", { headers: c })).status, 403);
  });

  test("box staff run the list without the app password", async () => {
    assert.equal((await server.http("/api/run/me", { headers: boxStaff })).kind, "staff");
    assert.equal((await server.run(undefined, "main", "new-night", {}, boxStaff)).ok, true);
  });

  test("co-hosts: the box makes the link; refusals show as-is; a host sees and removes only their own", async () => {
    const dana = guest("g-dana", "host", "Dana");
    const lee = guest("g-lee", "host", "Lee");
    core.allowCohosts = false;
    const refused = await server.http("/api/run/cohosts", { body: { name: "Sam" }, headers: dana });
    assert.equal(refused.status, 400);
    assert.equal(refused.error, "The venue hasn't turned on co-hosts for Stage Signup.");

    core.allowCohosts = true;
    const made = await server.http("/api/run/cohosts", { body: { name: "  Sam  " }, headers: dana });
    assert.equal(made.ok, true, made.error);
    assert.match(made.url, /^https:\/\/play\.example\.net\/__bargames\/guest\//);
    assert.equal(made.label, "Sam");
    await server.http("/api/run/cohosts", { body: { name: "Kim" }, headers: lee });

    const danas = await server.http("/api/run/cohosts", { headers: dana });
    assert.deepEqual(
      danas.cohosts.map((c) => c.label),
      ["Sam"],
      "only Dana's co-hosts",
    );
    const kim = core.links.find((l) => l.label === "Kim");
    assert.equal((await server.http(`/api/run/cohosts/${kim.id}`, { method: "DELETE", headers: dana })).status, 404, "not Dana's");
    assert.equal((await server.http(`/api/run/cohosts/${made.id}`, { method: "DELETE", headers: dana })).ok, true);
    assert.equal(core.links.some((l) => l.id === made.id), false, "revoked on the box");
  });

  test("events: added, next, ended, paused, new night and N waiting; notes never leave", async () => {
    const token = await server.staff();
    await server.run(token, "main", "new-night");
    const p = await server.patron();
    await p.ok("signUp", { name: "Ann", song: "Valerie", artist: "Amy Winehouse", with: "Bo", note: "secret" });
    await server.run(token, "main", "add", { name: "Walk-in" });
    const added = await core.waitFor((e) => e.type === "x-signup-added" && e.data.name === "Ann" && e.data.waiting === 1 && !e.data.byHost, "added");
    assert.deepEqual(added.data, { stage: "main", name: "Ann", waiting: 1, byHost: false });
    assert.equal(added.roomCode, undefined, "an app has no rooms");
    await server.run(token, "main", "next");
    const next = await core.waitFor((e) => e.type === "x-signup-next" && e.data.with === "Bo", "next");
    assert.deepEqual(next.data, { stage: "main", round: 1, name: "Ann", song: "Valerie", artist: "Amy Winehouse", with: "Bo", mode: "karaoke", waiting: 1 });
    await server.run(token, "main", "next");
    const ended = await core.waitFor((e) => e.type === "x-signup-ended" && e.data.name === "Ann" && e.data.round === 1 && e.data.result === "done", "ended");
    assert.deepEqual(ended.data, { stage: "main", round: 1, name: "Ann", result: "done" });
    await server.run(token, "main", "signups", { open: false });
    assert.deepEqual((await core.waitFor((e) => e.type === "x-signup-paused", "paused")).data, { stage: "main", paused: true });
    await server.run(token, "main", "signups", { open: true });
    await server.run(token, "main", "new-night");
    await core.waitFor((e) => e.type === "x-signup-new-night", "new night");
    const waiting = await core.waitFor((e) => e.type === "x-signup-waiting", "waiting", 6000);
    assert.deepEqual(Object.keys(waiting.data).sort(), ["stage", "waiting"], "content-free");
    assert.ok(!JSON.stringify(core.events).includes("secret"), "the note never leaves the app");
  });

  test("the venue's admin password opens this admin", async () => {
    const st = await server.http("/api/admin/status");
    assert.equal(st.venueLogin, true);
    assert.equal((await server.http("/api/admin/login", { body: { password: "box-password" } })).status, 200);
    assert.notEqual((await server.http("/api/admin/login", { body: { password: "nope" } })).status, 200);
  });
});

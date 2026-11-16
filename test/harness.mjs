// Test harness: every spec file gets its own throwaway server on its own port.
// Specs talk to it over real sockets, exactly like the client does.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { io } from "socket.io-client";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

/**
 * A server on a free port. Throwaway data dir per server, unless `opts.dataDir` reuses one
 * (a restart). ADMIN_PASSWORD is "pw" so specs can run the list as staff.
 */
export async function startServer(env = {}, opts = {}) {
  const port = await freePort();
  const dataDir = opts.dataDir ?? mkdtempSync(path.join(os.tmpdir(), "signup-test-"));
  const proc = spawn(process.execPath, [path.join(root, "server/dist/index.js")], {
    env: { ...process.env, PORT: String(port), LOG_LEVEL: "warn", CLIENT_DIST_PATH: path.join(root, "nonexistent"), DATA_DIR: dataDir, ADMIN_PASSWORD: "pw", SAVE_DELAY_MS: "50", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  proc.stdout.on("data", (d) => (output += d));
  proc.stderr.on("data", (d) => (output += d));
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  const clients = [];
  return {
    url,
    dataDir,
    proc,
    port,
    get output() {
      return output;
    },
    async client(headers) {
      const c = await connect(url, headers);
      clients.push(c);
      return c;
    },
    /** `keepData`: leave the data dir for a restart. */
    async stop({ keepData = false } = {}) {
      for (const c of clients) c.socket.close();
      const exited = new Promise((r) => proc.once("exit", r));
      proc.kill("SIGTERM");
      await exited;
      if (!keepData) rmSync(dataDir, { recursive: true, force: true });
    },
    /** JSON over HTTP; returns { status, ...body }. */
    async http(p, { method, body, token, headers = {} } = {}) {
      const res = await fetch(url + p, {
        method: method ?? (body !== undefined ? "POST" : "GET"),
        headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, ...(await res.json().catch(() => ({}))) };
    },
    /** A staff session (the app password, "pw"). */
    async staff() {
      const r = await this.http("/api/admin/login", { body: { password: "pw" } });
      if (!r.token) throw new Error("login failed: " + JSON.stringify(r));
      return r.token;
    },
    /** Runs a list action as staff (or with `headers` as a guest). */
    run(token, stage, action, body = {}, headers) {
      return this.http(`/api/run/${stage}/${action}`, { body, token, headers });
    },
    /** A phone watching a stage as a patron (its own device id). */
    async patron(stage = "", device = newDevice()) {
      const c = await this.client();
      c.device = device;
      const r = await c.ok("watch", { stage, role: "patron", device });
      c.stage = r.stage;
      await c.waitFor((s) => s.stage.id === r.stage, "first view");
      return c;
    },
    /** A TV watching a stage. */
    async tv(stage = "") {
      const c = await this.client();
      const r = await c.ok("watch", { stage, role: "tv" });
      c.stage = r.stage;
      await c.waitFor((s) => s.stage.id === r.stage, "first view");
      return c;
    },
    /** A host page: a runner socket holding a lease (staff token, or guest headers). */
    async runner(stage = "main", { token, headers } = {}) {
      const c = await this.client(headers);
      await c.ok("watch", { stage, role: "runner" });
      const lease = await this.http("/api/run/lease", { body: { stage, socketId: c.socket.id }, token, headers });
      if (lease.status !== 200) throw new Error("lease refused: " + JSON.stringify(lease));
      await c.waitFor((s) => s.role === "runner", "runner view");
      return c;
    },
  };
}

/** A socket wrapper that remembers the latest state and lets specs await conditions. */
export async function connect(url, headers = {}) {
  const socket = io(url, { transports: ["websocket"], reconnection: false, forceNew: true, extraHeaders: headers });
  const c = {
    socket,
    state: null,
    closedReason: null,
    waiters: [],
    emit(event, ...args) {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`ack timeout: ${event}`)), 5000);
        socket.emit(event, ...args, (res) => {
          clearTimeout(t);
          resolve(res);
        });
      });
    },
    /** Emits and asserts ok, returning the ack payload. */
    async ok(event, ...args) {
      const res = await c.emit(event, ...args);
      if (!res?.ok) throw new Error(`${event} failed: ${res?.error}`);
      return res;
    },
    waitFor(pred, label = "condition", ms = 5000) {
      if (c.state && pred(c.state)) return Promise.resolve(c.state);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        c.waiters.push(w);
        setTimeout(() => {
          c.waiters = c.waiters.filter((x) => x !== w);
          reject(new Error(`timed out waiting for ${label}; last state: ${JSON.stringify(c.state)?.slice(0, 500)}`));
        }, ms);
      });
    },
  };
  socket.on("state", (s) => {
    c.state = s;
    for (const w of [...c.waiters]) {
      if (w.pred(s)) {
        c.waiters = c.waiters.filter((x) => x !== w);
        w.resolve(s);
      }
    }
  });
  socket.on("gone", ({ reason }) => (c.goneReason = reason));
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  return c;
}

let deviceSeq = 0;
/** A fresh device id, as a phone's localStorage would hold. */
export const newDevice = () => `testdevice${Date.now().toString(36)}${(deviceSeq++).toString(36)}`;

/** Names in line, in order, from a view. */
export const lineOf = (s) => s.queue.map((e) => e.name);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));


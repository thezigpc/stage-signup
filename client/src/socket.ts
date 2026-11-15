import { io, type Socket } from "socket.io-client";
import { createCall, serverBase, serverOrigin, socketPath, SOCKET_OPTIONS } from "@bargames/gamekit/client";
import type { ClientToServerEvents, ServerToClientEvents } from "@signup/shared";

// In dev, Vite serves the client on :5181 while the server runs on :3011. In production the
// server serves the built client itself (one origin). Under a path prefix (a box's
// https://<venue>/signup/) `serverUrl` carries it; socket.io takes the bare origin plus a `path`.
const dev = { vitePort: 5181, serverPort: 3011 };
export const serverUrl = serverBase(dev);

// WebSocket first (the kit's SOCKET_OPTIONS): polling-first lost early emits through tunnels.
export const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(serverOrigin(dev), {
  ...SOCKET_OPTIONS,
  path: socketPath(),
});

const kitCall = createCall(socket as unknown as Parameters<typeof createCall>[0]);

/** Emit with an ack as a promise. Rejects with the server's error message. */
export function call<T = object>(event: keyof ClientToServerEvents, ...args: unknown[]): Promise<T> {
  return kitCall<T>(event, ...args);
}

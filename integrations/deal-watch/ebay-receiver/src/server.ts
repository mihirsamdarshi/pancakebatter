import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";
import type { Incoming, Outgoing } from "./receiver.ts";

// Section 3.2 caps. node:http in Bun enforces maxConnections and maxHeaderSize (checked on Bun
// 1.4.4) but ignores headersTimeout and requestTimeout, so the timers below are our own.
export const MAX_CONNECTIONS = 64;
export const MAX_HEADER_BYTES = 8 * 1024;
export const HEADER_TIMEOUT_MS = 5000;
export const BODY_TIMEOUT_MS = 5000;
export const IDLE_TIMEOUT_MS = 5000;

function bodyReader(req: IncomingMessage) {
  return (max: number): Promise<Buffer | "too-large" | "timeout"> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let done = false;
      const finish = (value: Buffer | "too-large" | "timeout") => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish("timeout"), BODY_TIMEOUT_MS);
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > max) {
          finish("too-large");
          req.destroy();
        } else chunks.push(chunk);
      });
      req.on("end", () => finish(Buffer.concat(chunks)));
      req.on("error", () => finish("timeout"));
      req.on("close", () => finish(size > 0 ? "timeout" : Buffer.alloc(0)));
    });
}

export function createCappedServer(handle: (req: Incoming) => Promise<Outgoing>): Server {
  const server = createServer({ maxHeaderSize: MAX_HEADER_BYTES, keepAlive: true }, (req, res) => {
    const timer = headerTimers.get(req.socket);
    if (timer) clearTimeout(timer);
    headerTimers.delete(req.socket);
    const incoming: Incoming = {
      method: req.method ?? "",
      target: req.url ?? "",
      header: (name) => {
        const v = req.headers[name.toLowerCase()];
        return Array.isArray(v) ? v[0] : v;
      },
      readBody: bodyReader(req),
    };
    res.on("close", () => armHeaderTimer(req.socket));
    handle(incoming)
      .catch((): Outgoing => ({ status: 500 }))
      .then((out) => {
        const headers = { ...(out.headers ?? {}), "content-length": String(Buffer.byteLength(out.body ?? "")) };
        // Close after any error status: the request body may be unread.
        if (out.status >= 400) (headers as Record<string, string>).connection = "close";
        res.writeHead(out.status, headers);
        res.end(out.body ?? "");
      });
  });
  const headerTimers = new WeakMap<Socket, ReturnType<typeof setTimeout>>();
  const armHeaderTimer = (socket: Socket) => {
    if (socket.destroyed) return;
    clearTimeout(headerTimers.get(socket));
    headerTimers.set(socket, setTimeout(() => socket.destroy(), HEADER_TIMEOUT_MS));
  };
  server.maxConnections = MAX_CONNECTIONS;
  server.on("connection", (socket: Socket) => {
    socket.setTimeout(IDLE_TIMEOUT_MS, () => socket.destroy());
    socket.on("error", () => {});
    armHeaderTimer(socket);
    socket.on("close", () => clearTimeout(headerTimers.get(socket)));
  });
  server.on("clientError", (_error, socket) => {
    // Oversized header, malformed request. No logging of the error: it can hold request text.
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    else socket.destroy();
  });
  return server;
}

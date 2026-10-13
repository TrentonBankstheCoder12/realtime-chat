// HTTP + WebSocket server. One Node http.Server serves the static client
// and upgrades `/ws` requests to WebSocket connections handled by `ws`.

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { LIMITS, parseClientMessage, type ClientMessage, type Member, type ServerMessage } from "./protocol.js";
import { RoomRegistry, type Room } from "./rooms.js";
import { TokenBucket } from "./tokenBucket.js";

export interface ChatServerOptions {
  /** Messages kept per room for late joiners. */
  historySize?: number;
  /** Token bucket: burst size and sustained frames/second per connection. */
  rateLimit?: { capacity: number; refillPerSecond: number };
  /** Close the socket after this many rate-limited frames in a row. */
  maxRateLimitStrikes?: number;
  heartbeatIntervalMs?: number;
  /** How long graceful shutdown waits for clients to close before terminating them. */
  shutdownTimeoutMs?: number;
  publicDir?: string;
  log?: (msg: string) => void;
}

const DEFAULTS = {
  historySize: 50,
  rateLimit: { capacity: 10, refillPerSecond: 2 },
  maxRateLimitStrikes: 20,
  heartbeatIntervalMs: 30_000,
  shutdownTimeoutMs: 5_000,
  publicDir: fileURLToPath(new URL("../public/", import.meta.url)),
  log: (msg: string) => console.log(msg),
};

/** Per-connection state. `member` stays a placeholder until the client says hello. */
interface Client {
  ws: WebSocket;
  member: Member;
  identified: boolean;
  rooms: Set<string>;
  bucket: TokenBucket;
  strikes: number;
  isAlive: boolean;
}

export interface ChatServer {
  http: Server;
  wss: WebSocketServer;
  listen(port?: number, host?: string): Promise<number>;
  close(): Promise<void>;
  readonly clientCount: number;
}

export function createChatServer(options: ChatServerOptions = {}): ChatServer {
  const opts = { ...DEFAULTS, ...options };
  const rooms = new RoomRegistry<Client>(opts.historySize);
  const clients = new Set<Client>();
  let shuttingDown = false;

  const http = createServer((req, res) => {
    void serveStatic(opts.publicDir, req, res);
  });

  // maxPayload makes ws reject oversized frames (close code 1009) before
  // they are buffered, so one client can't exhaust memory.
  const wss = new WebSocketServer({ server: http, path: "/ws", maxPayload: LIMITS.maxFrameBytes });

  // ------------------------------------------------------------ helpers

  function send(client: Client, msg: ServerMessage): void {
    if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(msg));
  }

  function broadcast(room: Room<Client>, msg: ServerMessage, except?: Client): void {
    const frame = JSON.stringify(msg); // serialize once, not once per member
    for (const member of room.members) {
      if (member !== except && member.ws.readyState === WebSocket.OPEN) member.ws.send(frame);
    }
  }

  function leaveRoom(client: Client, roomName: string): boolean {
    const room = rooms.leave(roomName, client);
    if (!room) return false;
    client.rooms.delete(roomName);
    broadcast(room, {
      type: "presence",
      room: roomName,
      event: "leave",
      member: client.member,
      members: rooms.members(room),
    });
    return true;
  }

  // ------------------------------------------------------------ message handling

  function handle(client: Client, msg: ClientMessage): void {
    // Handshake: nothing else is allowed until the client has a name.
    if (msg.type === "hello") {
      if (client.identified) {
        return send(client, { type: "error", code: "ALREADY_IDENTIFIED", message: "hello was already sent" });
      }
      client.member = { id: client.member.id, name: msg.name };
      client.identified = true;
      return send(client, { type: "welcome", you: client.member });
    }
    if (!client.identified) {
      return send(client, { type: "error", code: "NOT_IDENTIFIED", message: "Send hello first" });
    }

    switch (msg.type) {
      case "join": {
        const { room, added } = rooms.join(msg.room, client);
        client.rooms.add(msg.room);
        const members = rooms.members(room);
        // The joiner gets the snapshot; everyone else gets a presence delta.
        send(client, { type: "joined", room: msg.room, members, history: room.history.toArray() });
        if (added) broadcast(room, { type: "presence", room: msg.room, event: "join", member: client.member, members }, client);
        return;
      }
      case "leave": {
        if (!leaveRoom(client, msg.room)) return notInRoom(client, msg.room);
        return send(client, { type: "left", room: msg.room });
      }
      case "message": {
        const room = rooms.get(msg.room);
        if (!room || !room.members.has(client)) return notInRoom(client, msg.room);
        const message = { id: randomUUID(), room: msg.room, from: client.member, text: msg.text, ts: Date.now() };
        room.history.push(message);
        // Echo to the sender too: their copy carries the server id and timestamp.
        return broadcast(room, { type: "message", message });
      }
      case "typing": {
        const room = rooms.get(msg.room);
        if (!room || !room.members.has(client)) return notInRoom(client, msg.room);
        return broadcast(room, { type: "typing", room: msg.room, member: client.member, isTyping: msg.isTyping }, client);
      }
    }
  }

  function notInRoom(client: Client, room: string): void {
    send(client, { type: "error", code: "NOT_IN_ROOM", message: `You are not in room "${room}"` });
  }

  function onFrame(client: Client, data: RawData, isBinary: boolean): void {
    // Rate limit before parsing, so floods of garbage are cheap to reject.
    if (!client.bucket.tryRemove()) {
      client.strikes++;
      if (client.strikes >= opts.maxRateLimitStrikes) {
        client.ws.close(1008, "rate limit exceeded"); // 1008 = policy violation
        return;
      }
      return send(client, { type: "error", code: "RATE_LIMITED", message: "Too many messages; slow down" });
    }
    client.strikes = 0;

    if (isBinary) {
      return send(client, { type: "error", code: "INVALID_MESSAGE", message: "Binary frames are not supported" });
    }
    const parsed = parseClientMessage(data.toString());
    if (!parsed.ok) return send(client, parsed.error);
    handle(client, parsed.message);
  }

  // ------------------------------------------------------------ connections

  wss.on("connection", (ws) => {
    if (shuttingDown) {
      ws.close(1001, "server shutting down");
      return;
    }
    const client: Client = {
      ws,
      member: { id: randomUUID(), name: "" },
      identified: false,
      rooms: new Set(),
      bucket: new TokenBucket(opts.rateLimit.capacity, opts.rateLimit.refillPerSecond),
      strikes: 0,
      isAlive: true,
    };
    clients.add(client);

    ws.on("message", (data, isBinary) => onFrame(client, data, isBinary));
    ws.on("pong", () => {
      client.isAlive = true;
    });
    ws.on("close", () => {
      // Covers clean closes, crashes and heartbeat terminations alike:
      // presence is always cleaned up in exactly one place.
      for (const room of [...client.rooms]) leaveRoom(client, room);
      clients.delete(client);
    });
    ws.on("error", (err) => opts.log(`socket error: ${err.message}`));
  });

  // ------------------------------------------------------------ heartbeat
  // TCP can't tell a quiet client from a vanished one (laptop lid closed,
  // network dropped). Every interval we ping; a client that hasn't ponged
  // since the previous ping is presumed dead and terminated, which fires
  // `close` and removes it from presence lists.

  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.isAlive) {
        opts.log(`terminating unresponsive client ${client.member.id}`);
        client.ws.terminate();
        continue;
      }
      client.isAlive = false;
      client.ws.ping();
    }
  }, opts.heartbeatIntervalMs);
  heartbeat.unref(); // don't keep the process alive just for heartbeats

  // ------------------------------------------------------------ lifecycle

  return {
    http,
    wss,
    get clientCount() {
      return clients.size;
    },

    listen(port = 0, host = "127.0.0.1") {
      return new Promise((resolve, reject) => {
        http.once("error", reject);
        http.listen(port, host, () => {
          const addr = http.address();
          resolve(typeof addr === "object" && addr ? addr.port : port);
        });
      });
    },

    /**
     * Graceful shutdown: stop accepting, tell clients why, close each socket
     * with 1001 ("going away") so well-behaved clients can reconnect
     * elsewhere, and only force-terminate stragglers after a timeout.
     */
    async close() {
      if (shuttingDown) return;
      shuttingDown = true;
      clearInterval(heartbeat);

      const httpClosed = new Promise<void>((resolve) => http.close(() => resolve()));

      const socketsClosed = [...clients].map(
        (client) =>
          new Promise<void>((resolve) => {
            if (client.ws.readyState === WebSocket.CLOSED) return resolve();
            client.ws.once("close", () => resolve());
            send(client, { type: "shutdown", reason: "server restarting" });
            client.ws.close(1001, "server shutting down");
          }),
      );

      const timeout = setTimeout(() => {
        for (const client of clients) client.ws.terminate();
      }, opts.shutdownTimeoutMs);

      await Promise.all(socketsClosed);
      clearTimeout(timeout);
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await httpClosed;
    },
  };
}

// ---------------------------------------------------------------- static files

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

async function serveStatic(publicDir: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ status: "ok" }));
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }

  const pathname = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = normalize(join(publicDir, pathname));
  // Path traversal guard: the resolved path must stay inside publicDir.
  const root = publicDir.endsWith(sep) ? publicDir : publicDir + sep;
  const type = MIME[extname(filePath)];
  if (!filePath.startsWith(root) || !type) {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
    return;
  }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": type,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'self'; connect-src 'self' ws: wss:",
    });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
  }
}

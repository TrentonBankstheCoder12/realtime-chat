import { WebSocket, type ClientOptions } from "ws";
import { createChatServer, type ChatServer, type ChatServerOptions } from "../src/server.js";
import type { ServerMessage } from "../src/protocol.js";

export async function startServer(opts: ChatServerOptions = {}): Promise<{ server: ChatServer; url: string; port: number }> {
  const server = createChatServer({ log: () => {}, ...opts });
  const port = await server.listen(0); // 0 = ephemeral port chosen by the OS
  return { server, port, url: `ws://127.0.0.1:${port}/ws` };
}

/**
 * A real `ws` client that buffers incoming frames so tests can
 * `await next("type")` without racing the network.
 */
export class TestClient {
  readonly ws: WebSocket;
  private inbox: ServerMessage[] = [];
  private waiters: Array<{ match: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }> = [];
  readonly closed: Promise<{ code: number; reason: string }>;

  constructor(url: string, options?: ClientOptions) {
    this.ws = new WebSocket(url, options);
    this.ws.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as ServerMessage;
      const i = this.waiters.findIndex((w) => w.match(msg));
      if (i >= 0) this.waiters.splice(i, 1)[0].resolve(msg);
      else this.inbox.push(msg);
    });
    this.closed = new Promise((resolve) => {
      this.ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
  }

  static async connect(url: string, name?: string): Promise<TestClient> {
    const c = new TestClient(url);
    await new Promise<void>((resolve, reject) => {
      c.ws.once("open", () => resolve());
      c.ws.once("error", reject);
    });
    if (name) {
      c.send({ type: "hello", name });
      await c.next("welcome");
    }
    return c;
  }

  send(msg: unknown): void {
    this.ws.send(typeof msg === "string" ? msg : JSON.stringify(msg));
  }

  /** Resolve with the next frame of the given type (consuming it), or time out. */
  next<T extends ServerMessage["type"]>(type: T, timeoutMs = 1000): Promise<Extract<ServerMessage, { type: T }>> {
    const match = (m: ServerMessage) => m.type === type;
    const i = this.inbox.findIndex(match);
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0] as Extract<ServerMessage, { type: T }>);
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve: resolve as (m: ServerMessage) => void };
      this.waiters.push(waiter);
      setTimeout(() => {
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) {
          this.waiters.splice(idx, 1);
          reject(new Error(`timed out waiting for "${type}"`));
        }
      }, timeoutMs);
    });
  }

  /** Assert that no frame of this type arrives within `ms`. */
  async expectNone(type: ServerMessage["type"], ms = 150): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
    const found = this.inbox.find((m) => m.type === type);
    if (found) throw new Error(`unexpected "${type}" frame: ${JSON.stringify(found)}`);
  }

  async join(room: string) {
    this.send({ type: "join", room });
    return this.next("joined");
  }

  close(): void {
    this.ws.close();
  }
}

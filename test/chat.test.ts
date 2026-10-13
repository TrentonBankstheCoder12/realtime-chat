import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { ChatServer } from "../src/server.js";
import { startServer, TestClient } from "./helpers.js";

let server: ChatServer | undefined;
const clients: TestClient[] = [];

async function setup(opts: Parameters<typeof startServer>[0] = {}) {
  const started = await startServer(opts);
  server = started.server;
  const connect = async (name?: string) => {
    const c = await TestClient.connect(started.url, name);
    clients.push(c);
    return c;
  };
  return { ...started, connect };
}

afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await server?.close();
  server = undefined;
});

describe("handshake and rooms", () => {
  it("welcomes a client with a server-assigned id after hello", async () => {
    const { connect } = await setup();
    const c = await connect();
    c.send({ type: "hello", name: "  Alice  " });
    const welcome = await c.next("welcome");
    expect(welcome.you.name).toBe("Alice");
    expect(welcome.you.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("rejects room commands before hello", async () => {
    const { connect } = await setup();
    const c = await connect();
    c.send({ type: "join", room: "general" });
    expect((await c.next("error")).code).toBe("NOT_IDENTIFIED");
  });

  it("join returns the member list; others get a presence event", async () => {
    const { connect } = await setup();
    const alice = await connect("Alice");
    const bob = await connect("Bob");

    const aliceJoined = await alice.join("general");
    expect(aliceJoined.members.map((m) => m.name)).toEqual(["Alice"]);

    const bobJoined = await bob.join("general");
    expect(bobJoined.members.map((m) => m.name)).toEqual(["Alice", "Bob"]);

    const presence = await alice.next("presence");
    expect(presence).toMatchObject({ room: "general", event: "join", member: { name: "Bob" } });
    expect(presence.members.map((m) => m.name)).toEqual(["Alice", "Bob"]);
    await bob.expectNone("presence"); // the joiner gets `joined`, not its own presence event
  });

  it("joining the same room twice is idempotent", async () => {
    const { connect } = await setup();
    const alice = await connect("Alice");
    const bob = await connect("Bob");
    await alice.join("general");
    await bob.join("general");
    await alice.next("presence");
    const again = await bob.join("general");
    expect(again.members).toHaveLength(2);
    await alice.expectNone("presence");
  });

  it("leave and disconnect both update presence for remaining members", async () => {
    const { connect } = await setup();
    const alice = await connect("Alice");
    const bob = await connect("Bob");
    const carol = await connect("Carol");
    for (const c of [alice, bob, carol]) await c.join("general");

    bob.send({ type: "leave", room: "general" });
    await bob.next("left");
    let p = await alice.next("presence");
    while (p.event !== "leave") p = await alice.next("presence");
    expect(p.member.name).toBe("Bob");
    expect(p.members.map((m) => m.name)).toEqual(["Alice", "Carol"]);

    carol.close();
    p = await alice.next("presence");
    while (p.event !== "leave") p = await alice.next("presence");
    expect(p.member.name).toBe("Carol");
    expect(p.members.map((m) => m.name)).toEqual(["Alice"]);
  });
});

describe("messaging", () => {
  it("broadcasts to everyone in the room (including sender) and nobody outside it", async () => {
    const { connect } = await setup();
    const alice = await connect("Alice");
    const bob = await connect("Bob");
    const eve = await connect("Eve");
    await alice.join("general");
    await bob.join("general");
    await eve.join("random");

    alice.send({ type: "message", room: "general", text: "hello bob" });
    const [a, b] = await Promise.all([alice.next("message"), bob.next("message")]);
    expect(b.message).toMatchObject({ room: "general", text: "hello bob", from: { name: "Alice" } });
    expect(a.message.id).toBe(b.message.id); // same server-assigned id for everyone
    expect(typeof b.message.ts).toBe("number");
    await eve.expectNone("message");
  });

  it("cannot send to a room you haven't joined", async () => {
    const { connect } = await setup();
    const alice = await connect("Alice");
    alice.send({ type: "message", room: "general", text: "hi" });
    expect((await alice.next("error")).code).toBe("NOT_IN_ROOM");
  });

  it("relays typing indicators to others but not back to the typist", async () => {
    const { connect } = await setup();
    const alice = await connect("Alice");
    const bob = await connect("Bob");
    await alice.join("general");
    await bob.join("general");

    alice.send({ type: "typing", room: "general", isTyping: true });
    const t = await bob.next("typing");
    expect(t).toMatchObject({ room: "general", member: { name: "Alice" }, isTyping: true });
    await alice.expectNone("typing");
  });

  it("late joiners receive bounded history, oldest first", async () => {
    const { connect } = await setup({ historySize: 3, rateLimit: { capacity: 100, refillPerSecond: 100 } });
    const alice = await connect("Alice");
    await alice.join("general");
    for (let i = 1; i <= 5; i++) {
      alice.send({ type: "message", room: "general", text: `msg ${i}` });
      await alice.next("message");
    }
    const bob = await connect("Bob");
    const joined = await bob.join("general");
    expect(joined.history.map((m) => m.text)).toEqual(["msg 3", "msg 4", "msg 5"]);
  });

  it("history is dropped when a room empties", async () => {
    const { connect } = await setup();
    const alice = await connect("Alice");
    await alice.join("general");
    alice.send({ type: "message", room: "general", text: "secret" });
    await alice.next("message");
    alice.send({ type: "leave", room: "general" });
    await alice.next("left");
    expect((await alice.join("general")).history).toEqual([]);
  });
});

describe("validation and abuse protection", () => {
  it("rejects invalid JSON and schema violations without dropping the connection", async () => {
    const { connect } = await setup();
    const c = await connect("Alice");

    c.send("{not json");
    expect((await c.next("error")).code).toBe("INVALID_JSON");

    const cases = [
      { type: "teleport" },
      { type: "join", room: "Has Spaces" },
      { type: "message", room: "general", text: "" },
      { type: "message", room: "general", text: "x".repeat(2001) },
      { type: "typing", room: "general", isTyping: "yes" },
      { type: "join", room: "general", extra: true },
    ];
    for (const bad of cases) {
      c.send(bad);
      const err = await c.next("error");
      expect(err.code, JSON.stringify(bad)).toBe("INVALID_MESSAGE");
      expect(Array.isArray(err.details)).toBe(true);
    }

    // Still usable afterwards.
    expect((await c.join("general")).room).toBe("general");
  });

  it("rejects binary frames and a second hello", async () => {
    const { connect } = await setup();
    const c = await connect("Alice");
    c.ws.send(Buffer.from([1, 2, 3]), { binary: true });
    expect((await c.next("error")).code).toBe("INVALID_MESSAGE");
    c.send({ type: "hello", name: "Mallory" });
    expect((await c.next("error")).code).toBe("ALREADY_IDENTIFIED");
  });

  it("closes the connection with 1009 when a frame exceeds the size limit", async () => {
    const { connect } = await setup();
    const c = await connect("Alice");
    c.send({ type: "message", room: "general", text: "x".repeat(20_000) });
    expect((await c.closed).code).toBe(1009);
  });

  it("token bucket: allows a burst, then rate limits, then refills", async () => {
    const { connect } = await setup({ rateLimit: { capacity: 5, refillPerSecond: 10 } });
    const c = await connect("Alice"); // hello used 1 token
    await c.join("general"); // 2 used

    for (let i = 0; i < 6; i++) c.send({ type: "message", room: "general", text: `m${i}` });
    // 3 tokens remained, so 3 go through and 3 are rejected.
    for (let i = 0; i < 3; i++) expect((await c.next("message")).message.text).toBe(`m${i}`);
    for (let i = 0; i < 3; i++) expect((await c.next("error")).code).toBe("RATE_LIMITED");
    await c.expectNone("message", 50);

    await new Promise((r) => setTimeout(r, 250)); // ~2.5 tokens refill
    c.send({ type: "message", room: "general", text: "after refill" });
    expect((await c.next("message")).message.text).toBe("after refill");
  });

  it("disconnects a client that keeps flooding past the limit", async () => {
    const { connect } = await setup({ rateLimit: { capacity: 2, refillPerSecond: 0.1 }, maxRateLimitStrikes: 5 });
    const c = await connect("Alice");
    for (let i = 0; i < 20; i++) c.send({ type: "typing", room: "general", isTyping: true });
    const { code, reason } = await c.closed;
    expect(code).toBe(1008);
    expect(reason).toContain("rate limit");
  });
});

describe("heartbeat and shutdown", () => {
  it("terminates clients that stop answering pings and updates presence", async () => {
    const { url, connect } = await setup({ heartbeatIntervalMs: 50 });
    const alice = await connect("Alice");
    await alice.join("general");

    // A client with autoPong disabled behaves like a dead peer.
    const ghost = new TestClient(url, { autoPong: false });
    clients.push(ghost);
    await new Promise((r) => ghost.ws.once("open", r));
    ghost.send({ type: "hello", name: "Ghost" });
    await ghost.next("welcome");
    await ghost.join("general");
    await alice.next("presence");

    const p = await alice.next("presence", 2000);
    expect(p).toMatchObject({ event: "leave", member: { name: "Ghost" } });
    expect((await ghost.closed).code).toBe(1006); // abnormal: terminated, no close handshake

    // The responsive client survives several heartbeat rounds.
    await new Promise((r) => setTimeout(r, 200));
    expect(alice.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("graceful shutdown notifies clients and closes with 1001", async () => {
    const { connect, server: s } = await setup();
    const a = await connect("Alice");
    const b = await connect("Bob");
    expect(s.clientCount).toBe(2);

    const closing = s.close();
    expect((await a.next("shutdown")).reason).toBeTruthy();
    await b.next("shutdown");
    expect((await a.closed).code).toBe(1001);
    expect((await b.closed).code).toBe(1001);
    await closing;
    expect(s.clientCount).toBe(0);
    expect(s.http.listening).toBe(false);
  });

  it("serves the static client and blocks path traversal", async () => {
    const { port } = await setup();
    const index = await fetch(`http://127.0.0.1:${port}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toContain("text/html");
    expect(await index.text()).toContain("<title>Realtime Chat</title>");
    expect((await fetch(`http://127.0.0.1:${port}/client.js`)).status).toBe(200);
    // A real .js file one level above public/: must not be reachable.
    expect((await fetch(`http://127.0.0.1:${port}/..%2fnode_modules%2fws%2findex.js`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
  });
});

# Walkthrough: Realtime Chat

A guide to how this project works and why it was built this way. Read it top to bottom, then try to explain each section out loud without looking. That is roughly what an interviewer will ask you to do.

## 1. WebSockets in one paragraph

HTTP is request/response: the client must ask before the server can answer. A WebSocket starts as an HTTP `GET` with `Upgrade: websocket`; the server replies `101 Switching Protocols`, and from then on the same TCP connection carries **frames** in both directions at any time. That is what lets the server *push* a chat message (or a price tick) the instant it happens instead of the client polling.

In this project one `http.Server` does both jobs: normal requests get static files, and requests to `/ws` are upgraded by `new WebSocketServer({ server: http, path: "/ws" })`. Code: `createChatServer` in `src/server.ts`.

**Why `ws` and not socket.io?** socket.io adds its own protocol on top (event names, acks, fallbacks to long polling, auto-reconnect). That's convenient, but it hides exactly the things worth understanding: framing, heartbeats, close codes and message validation. Using `ws` means the protocol below is the whole protocol.

## 2. A typed, validated protocol

Every frame is JSON with a `type` field. Client frames are a **zod discriminated union** (`src/protocol.ts`): zod checks the `type`, then validates the rest of the fields for that type. `.strict()` rejects unknown fields. Room names must match `^[a-z0-9][a-z0-9-]{0,31}$`; text is trimmed and capped at 2000 chars.

Why validate at all, when you wrote the client? Because **anyone can open a WebSocket to your server** with any payload. TypeScript types disappear at runtime; the schema is the runtime check. And `z.infer` gives us the TypeScript type from the same schema, so the type and the check can't drift apart.

A bad frame gets an `error` frame (`INVALID_JSON` or `INVALID_MESSAGE` with per-field `details`), and the connection stays open. One malformed message shouldn't cost a user their session.

The handshake rule: until a client sends `hello` it can't do anything else (`NOT_IDENTIFIED`). The server assigns the member `id` (a UUID); clients only choose a display name, so two "Alice"s are still distinguishable.

## 3. Rooms, presence and broadcasting

`RoomRegistry` (`src/rooms.ts`) maps room name -> `{ members: Set<Client>, history: RingBuffer }`. It's generic over the client type so it has no dependency on `ws` and is easy to reason about.

- **Join:** the joiner gets a `joined` snapshot (sorted member list + history). Everyone else gets a `presence` *delta* (`event: "join"`) that also includes the full list, so clients can't get out of sync if they miss one. Joining twice is idempotent.
- **Leave / disconnect:** both go through one function, `leaveRoom`. The socket's `close` event fires for clean closes, crashes and heartbeat terminations alike, so presence is cleaned up in exactly one place.
- **Empty rooms are deleted**, which also drops their history. Rooms are free to create, so they must be free to forget, or memory grows forever.
- **Broadcast** serializes the message once and sends the same string to each member, instead of `JSON.stringify` per member.
- **Messages echo to the sender.** The server stamps an `id` and `ts`; the sender's copy is the authoritative one, so every client shows the same ordering and ids.
- **Typing** is relayed to others but not the typist. The client sends one `isTyping: true` per typing burst and `false` after 2 s idle; receivers also expire stale indicators after 5 s in case the `false` frame is lost.

## 4. Bounded history with a ring buffer

A late joiner should see recent context, but a busy room can't keep every message in memory. `RingBuffer` (`src/ringBuffer.ts`) is a fixed-size array with a `start` index and a `count`. When full, `push` overwrites the oldest slot and advances `start`. Both `push` and memory use are O(1)/bounded; there is no `array.shift()` (which is O(n)). A property-style test pushes random sequences and checks the buffer always equals the last N items.

## 5. Rate limiting with a token bucket

Each connection gets a `TokenBucket` (`src/tokenBucket.ts`): it holds up to `capacity` tokens (default 10) and refills at `refillPerSecond` (default 2). Each frame costs one token.

- **Why not a fixed window?** A token bucket allows natural bursts (pasting three lines) while enforcing a smooth long-run rate. A fixed window allows 2× the limit across a window boundary.
- **Lazy refill:** instead of a timer per connection, the bucket computes accrued tokens from elapsed time whenever it's checked. Zero background work for idle connections.
- **Order matters:** the rate check runs *before* JSON parsing, so a flood of garbage is rejected cheaply.
- **Escalation:** over-limit frames get `RATE_LIMITED`. A client that keeps flooding (20 rejected frames in a row by default) is disconnected with close code `1008` (policy violation).
- **Size cap:** `maxPayload: 16 KB` makes `ws` refuse oversized frames with `1009` *before* buffering them, so one client can't exhaust memory with a 1 GB frame.

The invariant test checks that over any random sequence of requests, accepted ≤ `capacity + rate × elapsed`.

## 6. Heartbeats: detecting dead connections

TCP can't tell a quiet client from one whose laptop lid closed or whose Wi-Fi dropped; the socket can look open for minutes. Without detection, ghost users stay in presence lists forever and their sockets leak.

The heartbeat (`src/server.ts`): every 30 s, for each client, if `isAlive` is false (no pong since the last ping) we `terminate()` it; otherwise we set `isAlive = false` and send a `ping`. Browsers answer pings automatically with a `pong`, which sets `isAlive = true`. Termination fires `close`, which removes the client from presence (section 3).

The test simulates a dead peer with a real `ws` client created with `autoPong: false`, sets the interval to 50 ms, and asserts the other user sees a `leave` presence event and the ghost gets close code `1006` (abnormal, no close handshake).

## 7. Graceful shutdown

On `SIGTERM` (what Kubernetes or a deploy sends) `server.close()`:

1. Stops accepting new connections (`http.close`; late arrivals are closed with `1001`).
2. Sends each client a `shutdown` frame so the UI can say why.
3. Closes each socket with `1001 Going Away`, the code that tells clients "reconnect, probably to another instance".
4. Waits for them to close, but force-`terminate()`s anyone still there after `shutdownTimeoutMs` (5 s), so a stuck client can't block a deploy.

A second Ctrl-C exits immediately. A test checks both clients receive `shutdown`, see `1001`, and the HTTP server stops listening.

## 8. The client and the static server

`public/client.js` is plain JavaScript with no build step. It renders all user text with `textContent`, never `innerHTML`, so a message like `<img onerror=…>` shows as text instead of running (XSS). The static server (`serveStatic`) normalizes the path and refuses anything that resolves outside `public/` (test: `/..%2fnode_modules%2fws%2findex.js` -> 404), only serves known file types, and sends `X-Content-Type-Options: nosniff` and a `Content-Security-Policy` that only allows same-origin scripts.

## 9. Known limitation (be ready to discuss this)

All state is **in one process's memory**. Run two instances behind a load balancer and Alice (on server A) can't see Bob's messages (on server B), and each server has its own presence list. The standard fix is a shared pub/sub layer: each server subscribes to a Redis channel per room and publishes messages to it, with presence kept in a Redis set with TTLs refreshed by heartbeats. Related: history is lost on restart, and the server doesn't handle **backpressure**: if a client reads slowly, `ws` buffers outgoing frames for it in memory without limit. Production code checks `ws.bufferedAmount` and drops or disconnects slow consumers. Identity is also just a self-chosen name; a real system authenticates the upgrade request.

## Likely interview questions

1. **How does a WebSocket differ from HTTP polling or SSE?** Persistent, full-duplex connection after an HTTP upgrade; no repeated request overhead. SSE is server-to-client only (section 1).
2. **How do you detect a client that disappeared without closing?** Application-level ping/pong heartbeat with a missed-pong timeout (section 6).
3. **How would you scale this horizontally?** Redis (or Kafka/NATS) pub/sub per room, shared presence with TTLs, sticky sessions optional (section 9).
4. **Why a token bucket?** Allows bursts but caps sustained rate; lazy refill costs nothing when idle (section 5).
5. **Why validate messages if you wrote the client?** Anyone can connect with any payload; types vanish at runtime (section 2).
6. **What happens to in-flight users on deploy?** Graceful shutdown with `1001`, a notice frame, and a forced timeout; clients reconnect (section 7).
7. **How would you guarantee message ordering and no duplicates on reconnect?** Server-assigned ids/timestamps (or per-room sequence numbers); clients resume from the last seen sequence and dedupe by id.

## Try extending it

- Add a per-room monotonically increasing `seq` and a `resume` frame that replays messages after a given `seq`
- Add a `bufferedAmount` check in `broadcast` and disconnect slow consumers
- Require a JWT in the upgrade request (`wss.on("upgrade")` / `verifyClient`) and take the name from its claims
- Add direct messages (`{ type: "dm", to: memberId, text }`)
- Add reconnect with exponential backoff and jitter to `client.js`

# Realtime Chat

[![CI](https://github.com/TrentonBankstheCoder12/realtime-chat/actions/workflows/ci.yml/badge.svg)](https://github.com/TrentonBankstheCoder12/realtime-chat/actions/workflows/ci.yml)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/node-22%2B-339933?logo=nodedotjs&logoColor=white)
![WebSocket](https://img.shields.io/badge/WebSocket-ws-010101)
![Vitest](https://img.shields.io/badge/tested_with-vitest-6E9F18?logo=vitest&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-green)

A **realtime chat server built directly on WebSockets** with the `ws` library, so every frame of the protocol is visible and explained instead of hidden behind socket.io. The same building blocks power live price tickers, order-status updates and customer-support chat in trading and banking apps: rooms (pub/sub topics), presence, a typed message protocol validated at the edge, per-connection rate limiting, heartbeats that detect dead connections, and graceful shutdown for zero-drama deploys. A small vanilla HTML/JS client is served by the same process.

## Features

- **Rooms** created on demand and deleted when empty; join, leave, multi-room per connection
- **Presence:** sorted member list on join, plus `join` / `leave` deltas to everyone else (including when a client crashes)
- **Typing indicators** relayed to the room, never echoed back to the typist
- **Message history:** last N messages per room in an O(1) ring buffer, delivered to late joiners
- **Typed JSON protocol** as a zod discriminated union; bad frames get a structured `error` frame, not a dropped socket
- **Token-bucket rate limiting** per connection (bursts OK, sustained floods rejected, persistent flooders disconnected with `1008`)
- **Frame size cap** (16 KB) enforced by `ws` before buffering (`1009`)
- **Heartbeat:** ping every 30 s; clients that don't pong are terminated and removed from presence
- **Graceful shutdown** on SIGINT/SIGTERM: `shutdown` frame, close `1001`, force-terminate stragglers after a timeout
- **Static client** with path-traversal protection and a CSP header; all chat text rendered with `textContent` (no XSS)

## Architecture

```
  Browser (public/client.js)                 Node process
 ┌──────────────────────────┐   HTTP GET   ┌─────────────────────────────────────────┐
 │ index.html / style.css   │ ───────────▶ │ http.Server  (serveStatic)              │
 │                          │              │      │ upgrade /ws                      │
 │ WebSocket  ──── JSON ────┼────────────▶ │ WebSocketServer (ws, maxPayload 16KB)   │
 └──────────────────────────┘              │      │ per connection                   │
                                           │      ▼                                  │
                                           │ TokenBucket.tryRemove()  -> RATE_LIMITED│
                                           │      ▼                                  │
                                           │ parseClientMessage (zod) -> error frame │
                                           │      ▼                                  │
                                           │ handle(): hello/join/leave/msg/typing   │
                                           │      ▼                                  │
                                           │ RoomRegistry ── Room { members: Set,    │
                                           │                       history: Ring }   │
                                           │ heartbeat interval: ping / terminate    │
                                           └─────────────────────────────────────────┘
```

| File | Responsibility |
|---|---|
| `src/protocol.ts` | Message types, zod schemas, limits |
| `src/server.ts` | HTTP + WebSocket wiring, handlers, heartbeat, shutdown, static files |
| `src/rooms.ts` | Room membership, presence lists, empty-room cleanup |
| `src/ringBuffer.ts` | Bounded history |
| `src/tokenBucket.ts` | Rate limiter |
| `src/index.ts` | Entry point and signal handling |

## Quick start

```bash
npm ci
npm run dev                  # http://localhost:3000, open it in two tabs
# or
npm run build && npm start   # PORT and HOST env vars are respected
```

## Protocol

Client -> server:

```jsonc
{ "type": "hello",   "name": "Alice" }                 // must be first
{ "type": "join",    "room": "general" }
{ "type": "leave",   "room": "general" }
{ "type": "message", "room": "general", "text": "hi" }
{ "type": "typing",  "room": "general", "isTyping": true }
```

Server -> client:

```jsonc
{ "type": "welcome",  "you": { "id": "…", "name": "Alice" } }
{ "type": "joined",   "room": "general", "members": [...], "history": [...] }
{ "type": "left",     "room": "general" }
{ "type": "presence", "room": "general", "event": "join", "member": {...}, "members": [...] }
{ "type": "message",  "message": { "id": "…", "room": "general", "from": {...}, "text": "hi", "ts": 1760000000000 } }
{ "type": "typing",   "room": "general", "member": {...}, "isTyping": true }
{ "type": "error",    "code": "RATE_LIMITED", "message": "Too many messages; slow down" }
{ "type": "shutdown", "reason": "server restarting" }
```

## Usage example

Talk to it from a terminal with any WebSocket client, e.g. `npx wscat -c ws://localhost:3000/ws`:

```
> {"type":"hello","name":"Alice"}
< {"type":"welcome","you":{"id":"5b0c…","name":"Alice"}}
> {"type":"join","room":"general"}
< {"type":"joined","room":"general","members":[{"id":"5b0c…","name":"Alice"}],"history":[]}
> {"type":"message","room":"general","text":"hello"}
< {"type":"message","message":{"id":"e1f2…","room":"general","from":{…},"text":"hello","ts":1760000000000}}
> {"type":"join","room":"Bad Room"}
< {"type":"error","code":"INVALID_MESSAGE","message":"Message failed validation","details":[{"path":"room",…}]}
```

## Testing

```bash
npm test         # vitest, real server on an ephemeral port + real ws clients
npm run lint     # tsc --noEmit over src and test
```

25 tests. Integration tests start the server on port 0 and connect real `ws` clients to cover: handshake, join/leave, presence on leave and on disconnect, broadcast scoping, typing, bounded history, invalid JSON and schema violations, binary frames, oversized frames, burst-then-throttle-then-refill rate limiting, flood disconnects, heartbeat termination of a client that never pongs, graceful shutdown, and static file serving with a traversal attempt. Unit tests include property-style checks that the ring buffer always equals the last N items and that a token bucket never admits more than `capacity + rate × elapsed`.

## What I'd add next

- Authentication on the upgrade request (e.g. a short-lived JWT from an auth service) instead of self-chosen names
- Redis pub/sub so several server instances can share rooms behind a load balancer
- Persistent history (Postgres) with cursor-based "load older messages"
- Client reconnect with exponential backoff and resume from the last seen message id
- Backpressure handling: drop or disconnect clients whose `bufferedAmount` keeps growing

See [WALKTHROUGH.md](WALKTHROUGH.md) for the design decisions behind this project.

## License

MIT

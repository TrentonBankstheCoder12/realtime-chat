// The wire protocol. Every frame is a JSON object with a `type` field.
// Client -> server frames are validated with zod (never trust the network);
// server -> client frames are plain TypeScript types the server constructs.

import { z } from "zod";

export const LIMITS = {
  nameMax: 24,
  textMax: 2000,
  /** Max raw frame size; enforced by ws before we even parse JSON. */
  maxFrameBytes: 16 * 1024,
} as const;

// Lowercase slug so room names are safe to display and compare.
const room = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, "room must be 1-32 chars of a-z, 0-9, -");
const name = z.string().trim().min(1).max(LIMITS.nameMax);

// ---------------------------------------------------------------- client -> server

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), name }).strict(),
  z.object({ type: z.literal("join"), room }).strict(),
  z.object({ type: z.literal("leave"), room }).strict(),
  z.object({ type: z.literal("message"), room, text: z.string().trim().min(1).max(LIMITS.textMax) }).strict(),
  z.object({ type: z.literal("typing"), room, isTyping: z.boolean() }).strict(),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

// ---------------------------------------------------------------- server -> client

export interface Member {
  id: string;
  name: string;
}

export interface ChatMessage {
  id: string;
  room: string;
  from: Member;
  text: string;
  ts: number; // server timestamp, ms since epoch: the server is the source of truth for ordering
}

export type ErrorCode =
  | "INVALID_JSON"
  | "INVALID_MESSAGE"
  | "NOT_IDENTIFIED"
  | "ALREADY_IDENTIFIED"
  | "NOT_IN_ROOM"
  | "RATE_LIMITED";

export type ServerMessage =
  | { type: "welcome"; you: Member }
  | { type: "joined"; room: string; members: Member[]; history: ChatMessage[] }
  | { type: "left"; room: string }
  | { type: "presence"; room: string; event: "join" | "leave"; member: Member; members: Member[] }
  | { type: "message"; message: ChatMessage }
  | { type: "typing"; room: string; member: Member; isTyping: boolean }
  | { type: "error"; code: ErrorCode; message: string; details?: unknown }
  | { type: "shutdown"; reason: string };

export type ParseResult =
  | { ok: true; message: ClientMessage }
  | { ok: false; error: Extract<ServerMessage, { type: "error" }> };

/** Raw frame -> validated message, or a ready-to-send error frame. */
export function parseClientMessage(raw: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: { type: "error", code: "INVALID_JSON", message: "Frame is not valid JSON" } };
  }
  const result = clientMessageSchema.safeParse(data);
  if (!result.success) {
    const details = result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    return { ok: false, error: { type: "error", code: "INVALID_MESSAGE", message: "Message failed validation", details } };
  }
  return { ok: true, message: result.data };
}

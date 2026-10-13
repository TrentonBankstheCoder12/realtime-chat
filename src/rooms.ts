// Room state: who is in each room and its recent history. Kept separate
// from the socket code so the rules (presence, history bounds, empty-room
// cleanup) are easy to read and test without a network.

import type { ChatMessage, Member } from "./protocol.js";
import { RingBuffer } from "./ringBuffer.js";

export interface Room<C> {
  name: string;
  members: Set<C>;
  history: RingBuffer<ChatMessage>;
}

/** Generic over the connection type C so it doesn't depend on `ws`. */
export class RoomRegistry<C extends { member: Member }> {
  private rooms = new Map<string, Room<C>>();

  constructor(private readonly historySize: number) {}

  get(name: string): Room<C> | undefined {
    return this.rooms.get(name);
  }

  /** Returns the room and whether `client` was newly added. */
  join(name: string, client: C): { room: Room<C>; added: boolean } {
    let room = this.rooms.get(name);
    if (!room) {
      room = { name, members: new Set(), history: new RingBuffer(this.historySize) };
      this.rooms.set(name, room);
    }
    const added = !room.members.has(client);
    room.members.add(client);
    return { room, added };
  }

  /** Returns the room if the client was in it. */
  leave(name: string, client: C): Room<C> | undefined {
    const room = this.rooms.get(name);
    if (!room || !room.members.delete(client)) return undefined;
    // Rooms are created on demand and deleted when empty, so abandoned
    // rooms (and their history) don't accumulate forever.
    if (room.members.size === 0) this.rooms.delete(name);
    return room;
  }

  /** Stable, sorted presence list for a room. */
  members(room: Room<C>): Member[] {
    return [...room.members].map((c) => c.member).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  get roomCount(): number {
    return this.rooms.size;
  }
}

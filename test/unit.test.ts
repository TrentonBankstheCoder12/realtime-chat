import { describe, expect, it } from "vitest";
import { parseClientMessage } from "../src/protocol.js";
import { RingBuffer } from "../src/ringBuffer.js";
import { TokenBucket } from "../src/tokenBucket.js";

describe("RingBuffer", () => {
  it("keeps the newest `capacity` items in insertion order", () => {
    const rb = new RingBuffer<number>(3);
    expect(rb.toArray()).toEqual([]);
    [1, 2].forEach((n) => rb.push(n));
    expect(rb.toArray()).toEqual([1, 2]);
    [3, 4, 5].forEach((n) => rb.push(n));
    expect(rb.toArray()).toEqual([3, 4, 5]);
    expect(rb.size).toBe(3);
  });

  it("property: always equals the last N items of the full sequence", () => {
    for (let trial = 0; trial < 200; trial++) {
      const capacity = 1 + Math.floor(Math.random() * 10);
      const count = Math.floor(Math.random() * 40);
      const rb = new RingBuffer<number>(capacity);
      const all: number[] = [];
      for (let i = 0; i < count; i++) {
        rb.push(i);
        all.push(i);
        expect(rb.toArray()).toEqual(all.slice(-capacity));
      }
    }
  });

  it("rejects a non-positive capacity", () => {
    expect(() => new RingBuffer(0)).toThrow(RangeError);
  });
});

describe("TokenBucket", () => {
  it("allows a burst up to capacity, then refills over time without exceeding capacity", () => {
    let now = 0;
    const bucket = new TokenBucket(3, 1, () => now);
    expect([1, 2, 3, 4].map(() => bucket.tryRemove())).toEqual([true, true, true, false]);
    now = 1500;
    expect(bucket.tryRemove()).toBe(true); // 1.5 tokens accrued
    expect(bucket.tryRemove()).toBe(false); // 0.5 left
    now = 60_000;
    expect(bucket.available).toBe(3); // capped
  });

  it("property: over any window, accepted <= capacity + rate * elapsed", () => {
    for (let trial = 0; trial < 50; trial++) {
      let now = 0;
      const capacity = 1 + Math.floor(Math.random() * 10);
      const rate = 1 + Math.random() * 5;
      const bucket = new TokenBucket(capacity, rate, () => now);
      let accepted = 0;
      for (let i = 0; i < 500; i++) {
        now += Math.random() * 100;
        if (bucket.tryRemove()) accepted++;
      }
      expect(accepted).toBeLessThanOrEqual(capacity + (rate * now) / 1000 + 1e-9);
    }
  });
});

describe("protocol parsing", () => {
  it("accepts valid frames and trims text", () => {
    const r = parseClientMessage(JSON.stringify({ type: "message", room: "general", text: "  hi  " }));
    expect(r).toEqual({ ok: true, message: { type: "message", room: "general", text: "hi" } });
  });

  it("returns typed error frames for bad input", () => {
    const bad = parseClientMessage("[]");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe("INVALID_MESSAGE");
    const notJson = parseClientMessage("nope");
    if (!notJson.ok) expect(notJson.error.code).toBe("INVALID_JSON");
  });
});

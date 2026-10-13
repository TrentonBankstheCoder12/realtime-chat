// Fixed-capacity circular buffer. Each room keeps its last N messages so a
// new joiner gets context, while memory per room stays bounded no matter
// how chatty the room is. push() is O(1): no array shifting.

export class RingBuffer<T> {
  private readonly items: (T | undefined)[];
  private start = 0; // index of the oldest item
  private count = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError("capacity must be a positive integer");
    this.items = new Array(capacity);
  }

  get size(): number {
    return this.count;
  }

  push(item: T): void {
    const end = (this.start + this.count) % this.capacity;
    this.items[end] = item;
    if (this.count < this.capacity) {
      this.count++;
    } else {
      // Full: we just overwrote the oldest slot, so the oldest moves forward.
      this.start = (this.start + 1) % this.capacity;
    }
  }

  /** Oldest first. */
  toArray(): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.count; i++) out.push(this.items[(this.start + i) % this.capacity] as T);
    return out;
  }
}

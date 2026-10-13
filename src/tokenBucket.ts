// Token bucket rate limiter, one per connection.
//
// The bucket holds up to `capacity` tokens and refills continuously at
// `refillPerSecond`. Each frame costs one token. This allows short bursts
// (paste a few lines quickly) while capping the sustained rate, which a
// fixed window can't express as smoothly.

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.lastRefill = now();
  }

  /** Spend `cost` tokens if available. Returns false (and spends nothing) if not. */
  tryRemove(cost = 1): boolean {
    this.refill();
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }

  get available(): number {
    this.refill();
    return this.tokens;
  }

  // Lazy refill: compute what accrued since last time instead of running a timer.
  private refill(): void {
    const t = this.now();
    const elapsedSeconds = (t - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
    this.lastRefill = t;
  }
}

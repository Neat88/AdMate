/**
 * In-memory token bucket, keyed per user and route.
 *
 * AdMate runs as a single instance (SQLite has one writer), so process memory
 * is the whole world; if it ever scales out, this moves to the database.
 * Limits reset on restart, which is acceptable for abuse protection - the
 * durable per-day AI quota lives in the `ai_usage` table.
 */

interface Bucket {
  tokens: number;
  updatedAt: number;
}

const buckets = new Map<string, Bucket>();

export function rateLimit(key: string, capacity: number, refillPerMinute: number): { ok: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  const bucket = buckets.get(key) ?? { tokens: capacity, updatedAt: now };
  const refill = ((now - bucket.updatedAt) / 60_000) * refillPerMinute;
  bucket.tokens = Math.min(capacity, bucket.tokens + refill);
  bucket.updatedAt = now;
  if (bucket.tokens < 1) {
    buckets.set(key, bucket);
    return { ok: false, retryAfterSeconds: Math.ceil(((1 - bucket.tokens) / refillPerMinute) * 60) };
  }
  bucket.tokens -= 1;
  buckets.set(key, bucket);
  if (buckets.size > 10_000) {
    // Drop the stalest entries rather than growing without bound.
    for (const [k, b] of buckets) if (now - b.updatedAt > 3_600_000) buckets.delete(k);
  }
  return { ok: true, retryAfterSeconds: 0 };
}

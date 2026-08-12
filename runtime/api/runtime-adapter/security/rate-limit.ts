export type TokenBucket = {
  capacity: number;
  tokens: number;
  refillPerSecond: number;
  updatedAt: number;
};

export const createTokenBucket = (capacity: number, refillPerSecond: number): TokenBucket => ({
  capacity,
  tokens: capacity,
  refillPerSecond,
  updatedAt: Date.now(),
});

export const consumeToken = (bucket: TokenBucket, amount = 1): boolean => {
  const now = Date.now();
  const elapsedSeconds = Math.max(0, (now - bucket.updatedAt) / 1000);
  bucket.updatedAt = now;
  bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsedSeconds * bucket.refillPerSecond);
  if (bucket.tokens < amount) return false;
  bucket.tokens -= amount;
  return true;
};

export const tokenRetryAfterMs = (bucket: TokenBucket, amount = 1): number => {
  if (bucket.tokens >= amount) return 0;
  if (bucket.refillPerSecond <= 0) return 1_000;
  return Math.max(1, Math.ceil(((amount - bucket.tokens) / bucket.refillPerSecond) * 1_000));
};

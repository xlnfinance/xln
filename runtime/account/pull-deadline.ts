/**
 * Pull deadlines are committed in runtime milliseconds but enforced on-chain
 * against Solidity's second-resolution block.timestamp. A beneficiary retains
 * the right to reveal throughout the committed deadline second; the payer may
 * cancel only after that entire second has elapsed.
 */
export const pullDeadlineSecond = (timestampMs: number): number =>
  Math.floor(timestampMs / 1_000);

export const isPullRevealExpired = (deadlineMs: number, currentTimestampMs: number): boolean =>
  Number.isFinite(deadlineMs) &&
  deadlineMs > 0 &&
  pullDeadlineSecond(currentTimestampMs) > pullDeadlineSecond(deadlineMs);


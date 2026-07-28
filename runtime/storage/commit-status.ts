/**
 * What the authoritative WAL can prove after a failed append attempt.
 *
 * `unknown` is intentionally distinct from `not-committed`: callers must halt
 * and recover instead of guessing which financial frame owns durable truth.
 */
export type RuntimeFrameCommitStatus =
  | 'committed'
  | 'not-committed'
  | 'conflict'
  | 'unknown';

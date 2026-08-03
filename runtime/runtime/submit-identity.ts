/**
 * Identity and failure-message normalization shared by the two Runtime submit
 * families (J batches and EntityProvider actions).
 *
 * Both families durably record an attempt keyed by {jurisdiction, entity,
 * signer, hash} and both persist an adapter failure string into a Runtime tx.
 * Two copies of that normalization is two chances for one family to compare
 * `0xAB…` against `0xab…`, or to persist an unbounded revert string into the
 * WAL. The rest of the two families is genuinely different policy and stays
 * separate.
 */

export const normalizeSubmitId = (value: unknown): string =>
  String(value || '').trim().toLowerCase();

/**
 * Adapter failures carry provider revert strings of unbounded length, and the
 * message reaches the WAL through a Runtime tx. Cap it at the boundary so one
 * hostile RPC response cannot inflate a durable record.
 */
export const MAX_SUBMIT_FAILURE_MESSAGE_CHARS = 4_096;

export const truncateSubmitFailureMessage = (value: unknown): string => {
  const message = String(value || 'unknown');
  if (message.length <= MAX_SUBMIT_FAILURE_MESSAGE_CHARS) return message;
  const suffix = `...[truncated:${message.length}]`;
  return message.slice(0, MAX_SUBMIT_FAILURE_MESSAGE_CHARS - suffix.length) + suffix;
};

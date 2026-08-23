import { LIMITS } from '../../config/constants';

export const MEMPOOL_LIMIT = LIMITS.ACCOUNT_MEMPOOL_SIZE;
export const ACCOUNT_NETWORK_ALLOWANCE_MS = 30_000;

/**
 * A pending Account proposal without ACK is put on the wire again after this
 * many Entity-clock milliseconds, whether by the next flush to that
 * counterparty or by a scheduled wake on an idle Entity. Deterministic: both
 * sides derive it from committed `pendingProposalSentAt` and frame timestamps.
 */
export const ACCOUNT_PROPOSAL_RESEND_MS = 5_000;

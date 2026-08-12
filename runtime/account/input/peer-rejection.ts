/**
 * Stable rejection taxonomy for authenticated Account peer evidence.
 *
 * A peer can send invalid bytes, stale heights, or a bad Hanko without proving
 * that our committed state is corrupt. Those failures are deterministic no-op
 * inputs. Local verifier, storage, CAS, and reducer failures are deliberately
 * absent from this list and must keep throwing through the Runtime boundary.
 */
export type AccountPeerRejectionCode =
  | 'ACCOUNT_PEER_DOMAIN_INVALID'
  | 'ACCOUNT_PEER_PARTY_MISMATCH'
  | 'ACCOUNT_PEER_DOMAIN_MISMATCH'
  | 'ACCOUNT_PEER_DISPUTE_CONFIG_INVALID'
  | 'ACCOUNT_PEER_DISPUTE_CONFIG_MISMATCH'
  | 'ACCOUNT_PEER_WATCH_SEED_INVALID'
  | 'ACCOUNT_PEER_WATCH_SEED_MISMATCH'
  | 'ACCOUNT_PEER_CAPACITY_EXCEEDED'
  | 'ACCOUNT_PEER_HEIGHT_INVALID'
  | 'ACCOUNT_PEER_HANKO_SHAPE_INVALID'
  | 'ACCOUNT_PEER_DISPUTE_SEAL_INVALID'
  | 'ACCOUNT_PEER_BOARD_RESEAL_INVALID'
  | 'ACCOUNT_PEER_FRAME_HANKO_INVALID'
  | 'ACCOUNT_PEER_FRAME_PROPOSER_INVALID'
  | 'ACCOUNT_PEER_FRAME_STRUCTURE_INVALID'
  | 'ACCOUNT_PEER_FRAME_CHAIN_INVALID'
  | 'ACCOUNT_PEER_FRAME_DEADLINE_INVALID'
  | 'ACCOUNT_PEER_FRAME_STALE_SETTLEMENT_SEAL'
  | 'ACCOUNT_PEER_ACK_CERTIFICATE_INVALID'
  | 'ACCOUNT_PEER_ACK_UNMATCHED';

export type AccountPeerRejection = Readonly<{
  code: AccountPeerRejectionCode;
  reason: string;
}>;

/** Typed exception used only while a nested peer-evidence validator unwinds. */
export class AccountPeerEvidenceError extends Error {
  readonly code: AccountPeerRejectionCode;

  constructor(code: AccountPeerRejectionCode, reason: string) {
    super(reason);
    this.name = 'AccountPeerEvidenceError';
    this.code = code;
  }
}

export const rejectAccountPeerInput = (code: AccountPeerRejectionCode, reason: string, events: string[]) => ({
  success: false as const,
  error: reason,
  events,
  rejected: { code, reason } satisfies AccountPeerRejection,
});

/** Convert only the typed peer failure; every local exception remains fatal. */
export const rejectAccountPeerEvidenceError = (error: unknown, events: string[]) => {
  if (!(error instanceof AccountPeerEvidenceError)) throw error;
  return rejectAccountPeerInput(error.code, error.message, events);
};

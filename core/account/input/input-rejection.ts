/**
 * Stable rejection taxonomy for authenticated Account input evidence.
 *
 * A counterparty can send invalid bytes, stale heights, or a bad Hanko without proving
 * that our committed state is corrupt. Those failures are deterministic no-op
 * inputs. Local verifier, storage, CAS, and reducer failures are deliberately
 * absent from this list and must keep throwing through the Runtime boundary.
 */
export type AccountInputRejectionCode =
  | 'ACCOUNT_INPUT_DOMAIN_INVALID'
  | 'ACCOUNT_INPUT_PARTY_MISMATCH'
  | 'ACCOUNT_INPUT_DOMAIN_MISMATCH'
  | 'ACCOUNT_INPUT_DISPUTE_CONFIG_INVALID'
  | 'ACCOUNT_INPUT_DISPUTE_CONFIG_MISMATCH'
  | 'ACCOUNT_INPUT_WATCH_SEED_INVALID'
  | 'ACCOUNT_INPUT_WATCH_SEED_MISMATCH'
  | 'ACCOUNT_INPUT_HEIGHT_INVALID'
  | 'ACCOUNT_INPUT_HANKO_SHAPE_INVALID'
  | 'ACCOUNT_INPUT_DISPUTE_HANKO_INVALID'
  | 'ACCOUNT_INPUT_BOARD_HANKO_REFRESH_INVALID'
  | 'ACCOUNT_INPUT_FRAME_HANKO_INVALID'
  | 'ACCOUNT_INPUT_FRAME_PROPOSER_INVALID'
  | 'ACCOUNT_INPUT_FRAME_STRUCTURE_INVALID'
  | 'ACCOUNT_INPUT_FRAME_CHAIN_INVALID'
  | 'ACCOUNT_INPUT_FRAME_HASH_INVALID'
  | 'ACCOUNT_INPUT_FRAME_DEADLINE_INVALID'
  | 'ACCOUNT_INPUT_FRAME_TX_OUT_OF_PROFILE'
  | 'ACCOUNT_INPUT_FRAME_TX_POLICY_VERSION_OUT_OF_RANGE'
  | 'ACCOUNT_INPUT_FRAME_STALE_SETTLEMENT_HANKO'
  | 'ACCOUNT_INPUT_ACK_CERTIFICATE_INVALID'
  | 'ACCOUNT_INPUT_ACK_UNMATCHED';

/** Typed exception used only while a nested Account-input validator unwinds. */
export class AccountInputEvidenceError extends Error {
  readonly code: AccountInputRejectionCode;

  constructor(code: AccountInputRejectionCode, reason: string) {
    super(reason);
    this.name = 'AccountInputEvidenceError';
    this.code = code;
  }
}

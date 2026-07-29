/**
 * Public Entity-consensus surface.
 *
 * The implementation follows the audit boundaries of this state machine:
 * shared validation/certification, input consensus, and committed-frame apply.
 */
export {
  MAX_PENDING_CROSS_J_FILL_ACKS,
  attachTargetConsumptionProofs,
  CROSS_J_PENDING_FILL_ACK_TTL_MS,
  expectedCommittedLeaderState,
  selectPreparedFrameFromCertificate,
  selectProposableEntityTxs,
  verifyEntityLeaderCertificate,
  verifyEntityRelayCertificate,
  type ProposableEntityTxSelection,
} from './shared';
export { createEntityFrameHash } from './frame';
export {
  mergeEntityInputs,
  prioritizeEntityConsensusInputs,
  prioritizeProtocolEntityInputs,
} from './input-merge';
export {
  calculateQuorumPower,
  getEntityStateSummary,
  shouldAutoPropose,
  sortSignatures,
} from './replica-validation';
export { applyEntityInput, type EntityInputOutcome } from './input-consensus';
export { applyEntityFrame } from './frame-application';

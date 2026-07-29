/**
 * Public Entity-consensus surface.
 *
 * The implementation follows the audit boundaries of this state machine:
 * shared validation/certification, input consensus, and committed-frame apply.
 */
export {
  MAX_PENDING_CROSS_J_FILL_ACKS,
  CROSS_J_PENDING_FILL_ACK_TTL_MS,
  expectedCommittedLeaderState,
  selectPreparedFrameFromCertificate,
  verifyEntityLeaderCertificate,
  verifyEntityRelayCertificate,
} from './shared';
export { attachTargetConsumptionProofs } from './consumption-output';
export {
  selectProposableEntityTxs,
  type ProposableEntityTxSelection,
} from './proposal-policy';
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

/**
 * Public Entity-consensus surface.
 *
 * The implementation follows the audit boundaries of this state machine:
 * shared validation/certification, input consensus, and committed-frame apply.
 */
export {
  MAX_PENDING_CROSS_J_FILL_ACKS,
  attachTargetConsumptionProofs,
  calculateQuorumPower,
  createEntityFrameHash,
  CROSS_J_PENDING_FILL_ACK_TTL_MS,
  expectedCommittedLeaderState,
  getEntityStateSummary,
  mergeEntityInputs,
  prioritizeEntityConsensusInputs,
  prioritizeProtocolEntityInputs,
  selectPreparedFrameFromCertificate,
  selectProposableEntityTxs,
  shouldAutoPropose,
  sortSignatures,
  verifyEntityLeaderCertificate,
  verifyEntityRelayCertificate,
  type ProposableEntityTxSelection,
} from './shared';
export { applyEntityInput, type EntityInputOutcome } from './input-consensus';
export { applyEntityFrame } from './frame-application';

/**
 * Public Entity-consensus surface.
 *
 * The implementation follows the audit boundaries of this state machine:
 * shared validation/certification, input consensus, and committed-frame apply.
 */
export {
  selectProposableEntityTxs,
} from './proposal/policy';
export {
  mergeEntityInputs,
  prioritizeEntityConsensusInputs,
} from './input/merge';
export { applyEntityInput, type EntityInputOutcome } from './input/consensus';
export { applyEntityFrame } from './frame/application';

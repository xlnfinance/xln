/**
 * Stable convenience exports for UI, tooling, and tests.
 *
 * These helpers do not participate in the Runtime frame transition. Keeping
 * them outside runtime/runtime/composition.ts makes the money-moving path easier to audit.
 */
export { entityNeedsPeriodicWake } from '../runtime/wake';
export * from './public-utilities';
export { planSwapInboundCapacity, readSwapAccountCapacity } from '../account/swap-inbound-plan';
export type {
  SwapAccountCapacityView,
  SwapAccountCapacityViewInput,
  SwapInboundCapacityPlan,
  SwapInboundCapacityPlanInput,
} from '../account/swap-inbound-plan';
export {
  assertCrossJurisdictionSwapTargetReady,
  assertCrossJurisdictionSwapTargetReadyInEnv,
  buildDeterministicSwapOfferId,
  planSwapCommand,
} from '../account/swap-command-plan';
export type {
  CrossJurisdictionSwapCommandPlan,
  SameJurisdictionSwapCommandPlan,
  SwapCommandPlan,
  SwapCommandPlanInput,
  SwapCommandPreparedOrder,
} from '../account/swap-command-plan';
export { enqueueRuntimeInput } from '../runtime/input-queue';
export { resolveRuntimeAdapterRead, EmbeddedRuntimeAdapter, RemoteRuntimeAdapter } from '../radapter';
export type {
  RuntimeAdapter,
  RuntimeAdapterConfig,
  RuntimeAdapterReadQuery,
  RuntimeAdapterAuthLevel,
  RuntimeAdapterStatus,
} from '../radapter';
export type {
  EntityId,
  SignerId,
  JId,
  EntityProviderAddress,
  ReplicaKey,
  FullReplicaAddress,
  ReplicaUri,
  JurisdictionInfo,
} from '../ids';
export { scenarios } from '../runtime/scenarios';
export { parseScenario, mergeAndSortEvents } from '../scenarios/parser.js';
export { executeScenario } from '../scenarios/executor.js';
export { SCENARIOS, getScenario, getScenariosByTag, type ScenarioMetadata } from '../scenarios/index.js';
export {
  deriveSignerKey,
  deriveSignerKeySync,
  getCachedSignerPrivateKey,
  registerSignerKey,
  registerSignerPublicKey,
  registerTestKeys,
  clearSignerKeys,
  signAccountFrame,
  verifyAccountSignature,
  getSignerPublicKey,
} from '../account/crypto.js';
export { canonicalJurisdictionEventsHash } from '../jurisdiction/event-observation';
export type {
  EncryptedRuntimeRecoveryBundleV1,
  RuntimeRecording,
  RuntimeRecoveryBundleV1,
  RuntimeRecoveryMetaV1,
  RuntimeRecoverySignerV1,
  TowerAppointmentOwnerProofV1,
  TowerAppointmentV1,
  TowerDiscoverResponseV1,
  TowerEncryptedPayloadV1,
  TowerReceiptV1,
  TowerRestoreRequestV1,
  TowerRestoreResponseV1,
} from '../recovery/types';
export {
  buildRuntimeRecoveryBundle,
  buildRuntimeRecoveryCheckpointBundle,
  computeRuntimeRecoveryBundleHash,
  computeRuntimeRecoveryCheckpointHash,
  validateRuntimeRecoveryBundle,
} from '../recovery/bundle';
export { buildRuntimeRecording, validateRuntimeRecording } from '../recovery/recording';
export {
  buildTowerAppointmentOwnerMessage,
  computeWatchtowerCounterDisputeAuthorizationHash,
  decryptRuntimeRecoveryBundle,
  decryptTowerPayloadWithWatchSeed,
  deriveRuntimeRecoveryActionLookupKey,
  deriveRuntimeRecoveryLookupKey,
  encryptTowerPayloadForWatchSeed,
  encryptRuntimeRecoveryBundle,
} from '../recovery/crypto';
export { buildSingleSignerHanko } from '../hanko/batch';
export { buildCrossJurisdictionPullReveal, getCrossJurisdictionPrivateSeed } from '../extensions/cross-j/index';
export { buildDisputeArgumentsForSnapshot } from '../protocol/dispute/arguments';
export {
  buildMppChallengeHeader,
  buildMppCredentialHeader,
  buildMppReceiptHeader,
  canonicalizeMppJson,
  computeMppChallengeId,
  decodeMppJson,
  encodeMppJson,
  parseMppChallengeHeader,
  parseMppCredentialHeader,
  parseMppReceiptHeader,
} from '../agent-payments/mpp';
export type {
  MppChallenge,
  MppChallengeBindingInput,
  MppCredential,
  MppJsonRecord,
  MppJsonValue,
  MppReceipt,
} from '../agent-payments/mpp';
export { createJAdapter } from '../jadapter';
export type { JAdapter, JAdapterConfig, JAdapterMode, JEvent } from '../jadapter';
export { applyJEventsToEnv, buildJEventsRuntimeInput } from '../jadapter/watcher';
export {
  getActiveJAdapter,
  getEntityJAdapter,
  buildDebtEnforcementRuntimeInputFromProjection,
  buildDebtEnforcementRuntimeInput,
} from '../runtime/jurisdiction-api';
export type {
  CrossJurisdictionSwapSubmitParams,
  CrossJurisdictionSwapSubmitResult,
  DebtEnforcementProjectionRuntimeInputParams,
  DebtEnforcementRuntimeInputParams,
} from '../runtime/jurisdiction-api';
export {
  normalizeEntityId,
  compareEntityIds,
  isLeftEntity,
  parseUniversalEntityId,
  createProviderScopedEntityId,
  getShortId,
  formatEntityIdDisplay,
  entityIdsEqual,
  extractProvider,
} from '../entity/id';
export type { ParsedEntityId } from '../entity/id';
export { formatRuntime, formatEntity, formatAccount, formatOrderbook, formatSummary } from '../qa/runtime-ascii';

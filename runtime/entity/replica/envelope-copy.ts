import type { JurisdictionConfig } from '../../protocol/config/jurisdiction-config';
import type { RuntimeFailureSignal } from '../../protocol/errors/failure-taxonomy';
import type { EntityProviderActionSubmitState } from '../../types/entity-provider-actions';
import type { JAdapterFailure } from '../../types/jurisdiction-runtime';
import type {
  CertifiedEntityLineageAnchor,
  ConsensusConfig,
  EntityFrameAuthority,
  EntityLeaderState,
  EntityReplica,
} from '../types';
import { copyJPrefixRound } from '../state/input-clone';

const copyStringRecord = (
  record: Record<string, string>,
): Record<string, string> => Object.fromEntries(Object.entries(record));

const copyJurisdictionConfig = (config: JurisdictionConfig): JurisdictionConfig => ({
  address: config.address,
  name: config.name,
  entityProviderAddress: config.entityProviderAddress,
  depositoryAddress: config.depositoryAddress,
  ...(config.chainId !== undefined ? { chainId: config.chainId } : {}),
  ...(config.blockTimeMs !== undefined ? { blockTimeMs: config.blockTimeMs } : {}),
  ...(config.registrationBlock !== undefined ? { registrationBlock: config.registrationBlock } : {}),
  ...(config.entityProviderDeploymentBlock !== undefined
    ? { entityProviderDeploymentBlock: config.entityProviderDeploymentBlock }
    : {}),
  ...(config.rebalancePolicyUsd
    ? {
        rebalancePolicyUsd: {
          r2cRequestSoftLimit: config.rebalancePolicyUsd.r2cRequestSoftLimit,
          hardLimit: config.rebalancePolicyUsd.hardLimit,
          maxFee: config.rebalancePolicyUsd.maxFee,
        },
      }
    : {}),
});

const copyConsensusConfig = (config: ConsensusConfig): ConsensusConfig => ({
  mode: config.mode,
  threshold: config.threshold,
  validators: [...config.validators],
  shares: Object.fromEntries(
    Object.entries(config.shares).map(([signerId, share]) => [signerId, share]),
  ),
  ...(config.jurisdiction ? { jurisdiction: copyJurisdictionConfig(config.jurisdiction) } : {}),
});

const copyEntityLeaderState = (leader: EntityLeaderState): EntityLeaderState => ({
  activeValidatorId: leader.activeValidatorId,
  view: leader.view,
  changedAtHeight: leader.changedAtHeight,
});

const copyEntityFrameAuthority = (authority: EntityFrameAuthority): EntityFrameAuthority => ({
  config: copyConsensusConfig(authority.config),
  leaderState: copyEntityLeaderState(authority.leaderState),
});

export const copyCertifiedEntityLineageAnchor = (
  anchor: CertifiedEntityLineageAnchor,
): CertifiedEntityLineageAnchor => ({
  entityId: anchor.entityId,
  height: anchor.height,
  frameHash: anchor.frameHash,
  stateRoot: anchor.stateRoot,
  authority: copyEntityFrameAuthority(anchor.authority),
  ...(anchor.authorityEvidenceHash !== undefined
    ? { authorityEvidenceHash: anchor.authorityEvidenceHash }
    : {}),
  ...(anchor.runtimeCheckpoint
    ? {
        runtimeCheckpoint: {
          runtimeHeight: anchor.runtimeCheckpoint.runtimeHeight,
          replicaSetRoot: anchor.runtimeCheckpoint.replicaSetRoot,
        },
      }
    : {}),
});

const copyRuntimeFailureSignal = (failure: RuntimeFailureSignal): RuntimeFailureSignal => ({
  category: failure.category,
  code: failure.code,
  message: failure.message,
  retryable: failure.retryable,
  fatal: failure.fatal,
});

const copyJAdapterFailure = (failure: JAdapterFailure): JAdapterFailure => ({
  category: failure.category,
  code: failure.code,
  message: failure.message,
});

type JSubmitState = NonNullable<EntityReplica['jSubmitState']>;
type JSubmitFailure = NonNullable<JSubmitState['lastFailure']>;

const copyJSubmitFailure = (failure: JSubmitFailure): JSubmitFailure => ({
  message: failure.message,
  failedAt: failure.failedAt,
  failure: copyRuntimeFailureSignal(failure.failure),
  ...(failure.adapterFailure ? { adapterFailure: copyJAdapterFailure(failure.adapterFailure) } : {}),
});

export const copyJSubmitState = (state: JSubmitState): JSubmitState => ({
  jurisdictionName: state.jurisdictionName,
  batchHash: state.batchHash,
  entityNonce: state.entityNonce,
  batchGeneration: state.batchGeneration,
  submitAttempts: state.submitAttempts,
  lastSubmittedAt: state.lastSubmittedAt,
  ...(state.txHash !== undefined ? { txHash: state.txHash } : {}),
  ...(state.lastFailure ? { lastFailure: copyJSubmitFailure(state.lastFailure) } : {}),
  ...(state.terminalFailure ? { terminalFailure: copyJSubmitFailure(state.terminalFailure) } : {}),
  ...(state.lastResultAttemptId !== undefined ? { lastResultAttemptId: state.lastResultAttemptId } : {}),
  ...(state.lastResultAt !== undefined ? { lastResultAt: state.lastResultAt } : {}),
  ...(state.lastResultOutcome !== undefined ? { lastResultOutcome: state.lastResultOutcome } : {}),
  ...(state.lastResultFingerprint !== undefined
    ? { lastResultFingerprint: state.lastResultFingerprint }
    : {}),
  ...(state.resultFingerprints ? { resultFingerprints: copyStringRecord(state.resultFingerprints) } : {}),
  ...(state.resultFingerprintOrder ? { resultFingerprintOrder: [...state.resultFingerprintOrder] } : {}),
});

type ProviderSubmitFailure = NonNullable<EntityProviderActionSubmitState['lastFailure']>;

const copyProviderSubmitFailure = (failure: ProviderSubmitFailure): ProviderSubmitFailure => ({
  message: failure.message,
  failedAt: failure.failedAt,
  ...(failure.adapterFailure ? { adapterFailure: copyJAdapterFailure(failure.adapterFailure) } : {}),
});

export const copyEntityProviderActionSubmitState = (
  state: EntityProviderActionSubmitState,
): EntityProviderActionSubmitState => ({
  jurisdictionName: state.jurisdictionName,
  actionHash: state.actionHash,
  actionNonce: state.actionNonce,
  generation: state.generation,
  submitAttempts: state.submitAttempts,
  lastSubmittedAt: state.lastSubmittedAt,
  ...(state.txHash !== undefined ? { txHash: state.txHash } : {}),
  ...(state.lastFailure ? { lastFailure: copyProviderSubmitFailure(state.lastFailure) } : {}),
  ...(state.terminalFailure ? { terminalFailure: copyProviderSubmitFailure(state.terminalFailure) } : {}),
  ...(state.lastResultAttemptId !== undefined ? { lastResultAttemptId: state.lastResultAttemptId } : {}),
  ...(state.lastResultAt !== undefined ? { lastResultAt: state.lastResultAt } : {}),
  ...(state.lastResultOutcome !== undefined ? { lastResultOutcome: state.lastResultOutcome } : {}),
  ...(state.lastResultFingerprint !== undefined
    ? { lastResultFingerprint: state.lastResultFingerprint }
    : {}),
  ...(state.resultFingerprints ? { resultFingerprints: copyStringRecord(state.resultFingerprints) } : {}),
  ...(state.resultFingerprintOrder ? { resultFingerprintOrder: [...state.resultFingerprintOrder] } : {}),
});

export { copyJPrefixRound };

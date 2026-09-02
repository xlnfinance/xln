import type {
  CertifiedEntityFrameLink,
  EntityCandidateEffect,
  EntityFrameEvent,
} from '../../entity/types';
import type { EntityCommandNonceState } from '../../types/entity-tx';
import {
  computeEntityAccountDigests,
  computeEntityAccountFieldDigests,
  computeEntityConsensusSectionDigestsCold,
} from '../../entity/consensus/state-root';
import type { FrameLogEntry } from '../../types/logging';
import type { RoutedEntityInput, RuntimeReplica } from '../types';

export type RuntimeParityEvidenceCapture = Readonly<{
  entityFrames: readonly Readonly<{
    entityId: string;
    signerId: string;
    accountsRoot: string;
    sectionDigests: ReadonlyArray<Readonly<{ field: string; digest: string }>>;
    accountFieldDigests: ReturnType<typeof computeEntityAccountFieldDigests>;
    accountDigests: ReturnType<typeof computeEntityAccountDigests>;
    entityCommandNonces?: EntityCommandNonceState;
    link: CertifiedEntityFrameLink;
  }>[];
  entityFrameEvents: readonly EntityFrameEvent[];
  entityEffectLogs: readonly FrameLogEntry[];
  localContinuations: readonly RoutedEntityInput[];
}>;

type ActiveRuntimeParityEvidence = {
  entityFrames: Array<{
    entityId: string;
    signerId: string;
    accountsRoot: string;
    sectionDigests: ReadonlyArray<Readonly<{ field: string; digest: string }>>;
    accountFieldDigests: ReturnType<typeof computeEntityAccountFieldDigests>;
    accountDigests: ReturnType<typeof computeEntityAccountDigests>;
    entityCommandNonces?: EntityCommandNonceState;
    link: CertifiedEntityFrameLink;
  }>;
  entityFrameEvents: EntityFrameEvent[];
  entityEffectLogs: FrameLogEntry[];
  localContinuations: RoutedEntityInput[];
};

const activeCaptures = new Map<RuntimeReplica, ActiveRuntimeParityEvidence>();

/** Begin one replay-only Runtime-frame observation window. */
export const beginRuntimeParityEvidence = (env: RuntimeReplica): void => {
  if (activeCaptures.has(env)) {
    throw new Error('RUNTIME_PARITY_EVIDENCE_ALREADY_ACTIVE');
  }
  activeCaptures.set(env, {
    entityFrames: [],
    entityFrameEvents: [],
    entityEffectLogs: [],
    localContinuations: [],
  });
};

/**
 * Capture committed Entity facts before Runtime recovery clears its transient
 * frame buffer. Candidate effects are already in canonical transition order;
 * preserving that order is part of TS/Rust parity.
 */
export const captureCommittedEntityParityEvidence = (
  env: RuntimeReplica,
  effects: readonly EntityCandidateEffect[],
): void => {
  if (activeCaptures.size === 0) return;
  const capture = activeCaptures.get(env);
  if (!capture) return;
  for (const effect of effects) {
    if (effect.kind === 'entityFrameCommitted') {
      const replica = env.state.eReplicas.get(`${effect.entityId}:${effect.signerId}`);
      if (!replica) throw new Error('RUNTIME_PARITY_EVIDENCE_ENTITY_MISSING');
      capture.entityFrames.push(structuredClone({
        entityId: effect.entityId,
        signerId: effect.signerId,
        accountsRoot: replica.state.accounts.rootHash(),
        sectionDigests: computeEntityConsensusSectionDigestsCold(replica.state),
        accountFieldDigests: computeEntityAccountFieldDigests(replica.state),
        accountDigests: computeEntityAccountDigests(replica.state),
        ...(replica.state.entityCommandNonces
          ? { entityCommandNonces: replica.state.entityCommandNonces }
          : {}),
        link: effect.link,
      }));
      capture.entityFrameEvents.push(...structuredClone(effect.link.frame.events));
    }
  }
};

/** Capture the exact Runtime frame log immediately before recovery clears it. */
export const captureRuntimeParityEffectLogs = (
  env: RuntimeReplica,
  logs: readonly FrameLogEntry[],
): void => {
  if (activeCaptures.size === 0) return;
  const capture = activeCaptures.get(env);
  if (!capture) return;
  capture.entityEffectLogs.push(...structuredClone(logs));
};

/** Capture the exact ordered self-routed values at the Runtime output-plan seam. */
export const capturePlannedLocalContinuations = (
  env: RuntimeReplica,
  inputs: readonly RoutedEntityInput[],
): void => {
  if (activeCaptures.size === 0) return;
  const capture = activeCaptures.get(env);
  if (!capture) return;
  capture.localContinuations.push(...structuredClone(inputs));
};

/** Finish one replay-only Runtime-frame observation window. */
export const finishRuntimeParityEvidence = (
  env: RuntimeReplica,
): RuntimeParityEvidenceCapture => {
  const capture = activeCaptures.get(env);
  if (!capture) throw new Error('RUNTIME_PARITY_EVIDENCE_NOT_ACTIVE');
  activeCaptures.delete(env);
  return capture;
};

export const discardRuntimeParityEvidence = (env: RuntimeReplica): void => {
  activeCaptures.delete(env);
};

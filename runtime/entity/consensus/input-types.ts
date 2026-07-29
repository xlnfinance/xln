import type { EntityInput, EntityOutput, EntityCandidateEffect, EntityReplica, EntityState } from '../types';
import type { RuntimeState } from '../../types';
import type { JInput } from '../../jurisdiction/input';
import type { RuntimeOverlayRecord } from '../../types/account';

export type EntityInputOutcome =
  | { kind: 'committed' }
  | { kind: 'noop'; reason: string }
  | { kind: 'deferred'; reason: string }
  | { kind: 'rejected'; code: string };

export type ApplyEntityInputResult = {
  outcome: EntityInputOutcome;
  newState: EntityState;
  outputs: EntityOutput[];
  jOutputs: JInput[];
  workingReplica: EntityReplica;
  candidateEffects: EntityCandidateEffect[];
  storageChanges: RuntimeOverlayRecord[];
  canonicalAppliedInput?: EntityInput;
};

export type ApplyEntityInputContext = {
  env: RuntimeState;
  entityInput: EntityInput;
  workingReplica: EntityReplica;
  entityOutbox: EntityOutput[];
  jOutbox: JInput[];
  candidateEffects: EntityCandidateEffect[];
  storageChanges: RuntimeOverlayRecord[];
  frameHash: string;
  /** False while Runtime stages one touched-only Entity candidate. */
  promoteCandidateState: boolean;
  canonicalAppliedInput?: EntityInput;
};

export const commitEntityConsensusInput = (
  context: ApplyEntityInputContext,
): ApplyEntityInputResult => ({
  outcome: { kind: 'committed' },
  newState: context.workingReplica.state,
  outputs: context.entityOutbox,
  jOutputs: context.jOutbox,
  workingReplica: context.workingReplica,
  candidateEffects: context.candidateEffects,
  storageChanges: context.storageChanges,
  ...(context.canonicalAppliedInput
    ? { canonicalAppliedInput: context.canonicalAppliedInput }
    : {}),
});

export const noopEntityConsensusInput = (
  context: ApplyEntityInputContext,
  reason: string,
): ApplyEntityInputResult => ({
  outcome: { kind: 'noop', reason },
  newState: context.workingReplica.state,
  outputs: [],
  jOutputs: [],
  workingReplica: context.workingReplica,
  candidateEffects: [],
  storageChanges: [],
});

export const deferEntityConsensusInput = (
  context: ApplyEntityInputContext,
  reason: string,
): ApplyEntityInputResult => ({
  outcome: { kind: 'deferred', reason },
  newState: context.workingReplica.state,
  outputs: [],
  jOutputs: [],
  workingReplica: context.workingReplica,
  candidateEffects: [],
  storageChanges: [],
});

export const rejectEntityConsensusInput = (
  context: ApplyEntityInputContext,
  code = 'ENTITY_CONSENSUS_REJECTED',
): ApplyEntityInputResult => ({
  outcome: { kind: 'rejected', code },
  newState: context.workingReplica.state,
  outputs: [],
  jOutputs: [],
  workingReplica: context.workingReplica,
  candidateEffects: [],
  storageChanges: [],
});

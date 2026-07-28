import type {
  EntityInput,
  EntityReplica,
  EntityState,
  RuntimeState,
  JInput,
} from '../../types';

export type EntityInputOutcome =
  | { kind: 'committed' }
  | { kind: 'noop'; reason: string }
  | { kind: 'deferred'; reason: string }
  | { kind: 'rejected'; code: string };

export type ApplyEntityInputResult = {
  outcome: EntityInputOutcome;
  newState: EntityState;
  outputs: EntityInput[];
  jOutputs: JInput[];
  workingReplica: EntityReplica;
  canonicalAppliedInput?: EntityInput;
};

export type ApplyEntityInputContext = {
  env: RuntimeState;
  entityInput: EntityInput;
  workingReplica: EntityReplica;
  entityOutbox: EntityInput[];
  jOutbox: JInput[];
  frameHash: string;
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
});

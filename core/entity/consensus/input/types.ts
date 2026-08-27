import type {
  EntityCandidate,
  EntityCandidateEffect,
  EntityInput,
  EntityOutput,
  EntityReplica,
  EntityState,
} from '../../types';
import type { EntityRuntimeContext } from '../../runtime-context';
import type { JInput } from '../../../jurisdiction/machine/input';
import type { RuntimeOverlayRecord } from '../../../types/account';
import type { EntityInfraContext } from '../../../types/entity/infra-context';

/**
 * Entity-facing view of one Runtime-routed input.
 *
 * Runtime owns transport and durability. Entity sees only provenance required
 * to order or atomically pair already-admitted inputs; it cannot inspect the
 * parent Runtime queue or transport implementation.
 */
export interface EntityConsensusInput extends EntityInput {
  sourceRuntimeFrame?: {
    height: number;
    timestamp: number;
  };
  atomicCrossJurisdictionPair?: {
    phase: 'proposal' | 'ack';
    pairKey: string;
  };
}

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
  accountJClaimNodeChanges?: EntityCandidate['accountJClaimNodeChanges'];
  canonicalAppliedInput?: EntityInput;
  /** Exact Entity frame context produced or accepted by this input. */
  entityContext?: EntityInfraContext;
};

export type ApplyEntityInputContext = {
  env: EntityRuntimeContext;
  entityInput: EntityInput;
  workingReplica: EntityReplica;
  entityOutbox: EntityOutput[];
  jOutbox: JInput[];
  candidateEffects: EntityCandidateEffect[];
  storageChanges: RuntimeOverlayRecord[];
  accountJClaimNodeChanges?: EntityCandidate['accountJClaimNodeChanges'];
  frameHash: string;
  /** False while Runtime stages one touched-only Entity candidate. */
  promoteCandidateState: boolean;
  /**
   * Trusted same-Runtime cross-J cascades are separate Entity frames created
   * after the persisted external input commits. They must materialize their
   * own height/parent-bound context during replay instead of reusing the
   * external input's context stored under the same local replica key.
   */
  usePersistedReplayContext: boolean;
  canonicalAppliedInput?: EntityInput;
  entityContext?: EntityInfraContext;
  /** Pool Hanko recovery for the proposal candidates, started at proposal start. */
  hankoPriming?: Promise<number> | null;
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
  ...(context.accountJClaimNodeChanges
    ? { accountJClaimNodeChanges: context.accountJClaimNodeChanges }
    : {}),
  ...(context.canonicalAppliedInput
    ? { canonicalAppliedInput: context.canonicalAppliedInput }
    : {}),
  ...(context.entityContext ? { entityContext: context.entityContext } : {}),
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

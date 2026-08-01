import type { EntityInputOutcome } from '../entity/consensus/index';
import type { EntityTx } from '../types/entity-tx';
import type { JInput } from '../jurisdiction/machine/input';
import type { RoutedEntityInput } from './types';
import type { RuntimeEntityRoutingDeps } from './entity-routing';
import {
  classifyEntityInputApplyFailure,
  type EntityInputApplyFailureKind,
} from '../entity/tx/invariant-errors';
import { nodeProcess } from '../infra/runtime-process';
import {
  isRuntimePerfProfileEnabled,
  readRuntimePerfSlowMs,
} from '../infra/perf-runtime-flags';
import { createStructuredLogger } from '../infra/logger';

export const entityInputLog = createStructuredLogger('runtime.entity_inputs');

export const isCommittedEntityInput = (
  outcome: EntityInputOutcome,
): boolean => outcome.kind === 'committed';

const ENTITY_INPUT_PROFILE =
  nodeProcess?.env?.['XLN_ENTITY_INPUT_PROFILE'] === '1' ||
  nodeProcess?.env?.['XLN_RUNTIME_PROCESS_PROFILE'] === '1';
const ENTITY_INPUT_SLOW_MS = Math.max(
  0,
  Number(nodeProcess?.env?.['XLN_ENTITY_INPUT_SLOW_MS'] || '1000'),
);

export const entityInputProfileEnabled = (): boolean =>
  ENTITY_INPUT_PROFILE ||
  isRuntimePerfProfileEnabled('XLN_ENTITY_INPUT_PROFILE');

export const entityInputSlowMs = (): number =>
  readRuntimePerfSlowMs('XLN_ENTITY_INPUT_SLOW_MS', ENTITY_INPUT_SLOW_MS);

export interface RuntimeEntityInputApplyResult {
  entityOutbox: RoutedEntityInput[];
  appliedEntityInputs: RoutedEntityInput[];
  inputOutcomes: Array<{
    inputIndex: number;
    outcome: EntityInputOutcome;
    entityFrameCommitted: boolean;
    committedAccountFrames: Array<{
      counterpartyEntityId: string;
      height: number;
      stateHash: string;
    }>;
  }>;
  localCrossJurisdictionEventTrace: RoutedEntityInput[];
  rejectedAtomicPairs: Array<{
    inputIndexes: [number, number];
    code:
      | 'CROSS_J_ACCOUNT_PAIR_PROTOCOL_REJECTED'
      | 'CROSS_J_ACCOUNT_PAIR_NOT_COMMITTED';
    detail: string;
  }>;
  entityFrameCommitted: boolean;
  jOutbox: JInput[];
}

/**
 * Preserves the failure class across the EntityInput boundary.
 *
 * Admission failures are discarded before mutation. Reducer, storage, and
 * internal failures remain fatal because they may describe corrupt committed
 * State and must never be downgraded by matching an error string.
 */
export class RuntimeEntityInputApplyError extends Error {
  readonly entityId: string;
  readonly signerId: string;
  readonly sourceRuntimeId: string;
  readonly sourceRuntimeHeight: number | undefined;
  readonly sourceRuntimeTimestamp: number | undefined;
  readonly trustedLocalCrossJurisdiction: boolean;
  readonly failureKind: EntityInputApplyFailureKind;

  constructor(
    input: RoutedEntityInput,
    trustedLocalCrossJurisdiction: boolean,
    cause: unknown,
    failureKind: EntityInputApplyFailureKind =
      classifyEntityInputApplyFailure(cause),
  ) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(
      `RUNTIME_ENTITY_INPUT_APPLY_FAILED:entity=${input.entityId}:` +
        `signer=${input.signerId}:txs=${(input.entityTxs ?? [])
          .map(tx => tx.type)
          .join(',') || 'none'}:` +
        `proposal=${input.proposedFrame ? 'yes' : 'no'}:cause=${message}`,
      { cause },
    );
    this.name = 'RuntimeEntityInputApplyError';
    this.entityId = input.entityId;
    this.signerId = input.signerId;
    this.sourceRuntimeId = String(input.from ?? '').trim();
    this.sourceRuntimeHeight = input.sourceRuntimeFrame?.height;
    this.sourceRuntimeTimestamp = input.sourceRuntimeFrame?.timestamp;
    this.trustedLocalCrossJurisdiction = trustedLocalCrossJurisdiction;
    this.failureKind = failureKind;
  }

  get isRemoteIngress(): boolean {
    return (
      this.sourceRuntimeId.length > 0 &&
      !this.trustedLocalCrossJurisdiction
    );
  }

  get isDiscardableIngress(): boolean {
    return (
      this.failureKind === 'unroutable-ingress' ||
      (this.failureKind === 'malformed-ingress' && this.isRemoteIngress)
    );
  }
}

/** Runtime-private map/reduce command; it is never serialized as EntityInput. */
export type CrossJCommand = {
  sourceEntityId: string;
  targetEntityId: string;
  targetSignerId: string;
  entityTxs: EntityTx[];
};

export interface RuntimeEntityInputApplyOptions {
  isReplay: boolean;
  routingDeps: RuntimeEntityRoutingDeps;
  beforeEntityApply?: (entityId: string) => void;
}

export type RuntimeEntityInputBatchContext = {
  entityOutbox: RoutedEntityInput[];
  appliedEntityInputs: RoutedEntityInput[];
  inputOutcomes: RuntimeEntityInputApplyResult['inputOutcomes'];
  localCrossJurisdictionEventTrace: RoutedEntityInput[];
  rejectedAtomicPairs: RuntimeEntityInputApplyResult['rejectedAtomicPairs'];
  entityFrameCommitted: boolean;
  jOutbox: JInput[];
  profiledInputs: Array<Record<string, unknown>>;
  crossJCommandQueue: CrossJCommand[];
  localEventCount: number;
  externalApplyMs: number;
  immediateCrossJApplyMs: number;
};

export const createRuntimeEntityInputBatchContext = (
  initialJOutbox: JInput[],
): RuntimeEntityInputBatchContext => ({
  entityOutbox: [],
  appliedEntityInputs: [],
  inputOutcomes: [],
  localCrossJurisdictionEventTrace: [],
  rejectedAtomicPairs: [],
  entityFrameCommitted: false,
  jOutbox: [...initialJOutbox],
  profiledInputs: [],
  crossJCommandQueue: [],
  localEventCount: 0,
  externalApplyMs: 0,
  immediateCrossJApplyMs: 0,
});

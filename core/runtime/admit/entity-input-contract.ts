import type { EntityInputOutcome } from '../../entity/consensus/index.ts';
import type { EntityTx } from '../../types/entity-tx.ts';
import type { JInput } from '../../jurisdiction/machine/input.ts';
import type { RoutedEntityInput } from '../types.ts';
import type { RuntimeEntityRoutingDeps } from '../delivery/topology/entity-routing.ts';
import {
  classifyEntityInputApplyFailure,
  entityInputFailureDisposition,
  MalformedEntityFrameInputError,
  type EntityInputApplyFailureKind,
} from '../../entity/tx/processing/invariant-errors.ts';
import type { FailureDisposition } from '../../protocol/errors/failure-taxonomy.ts';
import { toRuntimeId, type RuntimeId } from '../../protocol/identity/index.ts';
import { toRuntimeHeight, toUnixMs, type RuntimeHeight, type UnixMs } from '../../protocol/units.ts';
import { nodeProcess } from '../../support/process/runtime-process.ts';
import {
  isRuntimePerfProfileEnabled,
  readRuntimePerfSlowMs,
} from '../../support/performance/runtime-flags.ts';
import { createStructuredLogger } from '../../support/logger.ts';
import type { EntityInfraContext } from '../../types/entity/infra-context.ts';

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
  entityContexts: Map<string, EntityInfraContext>;
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
    /** Both legs are stamped atomicCrossJurisdictionPair — never a payment entity. */
    entityIds: [string, string];
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
  readonly sourceRuntimeId: RuntimeId | undefined;
  readonly sourceRuntimeHeight: RuntimeHeight | undefined;
  readonly sourceRuntimeTimestamp: UnixMs | undefined;
  readonly trustedLocalCrossJurisdiction: boolean;
  readonly failureKind: EntityInputApplyFailureKind;
  readonly disposition: FailureDisposition;
  readonly rejectionCode: string;

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
    if (cause instanceof Error && cause.stack && this.stack) {
      this.stack += `\nCaused by: ${cause.stack}`;
    }
    this.entityId = input.entityId;
    this.signerId = input.signerId;
    const sourceRuntimeId = String(input.from ?? '').trim();
    this.sourceRuntimeId = sourceRuntimeId.length === 0
      ? undefined
      : toRuntimeId(sourceRuntimeId);
    this.sourceRuntimeHeight = input.sourceRuntimeFrame === undefined
      ? undefined
      : toRuntimeHeight(input.sourceRuntimeFrame.height);
    this.sourceRuntimeTimestamp = input.sourceRuntimeFrame === undefined
      ? undefined
      : toUnixMs(input.sourceRuntimeFrame.timestamp);
    this.trustedLocalCrossJurisdiction = trustedLocalCrossJurisdiction;
    this.failureKind = failureKind;
    this.disposition = entityInputFailureDisposition(failureKind);
    this.rejectionCode = cause instanceof MalformedEntityFrameInputError
      ? cause.rejection
      : failureKind;
  }

  get isRemoteIngress(): boolean {
    return (
      this.sourceRuntimeId !== undefined &&
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
export type CrossJCommand =
  | {
      kind: 'entity-txs';
      sourceEntityId: string;
      sourceSignerId: string;
      targetEntityId: string;
      targetSignerId: string;
      entityTxs: EntityTx[];
    }
  | {
      /**
       * A committed Entity frame queued Account work but could not propose it
       * in that same frame. Runtime immediately derives H+1 inside the same
       * atomic Runtime transition; this command is never a network message.
       */
      kind: 'account-work';
      sourceEntityId: string;
      targetEntityId: string;
      targetSignerId: string;
    };

export interface RuntimeEntityInputApplyOptions {
  isReplay: boolean;
  routingDeps: RuntimeEntityRoutingDeps;
  beforeEntityApply?: (entityId: string) => void;
}

export type RuntimeEntityInputBatchContext = {
  entityContexts: Map<string, EntityInfraContext>;
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
  entityCommitInputShapes: Map<string, string>;
};

export const createRuntimeEntityInputBatchContext = (
  initialJOutbox: JInput[],
): RuntimeEntityInputBatchContext => ({
  entityContexts: new Map(),
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
  entityCommitInputShapes: new Map(),
});

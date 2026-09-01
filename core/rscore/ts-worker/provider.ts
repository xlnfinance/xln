import type { HandleAccountInputResult, ProposeAccountFrameResult } from '../../account/consensus/types';
import { replaceAccountReplica } from '../../account/state/candidate-overlay';
import { rememberEngineAccountLeaf } from '../cutover/leaf-registry';
import {
  hydrateAccountDocFromStorage,
  projectPortableAccountDoc,
} from '../../storage/read/projections';
import {
  assertStorageAccountDocBinding,
  validateStorageAccountDocValue,
} from '../../storage/schema/schema-state-docs';
import type { RuntimeReplica } from '../../runtime/types';
import type { AccountInput, AccountTxBatch } from '../../types/account';
import type { AccountJClaimNode } from '../../types/finance/account-j-claims';
import { collectReachableAccountJClaimNodes } from '../../account/j-claims/j-claim-accumulator';
import { getAccountJClaimNodeStore } from '../../entity/account/account-j-claim-node-store';
import type {
  AccountAuthorityEntityBatchInbound,
  AccountAuthorityEntityBatchOutbound,
  AccountAuthorityEntityOccurrence,
  AccountAuthorityEntityStageProvider,
} from '../authority/entity-stage';
import type { AccountAuthorityInputRequest } from '../../account/consensus/context';
import { safeStringify } from '../../protocol/serialization';
import {
  countOp,
  OP_COUNTERS_ENABLED,
  type OpCounterSnapshot,
} from '../../support/performance/op-counters';
import { failedProposalHtlcFollowup } from '../../entity/consensus/account/failed-proposal-followups';
import { accountHankoWitnessRequirements } from '../../entity/consensus/input/hanko-witness';
import { TsAccountWorkerCoordinator } from './coordinator';
import { assertAccountRootMatch } from './root-divergence';
import type {
  TsAccountWorkerBatchResult,
  TsAccountWorkerEffect,
  TsAccountWorkerPostAccount,
  TsAccountWorkerCertifiedBoard,
} from './protocol';
import {
  getCertifiedBoardNodeStore,
  resolveObserverCertifiedBoardRecord,
} from '../../jurisdiction/machine/board-registry';

type WorkerTotals = {
  operations: number;
  workMs: number;
  transitionMs: number;
  proposalMs: number;
  rootMs: number;
  materializeMs: number;
  encodeMs: number;
  decodeMs: number;
  workerEncodeMs: number;
  threadCpuUserMs: number;
  threadCpuSystemMs: number;
  requestBytes: number;
  responseBytes: number;
};

type PhaseTotals = WorkerTotals & {
  calls: number;
  waveWallMs: number;
  dispatchMs: number;
  joinMs: number;
  foldMs: number;
};

export type TsAccountWorkerTelemetry = Readonly<{
  workers: number;
  initializedAccounts: number;
  logicalShards: number;
  initializationRequestBytes: number;
  initializationResponseBytes: number;
  phases: Readonly<Record<'inbound' | 'proposal', Readonly<PhaseTotals>>>;
  perWorker: readonly Readonly<WorkerTotals & {
    workerIndex: number;
    utilization: number;
  }>[];
  rowsPerShard: readonly (readonly [shardId: number, rows: number])[];
  touchedShards: number;
  utilization: number;
  workerOperations: OpCounterSnapshot;
}>;

const emptyWorkerTotals = (): WorkerTotals => ({
  operations: 0,
  workMs: 0,
  transitionMs: 0,
  proposalMs: 0,
  rootMs: 0,
  materializeMs: 0,
  encodeMs: 0,
  decodeMs: 0,
  workerEncodeMs: 0,
  threadCpuUserMs: 0,
  threadCpuSystemMs: 0,
  requestBytes: 0,
  responseBytes: 0,
});

const emptyPhaseTotals = (): PhaseTotals => ({
  ...emptyWorkerTotals(), calls: 0, waveWallMs: 0, dispatchMs: 0, joinMs: 0, foldMs: 0,
});

const WORKER_TOTAL_KEYS: readonly (keyof WorkerTotals)[] = [
  'operations', 'workMs', 'transitionMs', 'proposalMs', 'rootMs', 'materializeMs',
  'encodeMs', 'decodeMs', 'workerEncodeMs', 'threadCpuUserMs', 'threadCpuSystemMs',
  'requestBytes', 'responseBytes',
];

const addWorkerTotals = (target: WorkerTotals, source: WorkerTotals): void => {
  for (const key of WORKER_TOTAL_KEYS) target[key] += source[key];
};

const normalize = (value: string): string => value.trim().toLowerCase();

const certifiedBoardFor = (
  env: RuntimeReplica,
  state: AccountAuthorityEntityBatchInbound['entityState'],
  entityIdInput: string,
): TsAccountWorkerCertifiedBoard | undefined => {
  const entityId = normalize(entityIdInput);
  const record = resolveObserverCertifiedBoardRecord(
    state,
    getCertifiedBoardNodeStore(env),
    entityId,
  );
  if (!record) return undefined;
  return {
    entityId,
    boardHash: record.boardHash,
    previousBoardHash: record.previousBoardHash,
    previousBoardValidUntil: record.previousBoardValidUntil,
    activatedAtJHeight: record.activatedAtJHeight,
    logIndex: record.logIndex,
  };
};

const reachableJClaimNodes = (
  env: RuntimeReplica,
  accounts: AccountAuthorityEntityBatchInbound['entityState']['accounts'],
): ReadonlyMap<string, AccountJClaimNode> => collectReachableAccountJClaimNodes(
  getAccountJClaimNodeStore(env),
  [...accounts.values()].flatMap(account => [
    account.state.leftPendingJClaims,
    account.state.rightPendingJClaims,
  ]),
);

const accountInput = (request: AccountAuthorityInputRequest): AccountInput => {
  const input = request.input;
  if (input.kind === 'enqueue' || input.kind === 'external_finality') {
    throw new Error(`TS_ACCOUNT_WORKER_PROVIDER_INBOUND_KIND:${input.kind}`);
  }
  return input;
};

const occurrenceFrameId = (
  ownerEntityId: string,
  occurrence: AccountAuthorityEntityOccurrence,
): string => occurrence.kind === 'runtime-input'
  ? `${ownerEntityId}:runtime-input:${occurrence.inputIndex}`
  : `${ownerEntityId}:local-event:${occurrence.ordinal}`;

const inboundEffect = (
  effect: TsAccountWorkerEffect | undefined,
  accountId: string,
  order: number,
): HandleAccountInputResult => {
  if (effect?.phase !== 'inbound' || effect.order !== order || effect.accountId !== accountId) {
    throw new Error(`TS_ACCOUNT_WORKER_PROVIDER_INBOUND_ORDER:${order}:${accountId}`);
  }
  return effect.result;
};

const replacePostAccount = (
  ownerEntityId: string,
  batch: AccountAuthorityEntityBatchOutbound,
  row: TsAccountWorkerPostAccount,
): void => {
  const accountId = normalize(row.accountId);
  const validated = assertStorageAccountDocBinding(
    validateStorageAccountDocValue(row.account),
    ownerEntityId,
    accountId,
    'ts-account-worker-post',
  );
  const prepared = hydrateAccountDocFromStorage(validated);
  const live = batch.accountForWrite(accountId);
  if (live === undefined) throw new Error(`TS_ACCOUNT_WORKER_PROVIDER_POST_ACCOUNT_MISSING:${accountId}`);
  replaceAccountReplica(live, prepared);
  rememberEngineAccountLeaf(ownerEntityId, accountId, row.entityAccountLeaf);
};

/**
 * Compensation the Entity owes upstream when a proposed Account frame could not
 * carry an HTLC lock forward. Each row becomes one continuation admission.
 */
const failedProposalContinuationRows = (
  entityState: AccountAuthorityEntityBatchOutbound['entityState'],
  preparedProposals: readonly Readonly<{ result: ProposeAccountFrameResult }>[],
): readonly Readonly<{ accountId: string; input: AccountTxBatch }>[] =>
  preparedProposals.flatMap(proposal => {
    const failures = 'failedHtlcLocks' in proposal.result
      ? proposal.result.failedHtlcLocks ?? []
      : [];
    return failures.flatMap(({ hashlock, reason }) => {
      const followup = failedProposalHtlcFollowup(entityState, { hashlock, reason });
      return followup.kind === 'forwarded'
        ? [{ accountId: normalize(followup.accountId), input: followup.input }]
        : [];
    });
  });

export class TsAccountWorkerAuthority {
  readonly #env: RuntimeReplica;
  readonly #workerCount: number;
  readonly #coordinators = new Map<string, Promise<TsAccountWorkerCoordinator>>();
  readonly #phases: Record<'inbound' | 'proposal', PhaseTotals> = {
    inbound: emptyPhaseTotals(), proposal: emptyPhaseTotals(),
  };
  readonly #workers = new Map<number, WorkerTotals>();
  readonly #rowsPerShard = new Map<number, number>();
  readonly #workerOperations: Record<string, { calls: number; bytes: number; durationUs: number }> = {};
  readonly provider: AccountAuthorityEntityStageProvider;

  constructor(env: RuntimeReplica, workerCount: number) {
    if (!Number.isSafeInteger(workerCount) || workerCount < 1 || workerCount > 64) {
      throw new Error(`TS_ACCOUNT_WORKER_PROVIDER_COUNT:${workerCount}`);
    }
    this.#env = env;
    this.#workerCount = workerCount;
    for (let workerIndex = 0; workerIndex < workerCount; workerIndex += 1) {
      this.#workers.set(workerIndex, emptyWorkerTotals());
    }
    this.provider = {
      executeAccountInboundBatch: batch => this.#executeInbound(batch),
      executeEntityBooksBatch: input => this.#executeBooks(input),
      executeAccountOutboundBatch: batch => this.#executeOutbound(batch),
      installCommittedAccountHankos: request => this.#installCommittedAccountHankos(request),
    };
  }

  async #executeBooks(input: Readonly<{
    ownerEntityId: string;
    request: import('../../entity/runtime-context').AccountAuthorityFrameBooksRequest;
  }>): Promise<void> {
    const ownerEntityId = normalize(input.ownerEntityId);
    const coordinator = await this.#coordinators.get(ownerEntityId);
    if (coordinator === undefined) {
      throw new Error(`TS_ACCOUNT_WORKER_PROVIDER_BOOK_COORDINATOR_MISSING:${ownerEntityId}`);
    }
    await coordinator.applyBookIntents(input.request.entityState, input.request.slots);
  }

  async #installCommittedAccountHankos(
    request: import('../../entity/runtime-context').AccountAuthorityCommittedHankosRequest,
  ): Promise<void> {
    const ownerEntityId = normalize(request.ownerEntityId);
    const coordinator = await this.#coordinators.get(ownerEntityId);
    if (coordinator === undefined) {
      throw new Error(`TS_ACCOUNT_WORKER_PROVIDER_HANKO_COORDINATOR_MISSING:${ownerEntityId}`);
    }
    const rows = [...new Set(request.touchedAccountIds.map(normalize))].sort().flatMap(accountId => {
      const account = request.entityState.accounts.get(accountId);
      if (!account) throw new Error(`TS_ACCOUNT_WORKER_PROVIDER_HANKO_ACCOUNT_MISSING:${accountId}`);
      const hankos = accountHankoWitnessRequirements(account).flatMap(requirement => {
        const witness = request.hankos.get(requirement.hash);
        if (!witness) return [];
        if (witness.type !== requirement.type) {
          throw new Error(
            `TS_ACCOUNT_WORKER_PROVIDER_HANKO_TYPE:${requirement.hash}:${requirement.type}:${witness.type}`,
          );
        }
        return [witness];
      });
      return hankos.length === 0 ? [] : [{ accountId, hankos }];
    });
    if (rows.length === 0) return;
    await coordinator.installCommittedAccountHankos({
      entityHeight: request.entityHeight,
      rows,
    });
  }

  #recordPhase(phase: 'inbound' | 'proposal', result: TsAccountWorkerBatchResult): void {
    const totals = this.#phases[phase];
    totals.calls += 1;
    totals.dispatchMs += result.timings.dispatchMs;
    totals.joinMs += result.timings.joinMs;
    totals.foldMs += result.timings.foldMs;
    totals.waveWallMs += result.timings.dispatchMs + result.timings.joinMs + result.timings.foldMs;
    if (OP_COUNTERS_ENABLED) {
      const prefix = `entity.phase.frameApply.accountWorker.${phase}`;
      // dispatch/join/fold are exclusive coordinator wall phases. The four
      // *Sum counters below are worker CPU/data-movement attribution and may
      // overlap that wall time; keeping the names explicit prevents adding
      // them as if they were another sequential phase.
      countOp(`${prefix}.dispatch`, 0, Math.round(result.timings.dispatchMs * 1_000));
      countOp(`${prefix}.join`, 0, Math.round(result.timings.joinMs * 1_000));
      countOp(`${prefix}.fold`, 0, Math.round(result.timings.foldMs * 1_000));
      countOp(`${prefix}.encodeSum`, 0, Math.round(result.timings.encodeMs * 1_000));
      countOp(`${prefix}.decodeSum`, 0, Math.round(result.timings.decodeMs * 1_000));
      countOp(`${prefix}.workerEncodeSum`, 0, Math.round(result.workers
        .reduce((sum, metric) => sum + metric.workerEncodeMs, 0) * 1_000));
      countOp(`${prefix}.workerWorkSum`, 0, Math.round(result.workers
        .reduce((sum, metric) => sum + metric.workMs, 0) * 1_000));
    }
    for (const metric of result.workers) {
      const worker = this.#workers.get(metric.workerIndex) ?? emptyWorkerTotals();
      const current: WorkerTotals = {
        operations: metric.operations,
        workMs: metric.workMs,
        transitionMs: metric.transitionMs,
        proposalMs: metric.proposalMs,
        rootMs: metric.rootMs,
        materializeMs: metric.materializeMs,
        encodeMs: metric.encodeMs,
        decodeMs: metric.decodeMs,
        workerEncodeMs: metric.workerEncodeMs,
        threadCpuUserMs: metric.threadCpuUserMs,
        threadCpuSystemMs: metric.threadCpuSystemMs,
        requestBytes: metric.requestBytes,
        responseBytes: metric.responseBytes,
      };
      addWorkerTotals(worker, current);
      addWorkerTotals(totals, current);
      this.#workers.set(metric.workerIndex, worker);
      for (const [shardId, rows] of metric.shardRows) {
        this.#rowsPerShard.set(shardId, (this.#rowsPerShard.get(shardId) ?? 0) + rows);
      }
      for (const [name, counter] of Object.entries(metric.operationsProfile)) {
        const aggregate = this.#workerOperations[name] ?? { calls: 0, bytes: 0, durationUs: 0 };
        aggregate.calls += counter.calls;
        aggregate.bytes += counter.bytes;
        aggregate.durationUs += counter.durationUs;
        this.#workerOperations[name] = aggregate;
      }
    }
  }

  async #coordinator(batch: AccountAuthorityEntityBatchInbound): Promise<TsAccountWorkerCoordinator> {
    const ownerEntityId = normalize(batch.ownerEntityId);
    let pending = this.#coordinators.get(ownerEntityId);
    if (pending === undefined) {
      const jClaimNodes = reachableJClaimNodes(this.#env, batch.entityState.accounts);
      pending = TsAccountWorkerCoordinator.create({
        ownerEntityId,
        workerCount: this.#workerCount,
        accounts: batch.entityState.accounts,
        jReplicas: this.#env.state.jReplicas,
        jClaimNodes,
      });
      this.#coordinators.set(ownerEntityId, pending);
    }
    return pending;
  }

  async #executeInbound(
    batch: AccountAuthorityEntityBatchInbound,
  ): Promise<readonly ((request: AccountAuthorityInputRequest) => HandleAccountInputResult)[]> {
    const coordinator = await this.#coordinator(batch);
    const frameId = occurrenceFrameId(batch.ownerEntityId, batch.occurrence);
    const localBoardAuthority = certifiedBoardFor(this.#env, batch.entityState, batch.ownerEntityId);
    const result = await coordinator.applyAccountInputs({
      frameId,
      expectedAccountsRoot: batch.expectedAccountsRoot,
      entityTimestamp: batch.requests[0]?.entityTimestamp ?? batch.entityState.timestamp,
      finalizedJHeight: batch.requests[0]?.finalizedJHeight ?? batch.entityState.lastFinalizedJHeight,
      owningEntityIsHub: Boolean(batch.entityState.hubRebalanceConfig),
      ...(localBoardAuthority ? { localBoardAuthority } : {}),
      inputs: batch.requests.map(request => {
        const counterpartyBoardAuthority = certifiedBoardFor(this.#env, batch.entityState, request.accountId);
        return {
          accountId: request.accountId,
          input: accountInput(request),
          ...(counterpartyBoardAuthority ? { counterpartyBoardAuthority } : {}),
          ...(request.genesisPolicy === undefined
            ? {}
            : { initialAccount: projectPortableAccountDoc(request.account) }),
        };
      }),
    });
    this.#recordPhase('inbound', result);
    if (result.accountsRoot !== undefined) {
      throw new Error('TS_ACCOUNT_WORKER_PROVIDER_INBOUND_ROOT_WAS_NOT_REQUESTED');
    }
    return batch.requests.map((request, order) => {
      const accountId = normalize(request.accountId);
      const prepared = inboundEffect(result.effects[order], accountId, order);
      return actual => {
        if (normalize(actual.account.proofHeader.toEntity) !== accountId
          || safeStringify(actual.input) !== safeStringify(request.input)) {
          throw new Error(`TS_ACCOUNT_WORKER_PROVIDER_INBOUND_BINDING:${order}:${accountId}`);
        }
        return prepared;
      };
    });
  }

  async #executeOutbound(batch: AccountAuthorityEntityBatchOutbound) {
    const ownerEntityId = normalize(batch.ownerEntityId);
    const coordinator = await this.#coordinators.get(ownerEntityId);
    if (coordinator === undefined) throw new Error(`TS_ACCOUNT_WORKER_PROVIDER_COORDINATOR_MISSING:${ownerEntityId}`);
    const frameId = occurrenceFrameId(ownerEntityId, batch.occurrence);
    const localBoardAuthority = certifiedBoardFor(this.#env, batch.entityState, ownerEntityId);
    const txs = batch.admissions.map(request => {
      if (request.input.kind !== 'enqueue') {
        throw new Error(`TS_ACCOUNT_WORKER_PROVIDER_ADMISSION_KIND:${request.input.kind}`);
      }
      const accountId = normalize(request.account.proofHeader.toEntity);
      // H=0 is an unsealed local genesis shell. Fitting/retry may revisit it
      // after the Entity map already contains it but before this worker has
      // published it. Carry that exact canonical shell until the first signed
      // AccountFrame; an existing resident value always wins in the worker.
      const initialAccount = request.account.currentHeight === 0
        && request.account.currentFrame.height === 0
        ? projectPortableAccountDoc(request.account)
        : undefined;
      const counterpartyBoardAuthority = certifiedBoardFor(this.#env, batch.entityState, accountId);
      return {
        accountId,
        txs: request.input.txs,
        ...(initialAccount === undefined ? {} : { initialAccount }),
        ...(counterpartyBoardAuthority ? { counterpartyBoardAuthority } : {}),
      };
    });
    const baseRoot = coordinator.accountsRoot;
    const result = await coordinator.prepareAccountFrames({
      frameId,
      timestamp: batch.proposals[0]?.timestamp
        ?? batch.admissions[0]?.entityTimestamp
        ?? batch.entityState.timestamp,
      jHeight: batch.proposals[0]?.jHeight
        ?? batch.admissions[0]?.finalizedJHeight
        ?? batch.entityState.lastFinalizedJHeight,
      ...(localBoardAuthority ? { localBoardAuthority } : {}),
      envelopeUpdates: batch.envelopeUpdates,
      txs,
      proposals: batch.proposals.map(request => {
        const accountId = normalize(request.account.proofHeader.toEntity);
        const counterpartyBoardAuthority = certifiedBoardFor(this.#env, batch.entityState, accountId);
        return { accountId, ...(counterpartyBoardAuthority ? { counterpartyBoardAuthority } : {}) };
      }),
    });
    this.#recordPhase('proposal', result);
    const admissions = result.effects.slice(0, batch.admissions.length);
    const proposals = result.effects.slice(batch.admissions.length);
    const preparedAdmissions = admissions.map((effect, order) => {
      const request = batch.admissions[order];
      if (request === undefined || effect?.phase !== 'outbound-enqueue') {
        throw new Error(`TS_ACCOUNT_WORKER_PROVIDER_ADMISSION_ORDER:${order}`);
      }
      return effect.result;
    });
    const preparedProposals = proposals.map((effect, order) => {
      const request = batch.proposals[order];
      const accountId = request && normalize(request.account.proofHeader.toEntity);
      if (accountId === undefined || effect?.phase !== 'outbound-proposal' || effect.accountId !== accountId) {
        throw new Error(`TS_ACCOUNT_WORKER_PROVIDER_PROPOSAL_ORDER:${order}:${accountId ?? 'missing'}`);
      }
      return { accountId, result: effect.result };
    });
    if (preparedAdmissions.some(result => !result.ok)) {
      throw new Error(`TS_ACCOUNT_WORKER_PROVIDER_ADMISSION_REJECTED:${safeStringify(preparedAdmissions)}`);
    }
    const generated = failedProposalContinuationRows(batch.entityState, preparedProposals);
    const continuationProposalIds = [...new Set(generated.map(row => row.accountId))];
    const continuation = await coordinator.finishAccountFrames({
      frameId,
      timestamp: batch.proposals[0]?.timestamp
        ?? batch.admissions[0]?.entityTimestamp
        ?? batch.entityState.timestamp,
      jHeight: batch.proposals[0]?.jHeight
        ?? batch.admissions[0]?.finalizedJHeight
        ?? batch.entityState.lastFinalizedJHeight,
      ...(localBoardAuthority ? { localBoardAuthority } : {}),
      envelopeUpdates: [],
      txs: generated.map(row => {
        const counterpartyBoardAuthority = certifiedBoardFor(this.#env, batch.entityState, row.accountId);
        return {
          accountId: row.accountId,
          txs: row.input.txs,
          ...(counterpartyBoardAuthority ? { counterpartyBoardAuthority } : {}),
        };
      }),
      proposals: continuationProposalIds.map(accountId => {
        const counterpartyBoardAuthority = certifiedBoardFor(this.#env, batch.entityState, accountId);
        return { accountId, ...(counterpartyBoardAuthority ? { counterpartyBoardAuthority } : {}) };
      }),
    });
    if (continuation) this.#recordPhase('proposal', continuation);
    const continuationAdmissions = continuation?.effects.slice(0, generated.length) ?? [];
    const generatedAdmissions = generated.map((row, order) => {
      const effect = continuationAdmissions[order];
      if (
        effect?.phase !== 'outbound-enqueue'
        || effect.accountId !== row.accountId
        || !effect.result.ok
        || effect.result.admittedAccountTxCount !== 1
      ) {
        throw new Error(`TS_ACCOUNT_WORKER_PROVIDER_GENERATED_ADMISSION:${order}:${row.accountId}`);
      }
      return { ...row, result: effect.result };
    });
    const continuationProposals = continuation?.effects.slice(generated.length).map((effect, order) => {
      const accountId = continuationProposalIds[order];
      if (effect?.phase !== 'outbound-proposal' || effect.accountId !== accountId) {
        throw new Error(`TS_ACCOUNT_WORKER_PROVIDER_CONTINUATION_PROPOSAL:${order}:${accountId ?? 'missing'}`);
      }
      const failures = 'failedHtlcLocks' in effect.result ? effect.result.failedHtlcLocks ?? [] : [];
      if (failures.length > 0) {
        const firstFailure = failures[0];
        if (!firstFailure) throw new Error('TS_ACCOUNT_WORKER_PROVIDER_HTLC_FOLLOWUP_FAILURE_MISSING');
        throw new Error(`TS_ACCOUNT_WORKER_PROVIDER_HTLC_FOLLOWUP_CASCADE:${accountId}:${firstFailure.hashlock}`);
      }
      return { accountId, result: effect.result };
    }) ?? [];
    const postAccounts = new Map<string, TsAccountWorkerPostAccount>();
    for (const row of result.postAccounts ?? []) postAccounts.set(row.accountId, row);
    for (const row of continuation?.postAccounts ?? []) postAccounts.set(row.accountId, row);
    for (const row of postAccounts.values()) replacePostAccount(ownerEntityId, batch, row);
    const finalRoot = continuation?.accountsRoot ?? result.accountsRoot;
    if (finalRoot === undefined) {
      throw new Error('TS_ACCOUNT_WORKER_PROVIDER_FINAL_ROOT_MISSING');
    }
    // Halting on the bare hash pair costs a whole reproduction run to learn
    // which Account moved, so the assertion carries its own evidence.
    assertAccountRootMatch({
      frameId,
      workers: this.#workerCount,
      entityTxTypes: batch.unsupportedEntityTxTypes,
      baseRoot,
      prepare: result,
      continuation,
      continuationTxAccountIds: generated.map(row => row.accountId),
      continuationProposalAccountIds: continuationProposalIds,
      applied: postAccounts,
      accounts: batch.entityState.accounts,
      finalRoot,
      entityRoot: batch.entityState.accounts.rootHash(),
    });
    return {
      proposals: [...preparedProposals, ...continuationProposals],
      generatedAdmissions,
    };
  }

  async close(): Promise<void> {
    const coordinators = await Promise.all(this.#coordinators.values());
    for (const coordinator of coordinators) coordinator.close();
    this.#coordinators.clear();
  }

  async telemetry(): Promise<TsAccountWorkerTelemetry> {
    const coordinators = await Promise.all(this.#coordinators.values());
    const initialization = coordinators.map(coordinator => coordinator.initialization);
    const waveWallMs = this.#phases.inbound.waveWallMs + this.#phases.proposal.waveWallMs;
    const perWorker = [...this.#workers].sort(([left], [right]) => left - right)
      .map(([workerIndex, totals]) => ({
        workerIndex,
        ...totals,
        utilization: waveWallMs === 0 ? 0 : totals.workMs / waveWallMs,
      }));
    return {
      workers: this.#workerCount,
      initializedAccounts: initialization.reduce((sum, row) => sum + row.accounts, 0),
      logicalShards: initialization[0]?.logicalShards ?? 4096,
      initializationRequestBytes: initialization.reduce((sum, row) => sum + row.requestBytes, 0),
      initializationResponseBytes: initialization.reduce((sum, row) => sum + row.responseBytes, 0),
      phases: {
        inbound: { ...this.#phases.inbound },
        proposal: { ...this.#phases.proposal },
      },
      perWorker,
      rowsPerShard: [...this.#rowsPerShard].sort(([left], [right]) => left - right),
      touchedShards: this.#rowsPerShard.size,
      utilization: waveWallMs === 0
        ? 0
        : perWorker.reduce((sum, row) => sum + row.workMs, 0) / (this.#workerCount * waveWallMs),
      workerOperations: Object.fromEntries(Object.entries(this.#workerOperations)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, counter]) => [name, { ...counter }])),
    };
  }
}

export const canonicalTsAccountWorkerCount = (): number => {
  const processValue = Reflect.get(globalThis, 'process') as
    | { env?: Record<string, string | undefined> }
    | undefined;
  const configured = Number(processValue?.env?.['XLN_TS_ACCOUNT_WORKERS'] ?? '');
  if (Number.isSafeInteger(configured) && configured >= 1 && configured <= 64) return configured;
  const hardwareConcurrency = typeof navigator === 'undefined' ? 8 : navigator.hardwareConcurrency;
  return Math.max(1, Math.min(8, hardwareConcurrency || 8));
};

/** Install the sole TypeScript H1 Account executor before its first frame. */
export const installTsAccountWorkerAuthority = (env: RuntimeReplica): void => {
  if (env.accountAuthorityExecutionMode !== undefined) return;
  const processValue = Reflect.get(globalThis, 'process') as
    | { env?: Record<string, string | undefined> }
    | undefined;
  // Sovereign user Runtime hosts already shard whole Runtime instances across
  // OS workers. Spawning another Account worker pool per Runtime multiplies a
  // 1,000-user HLT into thousands of threads without adding Account-level
  // parallelism. Zero explicitly selects the canonical inline TS transition;
  // Hub processes keep their configured/default shared Account worker pool.
  if (processValue?.env?.['XLN_TS_ACCOUNT_WORKERS'] === '0') {
    if (processValue.env?.['XLN_HUB_NAME']?.toUpperCase() === 'H1') {
      throw new Error('TS_H1_BOOK_WORKER_PROVIDER_REQUIRED');
    }
    return;
  }
  const authority = new TsAccountWorkerAuthority(env, canonicalTsAccountWorkerCount());
  env.accountAuthorityExecutionMode = 'cutover';
  env.accountAuthorityEntityStageProvider = authority.provider;
};

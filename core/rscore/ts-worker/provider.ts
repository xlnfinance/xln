import type { HandleAccountInputResult } from '../../account/consensus/types';
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
import type { AccountPeerInput } from '../../types/account';
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
import type { OpCounterSnapshot } from '../../support/performance/op-counters';
import { TsAccountWorkerCoordinator } from './coordinator';
import type {
  TsAccountWorkerBatchResult,
  TsAccountWorkerEffect,
  TsAccountWorkerPostAccount,
} from './protocol';

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

const peerInput = (request: AccountAuthorityInputRequest): AccountPeerInput => {
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
      beginEntityStage: () => Promise.reject(new Error('TS_ACCOUNT_WORKER_PROVIDER_OBSERVE_UNSUPPORTED')),
      executeAccountInboundBatch: batch => this.#executeInbound(batch),
      executeAccountOutboundBatch: batch => this.#executeOutbound(batch),
    };
  }

  #recordPhase(phase: 'inbound' | 'proposal', result: TsAccountWorkerBatchResult): void {
    const totals = this.#phases[phase];
    totals.calls += 1;
    totals.dispatchMs += result.timings.dispatchMs;
    totals.joinMs += result.timings.joinMs;
    totals.foldMs += result.timings.foldMs;
    totals.waveWallMs += result.timings.dispatchMs + result.timings.joinMs + result.timings.foldMs;
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
    const result = await coordinator.applyAccountInputs({
      frameId,
      expectedAccountsRoot: batch.expectedAccountsRoot,
      entityTimestamp: batch.requests[0]?.entityTimestamp ?? batch.entityState.timestamp,
      finalizedJHeight: batch.requests[0]?.finalizedJHeight ?? batch.entityState.lastFinalizedJHeight,
      inputs: batch.requests.map(request => ({
        accountId: request.accountId,
        input: peerInput(request),
        ...(request.genesisPolicy === undefined
          ? {}
          : { initialAccount: projectPortableAccountDoc(request.account) }),
      })),
    });
    this.#recordPhase('inbound', result);
    if (result.accountsRoot === batch.expectedAccountsRoot && batch.requests.length > 0) {
      // A duplicate may legitimately retain the root; effects still prove exact arity/order below.
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
    const result = await coordinator.proposeAccountFrames({
      frameId,
      timestamp: batch.proposals[0]?.timestamp
        ?? batch.admissions[0]?.entityTimestamp
        ?? batch.entityState.timestamp,
      jHeight: batch.proposals[0]?.jHeight
        ?? batch.admissions[0]?.finalizedJHeight
        ?? batch.entityState.lastFinalizedJHeight,
      txs: batch.admissions.map(request => {
        if (request.input.kind !== 'enqueue') {
          throw new Error(`TS_ACCOUNT_WORKER_PROVIDER_ADMISSION_KIND:${request.input.kind}`);
        }
        return { accountId: normalize(request.account.proofHeader.toEntity), txs: request.input.txs };
      }),
      proposalAccountIds: batch.proposals.map(request => normalize(request.account.proofHeader.toEntity)),
    });
    this.#recordPhase('proposal', result);
    for (const row of result.postAccounts ?? []) replacePostAccount(ownerEntityId, batch, row);
    const accountRoot = batch.entityState.accounts.rootHash();
    if (accountRoot !== result.accountsRoot) {
      throw new Error(`TS_ACCOUNT_WORKER_PROVIDER_ROOT_MISMATCH:${result.accountsRoot}:${accountRoot}`);
    }
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
    return { proposals: preparedProposals, generatedAdmissions: [] };
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

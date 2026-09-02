import { projectPortableAccountDoc } from '../../storage/read/projections';
import { buildCanonicalJReplicaSnapshot } from '../../storage/wal/snapshot';
import {
  createBalancedTsAccountShardAssignment,
  normalizeTsWorkerAccountId,
  TS_ACCOUNT_LOGICAL_SHARDS,
  TsAccountCanonicalRoot,
  tsAccountLogicalShard,
  tsAccountWorkerForShard,
  validateTsAccountShardAssignment,
} from './sharding';
import type {
  TsApplyAccountInputsRequest,
  TsProposeAccountFramesRequest,
  TsAccountWorkerBatchResult,
  TsAccountWorkerCommittedHankoRow,
  TsAccountWorkerInitialization,
  TsAccountWorkerInstallHankosPayload,
  TsAccountWorkerInstallHankosResult,
  TsAccountWorkerInitPayload,
  TsAccountWorkerOptions,
  TsAccountWorkerPhasePayload,
  TsBookWorkerPayload,
  TsBookWorkerResult,
} from './protocol';
import {
  asWorkerError,
  parseWorkerInitResult,
  parseBookWorkerResult,
  requireWorkerFrameId,
  requireWorkerInteger,
  TsAccountWorkerClient,
} from './coordinator-client';
import type { BookIntentSlot } from '../../entity/books/book-intents';
import {
  PAYBOOK_PHYSICAL_SLOT_COUNT,
  paybookPhysicalSlot,
} from '../../entity/books/book-intents';
import type { EntityState, PaybookEntry } from '../../entity/types';
import {
  aggregateWorkerPhaseResults,
  type ExpectedWorkerEffect,
} from './coordinator/result';

type PhaseDispatch = Readonly<{
  workerIndex: number;
  payload: TsAccountWorkerPhasePayload;
}>;

const expectedPhaseEffects = (
  dispatches: readonly PhaseDispatch[],
  count: number,
): readonly ExpectedWorkerEffect[] => {
  const slots: Array<ExpectedWorkerEffect | undefined> = Array.from({ length: count });
  const place = (
    workerIndex: number,
    row: Readonly<{ order: number; accountId: string }>,
    phase: ExpectedWorkerEffect['phase'],
  ): void => {
    if (!Number.isSafeInteger(row.order) || row.order < 0 || row.order >= count) {
      throw new Error(`TS_ACCOUNT_WORKER_EXPECTED_ORDER_RANGE:${workerIndex}:${row.order}:${count}`);
    }
    if (slots[row.order] !== undefined) {
      throw new Error(`TS_ACCOUNT_WORKER_EXPECTED_ORDER_DUPLICATE:${row.order}`);
    }
    slots[row.order] = { workerIndex, phase, accountId: row.accountId };
  };
  for (const { workerIndex, payload } of dispatches) {
    if (payload.phase === 'inbound') {
      for (const row of payload.inputs) place(workerIndex, row, 'inbound');
    } else {
      for (const row of payload.txs) place(workerIndex, row, 'outbound-enqueue');
      for (const row of payload.proposals) place(workerIndex, row, 'outbound-proposal');
    }
  }
  const missingOrder = slots.findIndex(slot => slot === undefined);
  if (missingOrder >= 0) {
    throw new Error(`TS_ACCOUNT_WORKER_EXPECTED_ORDER_MISSING:${missingOrder}:${count}`);
  }
  return slots as ExpectedWorkerEffect[];
};

/**
 * Resident Account coordinator. Its worker pool lives for the Runtime process:
 * Account replicas cross IPC once at initialization and leave workers only as
 * dirty checkpoint documents when explicitly due. Fatal poison terminates the
 * pool; normal process exit owns shutdown so Bun never races Worker teardown.
 */
export class TsAccountWorkerCoordinator {
  readonly #clients: TsAccountWorkerClient[];
  readonly #workerCount: number;
  readonly #logicalShardToWorker: readonly number[];
  readonly #rootTree: TsAccountCanonicalRoot;
  readonly #openFrameWorkerIndexes = new Set<number>();
  readonly #attemptTouchedWorkerIndexes = new Set<number>();
  readonly #candidateWorkerIndexes = new Set<number>();
  #candidateBaseRoot: string | null = null;
  #candidateBaseSnapshot: ReturnType<TsAccountCanonicalRoot['snapshot']> | null = null;
  #openFrameRestorePrevious = false;
  #fatal: Error | null = null;
  #inFlight = false;
  #openFrameId: string | null = null;
  readonly initialization: TsAccountWorkerInitialization;

  private constructor(
    clients: TsAccountWorkerClient[],
    logicalShardToWorker: readonly number[],
    rootTree: TsAccountCanonicalRoot,
    initialization: TsAccountWorkerInitialization,
  ) {
    this.#clients = clients;
    this.#workerCount = clients.length;
    this.#logicalShardToWorker = logicalShardToWorker;
    this.#rootTree = rootTree;
    this.initialization = initialization;
  }

  static async create(options: TsAccountWorkerOptions): Promise<TsAccountWorkerCoordinator> {
    const workerCount = requireWorkerInteger(options.workerCount, 'TS_ACCOUNT_WORKER_COUNT_INVALID');
    if (workerCount < 1 || workerCount > 64) {
      throw new Error(`TS_ACCOUNT_WORKER_COUNT_BOUNDS:${workerCount}:1:64`);
    }
    const logicalShardToWorker = validateTsAccountShardAssignment(
      options.logicalShardToWorker ?? createBalancedTsAccountShardAssignment(workerCount),
      workerCount,
    );
    const ownerEntityId = normalizeTsWorkerAccountId(options.ownerEntityId);
    const ownedShardBuckets = Array.from({ length: workerCount }, () => [] as number[]);
    logicalShardToWorker.forEach((workerIndex, shardId) => {
      const bucket = ownedShardBuckets[workerIndex];
      if (bucket === undefined) throw new Error(`TS_ACCOUNT_WORKER_BUCKET_MISSING:${workerIndex}`);
      bucket.push(shardId);
    });
    const accountBuckets = Array.from({ length: workerCount }, () =>
      [] as Array<readonly [string, Record<string, unknown>]>);
    for (const [accountIdInput, account] of [...options.accounts].sort(([left], [right]) =>
      left.localeCompare(right))) {
      const accountId = normalizeTsWorkerAccountId(accountIdInput);
      const workerIndex = tsAccountWorkerForShard(tsAccountLogicalShard(accountId), logicalShardToWorker);
      const bucket = accountBuckets[workerIndex];
      if (bucket === undefined) throw new Error(`TS_ACCOUNT_WORKER_ACCOUNT_BUCKET_MISSING:${workerIndex}`);
      bucket.push([accountId, projectPortableAccountDoc(account)]);
    }
    const clients = Array.from({ length: workerCount }, (_, workerIndex) =>
      new TsAccountWorkerClient(workerIndex));
    const common = {
      ownerEntityId,
      workerCount,
      // Worker consensus needs the same replayable jurisdiction projection as
      // Runtime WAL. Live adapter-only fields must never leak across this pure
      // state-machine boundary.
      jReplicas: [...(options.jReplicas ?? new Map())].map(([name, replica]) => [
        name,
        buildCanonicalJReplicaSnapshot(replica),
      ] as const),
      jClaimNodes: [...(options.jClaimNodes ?? new Map())],
      settlementBoardAuthorities: [...(options.settlementBoardAuthorities ?? new Map())],
    } as const;
    try {
      const responses = await Promise.all(clients.map((client, workerIndex) => {
        const ownedShardIds = ownedShardBuckets[workerIndex];
        const accounts = accountBuckets[workerIndex];
        if (ownedShardIds === undefined || accounts === undefined) {
          throw new Error(`TS_ACCOUNT_WORKER_INIT_BUCKET_MISSING:${workerIndex}`);
        }
        const payload: TsAccountWorkerInitPayload = {
          ...common,
          workerIndex,
          ownedShardIds,
          accounts,
        };
        return client.request('init', payload);
      }));
      const rootTree = new TsAccountCanonicalRoot();
      const shardIds = new Set<number>();
      const subroots = [] as import('./protocol').TsAccountWorkerSubroot[];
      let accounts = 0;
      for (const [workerIndex, response] of responses.entries()) {
        const result = parseWorkerInitResult(response.value, workerIndex);
        accounts += result.accountCount;
        for (const subroot of result.subroots) {
          if (tsAccountWorkerForShard(subroot.shardId, logicalShardToWorker) !== workerIndex) {
            throw new Error(`TS_ACCOUNT_WORKER_INIT_SUBROOT_OWNER:${workerIndex}:${subroot.shardId}`);
          }
          if (shardIds.has(subroot.shardId)) {
            throw new Error(`TS_ACCOUNT_WORKER_INIT_SUBROOT_DUPLICATE:${subroot.shardId}`);
          }
          shardIds.add(subroot.shardId);
          subroots.push(subroot);
        }
      }
      if (accounts !== options.accounts.size) {
        throw new Error(`TS_ACCOUNT_WORKER_INIT_ACCOUNT_COUNT:${accounts}:${options.accounts.size}`);
      }
      rootTree.update(subroots);
      const initialization: TsAccountWorkerInitialization = {
        accounts,
        logicalShards: TS_ACCOUNT_LOGICAL_SHARDS,
        workers: workerCount,
        accountsRoot: rootTree.root,
        requestBytes: responses.reduce((sum, response) => sum + response.requestBytes, 0),
        responseBytes: responses.reduce((sum, response) => sum + response.responseBytes, 0),
      };
      return new TsAccountWorkerCoordinator(
        clients,
        logicalShardToWorker,
        rootTree,
        initialization,
      );
    } catch (error) {
      for (const client of clients) client.terminate();
      throw error;
    }
  }

  get accountsRoot(): string {
    return this.#rootTree.root;
  }

  /** Install post-Entity-quorum proof bytes without reopening financial state. */
  async installCommittedAccountHankos(
    input: TsAccountWorkerInstallHankosPayload,
  ): Promise<readonly TsAccountWorkerInstallHankosResult[]> {
    requireWorkerInteger(input.entityHeight, 'TS_ACCOUNT_WORKER_HANKO_HEIGHT_INVALID');
    this.#assertUsable();
    if (this.#openFrameId !== null) {
      throw new Error(`TS_ACCOUNT_WORKER_HANKO_FRAME_OPEN:${this.#openFrameId}`);
    }
    const buckets = Array.from(
      { length: this.#workerCount },
      () => [] as TsAccountWorkerCommittedHankoRow[],
    );
    for (const row of input.rows) {
      const accountId = normalizeTsWorkerAccountId(row.accountId);
      const workerIndex = tsAccountWorkerForShard(
        tsAccountLogicalShard(accountId),
        this.#logicalShardToWorker,
      );
      const bucket = buckets[workerIndex];
      if (!bucket) throw new Error(`TS_ACCOUNT_WORKER_HANKO_BUCKET_MISSING:${workerIndex}`);
      bucket.push({ accountId, hankos: row.hankos });
    }
    this.#inFlight = true;
    try {
      return await Promise.all(buckets.flatMap((rows, workerIndex) => {
        if (rows.length === 0) return [];
        const client = this.#clients[workerIndex];
        if (!client) throw new Error(`TS_ACCOUNT_WORKER_HANKO_CLIENT_MISSING:${workerIndex}`);
        return [client.request('install_hankos', { entityHeight: input.entityHeight, rows }).then(response => {
          const result = response.value as TsAccountWorkerInstallHankosResult;
          if (
            result?.workerIndex !== workerIndex
            || !Number.isSafeInteger(result.accounts)
            || result.accounts !== rows.length
            || !Number.isSafeInteger(result.attached)
            || typeof result.accountsRoot !== 'string'
          ) throw new Error(`TS_ACCOUNT_WORKER_HANKO_RESULT_INVALID:${workerIndex}`);
          return result;
        })];
      }));
    } catch (error) {
      throw this.#poison(error);
    } finally {
      this.#inFlight = false;
    }
  }

  /** Explicit owner shutdown for bounded diagnostics and process teardown. */
  close(): void {
    if (this.#inFlight) throw new Error('TS_ACCOUNT_WORKER_COORDINATOR_CLOSE_IN_FLIGHT');
    if (!this.#fatal) this.#fatal = new Error('TS_ACCOUNT_WORKER_COORDINATOR_CLOSED');
    for (const client of this.#clients) client.terminate();
  }

  #assertUsable(): void {
    if (this.#fatal) throw this.#fatal;
    if (this.#inFlight) throw new Error('TS_ACCOUNT_WORKER_COORDINATOR_CONCURRENT_PHASE');
  }

  #poison(error: unknown): Error {
    const cause = asWorkerError(error);
    if (!this.#fatal) {
      this.#fatal = new Error(`TS_ACCOUNT_WORKER_COORDINATOR_FATAL:${cause.message}`, { cause });
      for (const client of this.#clients) client.poison(this.#fatal);
    }
    return this.#fatal;
  }

  /** Stateless Stage-2 callback over active transient Paybook slots. */
  async applyBookIntents(
    state: EntityState,
    slots: readonly BookIntentSlot[],
  ): Promise<Readonly<{ activeSlots: number; workers: number }>> {
    this.#assertUsable();
    if (this.#openFrameId === null) throw new Error('TS_BOOK_WORKER_FRAME_NOT_OPEN');
    this.#inFlight = true;
    try {
      const intentsBySlot = Array.from(
        { length: PAYBOOK_PHYSICAL_SLOT_COUNT },
        () => [] as BookIntentSlot['intents'][number][],
      );
      let expectedPosition = 0;
      for (const slot of slots) {
        if (slot.position !== expectedPosition) {
          throw new Error(`TS_BOOK_WORKER_INPUT_POSITION:${slot.position}:${expectedPosition}`);
        }
        expectedPosition += 1;
        for (const intent of slot.intents) {
          const physicalSlot = intent.kind === 'paybookFeesSet'
            ? 0
            : paybookPhysicalSlot(intent.hashlock);
          intentsBySlot[physicalSlot]?.push(intent);
        }
      }
      const activePhysicalSlots = intentsBySlot.flatMap((intents, physicalSlot) =>
        intents.length === 0 ? [] : [physicalSlot]);
      const entriesBySlot = Array.from(
        { length: PAYBOOK_PHYSICAL_SLOT_COUNT },
        () => [] as Array<readonly [string, PaybookEntry]>,
      );
      const activeSet = new Set(activePhysicalSlots);
      for (const [hashlock, entry] of state.paybook.entries) {
        const physicalSlot = paybookPhysicalSlot(hashlock);
        if (activeSet.has(physicalSlot)) entriesBySlot[physicalSlot]?.push([hashlock, entry]);
      }
      const buckets = Array.from({ length: this.#workerCount }, () => [] as TsBookWorkerPayload['slots'][number][]);
      activePhysicalSlots.forEach((physicalSlot, activeIndex) => {
        const bucket = buckets[activeIndex % this.#workerCount];
        const intents = intentsBySlot[physicalSlot];
        const entries = entriesBySlot[physicalSlot];
        if (!bucket || !intents || !entries) throw new Error(`TS_BOOK_WORKER_BUCKET_MISSING:${physicalSlot}`);
        bucket.push({
          physicalSlot,
          entries,
          intents,
          ...(physicalSlot === 0 ? { feesEarned: state.paybook.feesEarned } : {}),
        });
      });
      const pending = buckets.flatMap((workerSlots, workerIndex) => {
        if (workerSlots.length === 0) return [];
        const client = this.#clients[workerIndex];
        if (!client) throw new Error(`TS_BOOK_WORKER_CLIENT_MISSING:${workerIndex}`);
        return [client.request('books', { slots: workerSlots }).then(response => ({ workerIndex, response }))];
      });
      const responses = await Promise.all(pending);
      const fixedResults: Array<TsBookWorkerResult['slots'][number] | undefined> =
        Array.from({ length: PAYBOOK_PHYSICAL_SLOT_COUNT });
      for (const { workerIndex, response } of responses) {
        const result = parseBookWorkerResult(response.value, workerIndex);
        for (const slot of result.slots) {
          if (!activeSet.has(slot.physicalSlot) || fixedResults[slot.physicalSlot] !== undefined) {
            throw new Error(`TS_BOOK_WORKER_RESULT_SLOT:${slot.physicalSlot}`);
          }
          fixedResults[slot.physicalSlot] = slot;
        }
      }
      const missing = activePhysicalSlots.find(physicalSlot => fixedResults[physicalSlot] === undefined);
      if (missing !== undefined) throw new Error(`TS_BOOK_WORKER_RESULT_MISSING:${missing}`);
      for (const hashlock of [...state.paybook.entries.keys()]) {
        if (activeSet.has(paybookPhysicalSlot(hashlock))) state.paybook.entries.delete(hashlock);
      }
      for (const physicalSlot of activePhysicalSlots) {
        const result = fixedResults[physicalSlot];
        if (!result) throw new Error(`TS_BOOK_WORKER_RESULT_MISSING:${physicalSlot}`);
        for (const [hashlock, entry] of result.entries) state.paybook.entries.set(hashlock, entry);
        if (result.feesEarned !== undefined) state.paybook.feesEarned = result.feesEarned;
      }
      return { activeSlots: activePhysicalSlots.length, workers: responses.length };
    } catch (error) {
      throw this.#poison(error);
    } finally {
      this.#inFlight = false;
    }
  }

  async #runPhase(
    dispatches: readonly PhaseDispatch[],
    includePostAccounts: boolean,
    expectedEffects: number,
    needShardRoot: boolean,
  ): Promise<TsAccountWorkerBatchResult> {
    this.#assertUsable();
    this.#inFlight = true;
    try {
      const expected = expectedPhaseEffects(dispatches, expectedEffects);
      const dispatchStartedAt = performance.now();
      const pending = dispatches.map(async ({ workerIndex, payload }) => {
        const client = this.#clients[workerIndex];
        if (!client) throw new Error(`TS_ACCOUNT_WORKER_DISPATCH_SLOT:${workerIndex}`);
        return { workerIndex, response: await client.request('phase', payload) };
      });
      const dispatchedAt = performance.now();
      const responses = await Promise.all(pending);
      const joinedAt = performance.now();
      return aggregateWorkerPhaseResults({
        responses,
        logicalShardToWorker: this.#logicalShardToWorker,
        includePostAccounts,
        expectedEffects: expected,
        needShardRoot,
        rootTree: this.#rootTree,
        dispatchMs: dispatchedAt - dispatchStartedAt,
        joinMs: joinedAt - dispatchedAt,
      });
    } catch (error) {
      throw this.#poison(error);
    } finally {
      this.#inFlight = false;
    }
  }

  /** Inbound Account stage for exactly one Entity frame. */
  async applyAccountInputs(input: TsApplyAccountInputsRequest): Promise<TsAccountWorkerBatchResult> {
    const frameId = requireWorkerFrameId(input.frameId);
    const expectedAccountsRoot = input.expectedAccountsRoot.trim().toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(expectedAccountsRoot)) {
      throw new Error(`TS_ACCOUNT_WORKER_EXPECTED_ROOT_INVALID:${input.expectedAccountsRoot}`);
    }
    requireWorkerInteger(input.entityTimestamp, 'TS_ACCOUNT_WORKER_INBOUND_TIMESTAMP_INVALID');
    requireWorkerInteger(input.finalizedJHeight, 'TS_ACCOUNT_WORKER_INBOUND_JHEIGHT_INVALID');
    this.#assertUsable();
    if (this.#openFrameId !== null) {
      throw new Error(`TS_ACCOUNT_WORKER_FRAME_ALREADY_OPEN:${this.#openFrameId}`);
    }
    let restorePrevious = false;
    if (expectedAccountsRoot === this.#rootTree.root) {
      this.#candidateBaseRoot = expectedAccountsRoot;
      this.#candidateBaseSnapshot = this.#rootTree.snapshot();
      this.#candidateWorkerIndexes.clear();
    } else if (
      expectedAccountsRoot === this.#candidateBaseRoot
      && this.#candidateBaseSnapshot !== null
    ) {
      restorePrevious = true;
      this.#rootTree.restore(this.#candidateBaseSnapshot);
    } else {
      throw new Error(`TS_ACCOUNT_WORKER_EXPECTED_ROOT_MISMATCH:${expectedAccountsRoot}:${this.#rootTree.root}`);
    }
    this.#openFrameRestorePrevious = restorePrevious;
    this.#openFrameWorkerIndexes.clear();
    this.#attemptTouchedWorkerIndexes.clear();
    const buckets = Array.from({ length: this.#workerCount }, () =>
      [] as Array<{
        order: number;
        accountId: string;
        input: typeof input.inputs[number]['input'];
        initialAccount?: Record<string, unknown>;
        counterpartyBoardAuthority?: NonNullable<typeof input.inputs[number]['counterpartyBoardAuthority']>;
      }>);
    input.inputs.forEach((item, order) => {
      const accountId = normalizeTsWorkerAccountId(item.accountId);
      const workerIndex = tsAccountWorkerForShard(
        tsAccountLogicalShard(accountId),
        this.#logicalShardToWorker,
      );
      const bucket = buckets[workerIndex];
      if (bucket === undefined) throw new Error(`TS_ACCOUNT_WORKER_INBOUND_BUCKET_MISSING:${workerIndex}`);
      bucket.push({
        order,
        accountId,
        input: item.input,
        ...(item.counterpartyBoardAuthority ? { counterpartyBoardAuthority: item.counterpartyBoardAuthority } : {}),
        ...(item.initialAccount === undefined ? {} : { initialAccount: item.initialAccount }),
      });
    });
    const dispatchWorkerIndexes = new Set(buckets.flatMap((inputs, workerIndex) =>
      inputs.length === 0 ? [] : [workerIndex]));
    if (restorePrevious) {
      for (const workerIndex of this.#candidateWorkerIndexes) dispatchWorkerIndexes.add(workerIndex);
    }
    const dispatches: PhaseDispatch[] = [...dispatchWorkerIndexes].sort((left, right) => left - right)
      .map(workerIndex => {
        const inputs = buckets[workerIndex];
        if (inputs === undefined) throw new Error(`TS_ACCOUNT_WORKER_INBOUND_BUCKET_MISSING:${workerIndex}`);
        return {
          workerIndex,
          payload: {
            phase: 'inbound',
            needShardRoot: false,
            frameId,
            restorePrevious,
            entityTimestamp: input.entityTimestamp,
            finalizedJHeight: input.finalizedJHeight,
            owningEntityIsHub: input.owningEntityIsHub,
            ...(input.localBoardAuthority ? { localBoardAuthority: input.localBoardAuthority } : {}),
            inputs,
          },
        };
      });
    const result = await this.#runPhase(dispatches, true, input.inputs.length, false);
    for (const [workerIndex, inputs] of buckets.entries()) {
      if (inputs.length === 0) continue;
      this.#openFrameWorkerIndexes.add(workerIndex);
      this.#attemptTouchedWorkerIndexes.add(workerIndex);
    }
    this.#openFrameId = frameId;
    return result;
  }

  /** Outbound Account proposal stage after Entity-owned work has completed. */
  async prepareAccountFrames(input: TsProposeAccountFramesRequest): Promise<TsAccountWorkerBatchResult> {
    const frameId = requireWorkerFrameId(input.frameId);
    requireWorkerInteger(input.timestamp, 'TS_ACCOUNT_WORKER_OUTBOUND_TIMESTAMP_INVALID');
    requireWorkerInteger(input.jHeight, 'TS_ACCOUNT_WORKER_OUTBOUND_JHEIGHT_INVALID');
    this.#assertUsable();
    if (this.#openFrameId !== frameId) {
      throw new Error(`TS_ACCOUNT_WORKER_FRAME_NOT_OPEN:${frameId}:${this.#openFrameId ?? 'none'}`);
    }
    const envelopeUpdateBuckets = Array.from({ length: this.#workerCount }, () =>
      [] as Array<typeof input.envelopeUpdates[number]>);
    for (const item of input.envelopeUpdates) {
      const accountId = normalizeTsWorkerAccountId(item.accountId);
      const workerIndex = tsAccountWorkerForShard(
        tsAccountLogicalShard(accountId),
        this.#logicalShardToWorker,
      );
      const bucket = envelopeUpdateBuckets[workerIndex];
      if (bucket === undefined) {
        throw new Error(`TS_ACCOUNT_WORKER_ENVELOPE_BUCKET_MISSING:${workerIndex}`);
      }
      bucket.push({ accountId, update: item.update });
    }
    const txBuckets = Array.from({ length: this.#workerCount }, () =>
      [] as Array<{
        order: number;
        accountId: string;
        txs: typeof input.txs[number]['txs'];
        initialAccount?: Record<string, unknown>;
        counterpartyBoardAuthority?: NonNullable<typeof input.txs[number]['counterpartyBoardAuthority']>;
      }>);
    input.txs.forEach((item, order) => {
      const accountId = normalizeTsWorkerAccountId(item.accountId);
      const workerIndex = tsAccountWorkerForShard(
        tsAccountLogicalShard(accountId),
        this.#logicalShardToWorker,
      );
      const bucket = txBuckets[workerIndex];
      if (bucket === undefined) throw new Error(`TS_ACCOUNT_WORKER_TX_BUCKET_MISSING:${workerIndex}`);
      bucket.push({
        order, accountId, txs: item.txs,
        ...(item.initialAccount === undefined ? {} : { initialAccount: item.initialAccount }),
        ...(item.counterpartyBoardAuthority ? { counterpartyBoardAuthority: item.counterpartyBoardAuthority } : {}),
      });
    });
    const proposals = input.proposals.map((item, index) => ({
      order: input.txs.length + index,
      accountId: normalizeTsWorkerAccountId(item.accountId),
      ...(item.counterpartyBoardAuthority ? { counterpartyBoardAuthority: item.counterpartyBoardAuthority } : {}),
    }));
    if (new Set(proposals.map(proposal => proposal.accountId)).size !== proposals.length) {
      throw new Error('TS_ACCOUNT_WORKER_OUTBOUND_PROPOSAL_DUPLICATE');
    }
    const proposalBuckets = Array.from({ length: this.#workerCount }, () =>
      [] as Array<{
        order: number;
        accountId: string;
        counterpartyBoardAuthority?: NonNullable<
          typeof input.proposals[number]['counterpartyBoardAuthority']
        >;
      }>);
    for (const proposal of proposals) {
      const workerIndex = tsAccountWorkerForShard(
        tsAccountLogicalShard(proposal.accountId),
        this.#logicalShardToWorker,
      );
      const bucket = proposalBuckets[workerIndex];
      if (bucket === undefined) throw new Error(`TS_ACCOUNT_WORKER_PROPOSAL_BUCKET_MISSING:${workerIndex}`);
      bucket.push(proposal);
    }
    const activeWorkerIndexes = this.#clients
      .map((_client, workerIndex) => workerIndex)
      .filter(workerIndex => {
        const txs = txBuckets[workerIndex];
        const proposalsForWorker = proposalBuckets[workerIndex];
        const envelopeUpdates = envelopeUpdateBuckets[workerIndex];
        if (txs === undefined || proposalsForWorker === undefined || envelopeUpdates === undefined) {
          throw new Error(`TS_ACCOUNT_WORKER_ACTIVE_BUCKET_MISSING:${workerIndex}`);
        }
        return envelopeUpdates.length > 0 || txs.length > 0 || proposalsForWorker.length > 0;
      });
    const selectedWorkerIndexes = [...new Set([...this.#openFrameWorkerIndexes, ...activeWorkerIndexes])]
      .sort((left, right) => left - right);
    const dispatches: PhaseDispatch[] = selectedWorkerIndexes.map(workerIndex => {
      const txs = txBuckets[workerIndex];
      const proposalsForWorker = proposalBuckets[workerIndex];
      const envelopeUpdates = envelopeUpdateBuckets[workerIndex];
      if (txs === undefined || proposalsForWorker === undefined || envelopeUpdates === undefined) {
        throw new Error(`TS_ACCOUNT_WORKER_DISPATCH_BUCKET_MISSING:${workerIndex}`);
      }
      return {
        workerIndex,
        payload: {
          phase: 'outbound',
          needShardRoot: true,
          continuation: false,
          frameId,
          restorePrevious: this.#openFrameRestorePrevious,
          timestamp: input.timestamp,
          jHeight: input.jHeight,
          ...(input.localBoardAuthority ? { localBoardAuthority: input.localBoardAuthority } : {}),
          envelopeUpdates,
          txs,
          proposals: proposalsForWorker,
        },
      };
    });
    const result = await this.#runPhase(
      dispatches,
      true,
      input.txs.length + input.proposals.length,
      true,
    );
    for (const workerIndex of activeWorkerIndexes) this.#attemptTouchedWorkerIndexes.add(workerIndex);
    return result;
  }

  /** Canonical outbound with no generated continuation rows. */
  async proposeAccountFrames(input: TsProposeAccountFramesRequest): Promise<TsAccountWorkerBatchResult> {
    const result = await this.prepareAccountFrames(input);
    await this.finishAccountFrames({ ...input, envelopeUpdates: [], txs: [], proposals: [] });
    return result;
  }

  /** One Rust-compatible continuation for genuine failed HTLC proposal followups. */
  async finishAccountFrames(input: TsProposeAccountFramesRequest): Promise<TsAccountWorkerBatchResult | undefined> {
    const frameId = requireWorkerFrameId(input.frameId);
    requireWorkerInteger(input.timestamp, 'TS_ACCOUNT_WORKER_CONTINUATION_TIMESTAMP_INVALID');
    requireWorkerInteger(input.jHeight, 'TS_ACCOUNT_WORKER_CONTINUATION_JHEIGHT_INVALID');
    this.#assertUsable();
    if (this.#openFrameId !== frameId) {
      throw new Error(`TS_ACCOUNT_WORKER_CONTINUATION_FRAME_NOT_OPEN:${frameId}:${this.#openFrameId ?? 'none'}`);
    }
    if (input.envelopeUpdates.length !== 0) {
      throw new Error('TS_ACCOUNT_WORKER_CONTINUATION_ENVELOPE_UPDATE_FORBIDDEN');
    }
    const txBuckets = Array.from({ length: this.#workerCount }, () =>
      [] as Array<{
        order: number;
        accountId: string;
        txs: typeof input.txs[number]['txs'];
        counterpartyBoardAuthority?: NonNullable<typeof input.txs[number]['counterpartyBoardAuthority']>;
      }>);
    input.txs.forEach((item, order) => {
      const accountId = normalizeTsWorkerAccountId(item.accountId);
      const workerIndex = tsAccountWorkerForShard(
        tsAccountLogicalShard(accountId),
        this.#logicalShardToWorker,
      );
      const bucket = txBuckets[workerIndex];
      if (!bucket) throw new Error(`TS_ACCOUNT_WORKER_CONTINUATION_TX_BUCKET:${workerIndex}`);
      bucket.push({
        order, accountId, txs: item.txs,
        ...(item.counterpartyBoardAuthority ? { counterpartyBoardAuthority: item.counterpartyBoardAuthority } : {}),
      });
    });
    const proposals = input.proposals.map((item, index) => ({
      order: input.txs.length + index,
      accountId: normalizeTsWorkerAccountId(item.accountId),
      ...(item.counterpartyBoardAuthority ? { counterpartyBoardAuthority: item.counterpartyBoardAuthority } : {}),
    }));
    if (new Set(proposals.map(row => row.accountId)).size !== proposals.length) {
      throw new Error('TS_ACCOUNT_WORKER_CONTINUATION_PROPOSAL_DUPLICATE');
    }
    const proposalBuckets = Array.from({ length: this.#workerCount }, () =>
      [] as typeof proposals);
    for (const proposal of proposals) {
      const workerIndex = tsAccountWorkerForShard(
        tsAccountLogicalShard(proposal.accountId),
        this.#logicalShardToWorker,
      );
      const bucket = proposalBuckets[workerIndex];
      if (!bucket) throw new Error(`TS_ACCOUNT_WORKER_CONTINUATION_PROPOSAL_BUCKET:${workerIndex}`);
      bucket.push(proposal);
    }
    const workerIndexes = this.#clients
      .map((_client, workerIndex) => workerIndex)
      .filter(workerIndex => (txBuckets[workerIndex]?.length ?? 0) > 0
        || (proposalBuckets[workerIndex]?.length ?? 0) > 0);
    const dispatches: PhaseDispatch[] = workerIndexes.map(workerIndex => {
      const txs = txBuckets[workerIndex];
      const proposalsForWorker = proposalBuckets[workerIndex];
      if (!txs || !proposalsForWorker) {
        throw new Error(`TS_ACCOUNT_WORKER_CONTINUATION_BUCKET_MISSING:${workerIndex}`);
      }
      return { workerIndex, payload: {
        phase: 'outbound',
        needShardRoot: true,
        continuation: true,
        frameId,
        restorePrevious: false,
        timestamp: input.timestamp,
        jHeight: input.jHeight,
        ...(input.localBoardAuthority ? { localBoardAuthority: input.localBoardAuthority } : {}),
        envelopeUpdates: [],
        txs,
        proposals: proposalsForWorker,
      } };
    });
    const result = dispatches.length === 0
      ? undefined
      : await this.#runPhase(dispatches, true, input.txs.length + input.proposals.length, true);
    for (const workerIndex of workerIndexes) this.#attemptTouchedWorkerIndexes.add(workerIndex);
    this.#openFrameWorkerIndexes.clear();
    this.#candidateWorkerIndexes.clear();
    for (const workerIndex of this.#attemptTouchedWorkerIndexes) {
      this.#candidateWorkerIndexes.add(workerIndex);
    }
    this.#attemptTouchedWorkerIndexes.clear();
    this.#openFrameId = null;
    return result;
  }

}

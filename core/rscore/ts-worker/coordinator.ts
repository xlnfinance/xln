import { projectPortableAccountDoc } from '../../storage/read/projections';
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
  TsAccountWorkerInitialization,
  TsAccountWorkerInitPayload,
  TsAccountWorkerOptions,
  TsAccountWorkerPhasePayload,
} from './protocol';
import {
  asWorkerError,
  parseWorkerInitResult,
  requireWorkerFrameId,
  requireWorkerInteger,
  TsAccountWorkerClient,
} from './coordinator-client';
import { aggregateWorkerPhaseResults } from './coordinator-result';

type PhaseDispatch = Readonly<{
  workerIndex: number;
  payload: TsAccountWorkerPhasePayload;
}>;

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
  readonly #dirtyWorkerIndexes = new Set<number>();
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
      jReplicas: [...(options.jReplicas ?? new Map())],
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

  async #runPhase(
    dispatches: readonly PhaseDispatch[],
    checkpointDue: boolean,
    includePostAccounts: boolean,
    expectedEffects: number,
  ): Promise<TsAccountWorkerBatchResult> {
    this.#assertUsable();
    this.#inFlight = true;
    try {
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
        checkpointDue,
        includePostAccounts,
        expectedEffects,
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
      [] as Array<{ order: number; accountId: string; input: typeof input.inputs[number]['input'] }>);
    input.inputs.forEach((item, order) => {
      const accountId = normalizeTsWorkerAccountId(item.accountId);
      const workerIndex = tsAccountWorkerForShard(
        tsAccountLogicalShard(accountId),
        this.#logicalShardToWorker,
      );
      const bucket = buckets[workerIndex];
      if (bucket === undefined) throw new Error(`TS_ACCOUNT_WORKER_INBOUND_BUCKET_MISSING:${workerIndex}`);
      bucket.push({ order, accountId, input: item.input });
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
            frameId,
            restorePrevious,
            entityTimestamp: input.entityTimestamp,
            finalizedJHeight: input.finalizedJHeight,
            inputs,
          },
        };
      });
    const result = await this.#runPhase(dispatches, false, false, input.inputs.length);
    for (const [workerIndex, inputs] of buckets.entries()) {
      if (inputs.length === 0) continue;
      this.#dirtyWorkerIndexes.add(workerIndex);
      this.#openFrameWorkerIndexes.add(workerIndex);
      this.#attemptTouchedWorkerIndexes.add(workerIndex);
    }
    this.#openFrameId = frameId;
    return result;
  }

  /** Outbound Account proposal stage after Entity-owned work has completed. */
  async proposeAccountFrames(input: TsProposeAccountFramesRequest): Promise<TsAccountWorkerBatchResult> {
    const frameId = requireWorkerFrameId(input.frameId);
    requireWorkerInteger(input.timestamp, 'TS_ACCOUNT_WORKER_OUTBOUND_TIMESTAMP_INVALID');
    requireWorkerInteger(input.jHeight, 'TS_ACCOUNT_WORKER_OUTBOUND_JHEIGHT_INVALID');
    this.#assertUsable();
    if (this.#openFrameId !== frameId) {
      throw new Error(`TS_ACCOUNT_WORKER_FRAME_NOT_OPEN:${frameId}:${this.#openFrameId ?? 'none'}`);
    }
    if (typeof input.checkpointDue !== 'boolean') {
      throw new Error('TS_ACCOUNT_WORKER_OUTBOUND_CHECKPOINT_INVALID');
    }
    const txBuckets = Array.from({ length: this.#workerCount }, () =>
      [] as Array<{ order: number; accountId: string; txs: typeof input.txs[number]['txs'] }>);
    input.txs.forEach((item, order) => {
      const accountId = normalizeTsWorkerAccountId(item.accountId);
      const workerIndex = tsAccountWorkerForShard(
        tsAccountLogicalShard(accountId),
        this.#logicalShardToWorker,
      );
      const bucket = txBuckets[workerIndex];
      if (bucket === undefined) throw new Error(`TS_ACCOUNT_WORKER_TX_BUCKET_MISSING:${workerIndex}`);
      bucket.push({ order, accountId, txs: item.txs });
    });
    const proposals = input.proposalAccountIds.map((accountIdInput, index) => ({
      order: input.txs.length + index,
      accountId: normalizeTsWorkerAccountId(accountIdInput),
    }));
    if (new Set(proposals.map(proposal => proposal.accountId)).size !== proposals.length) {
      throw new Error('TS_ACCOUNT_WORKER_OUTBOUND_PROPOSAL_DUPLICATE');
    }
    const proposalBuckets = Array.from({ length: this.#workerCount }, () =>
      [] as Array<{ order: number; accountId: string }>);
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
        if (txs === undefined || proposalsForWorker === undefined) {
          throw new Error(`TS_ACCOUNT_WORKER_ACTIVE_BUCKET_MISSING:${workerIndex}`);
        }
        return txs.length > 0 || proposalsForWorker.length > 0;
      });
    const selectedWorkerIndexes = [...new Set(input.checkpointDue
      ? [...this.#dirtyWorkerIndexes, ...this.#openFrameWorkerIndexes, ...activeWorkerIndexes]
      : [...this.#openFrameWorkerIndexes, ...activeWorkerIndexes])]
      .sort((left, right) => left - right);
    const dispatches: PhaseDispatch[] = selectedWorkerIndexes.map(workerIndex => {
      const txs = txBuckets[workerIndex];
      const proposalsForWorker = proposalBuckets[workerIndex];
      if (txs === undefined || proposalsForWorker === undefined) {
        throw new Error(`TS_ACCOUNT_WORKER_DISPATCH_BUCKET_MISSING:${workerIndex}`);
      }
      return {
        workerIndex,
        payload: {
          phase: 'outbound',
          frameId,
          restorePrevious: this.#openFrameRestorePrevious,
          timestamp: input.timestamp,
          jHeight: input.jHeight,
          txs,
          proposals: proposalsForWorker,
          checkpointDue: input.checkpointDue,
        },
      };
    });
    const result = await this.#runPhase(
      dispatches,
      input.checkpointDue,
      true,
      input.txs.length + input.proposalAccountIds.length,
    );
    for (const workerIndex of activeWorkerIndexes) this.#dirtyWorkerIndexes.add(workerIndex);
    for (const workerIndex of activeWorkerIndexes) this.#attemptTouchedWorkerIndexes.add(workerIndex);
    if (input.checkpointDue) {
      for (const workerIndex of selectedWorkerIndexes) this.#dirtyWorkerIndexes.delete(workerIndex);
    }
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

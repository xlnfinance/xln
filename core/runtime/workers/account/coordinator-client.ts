import { TsAccountWorkerTransferDecoder, TsAccountWorkerTransferEncoder } from './codec';
import { getPerfMs } from '../../../support/time';
import type {
  TsAccountWorkerInitResult,
  TsAccountWorkerInitPayload,
  TsAccountWorkerPhaseResult,
  TsAccountWorkerRequestEnvelope,
  TsBookWorkerResult,
} from './protocol';
import { acquireTsAccountWorkerResidency, type TsAccountWorkerResidency } from './coordinator/pool';

type WorkerRequestKind = Exclude<TsAccountWorkerRequestEnvelope['kind'], 'release'>;

export type WorkerRequestResult = Readonly<{
  value: unknown;
  requestBytes: number;
  responseBytes: number;
  encodeMs: number;
  decodeMs: number;
  roundTripMs: number;
  workerEncodeMs: number;
}>;

export const asWorkerError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

/**
 * One owner replica's logical Account worker: a resident on a shared pool
 * thread. It owns that resident's sequential codec pair and initialization;
 * the thread only carries envelopes (see `coordinator/pool.ts`).
 */
export class TsAccountWorkerClient {
  readonly #workerIndex: number;
  readonly #threadSlot: number;
  #residency: TsAccountWorkerResidency | null = null;
  #closed = false;
  readonly #requestEncoder = new TsAccountWorkerTransferEncoder();
  readonly #responseDecoder = new TsAccountWorkerTransferDecoder();
  #initialization:
    | { kind: 'ready' }
    | { kind: 'deferred'; payload: ArrayBuffer; encodeMs: number }
    | { kind: 'starting'; pending: Promise<void> } = { kind: 'ready' };
  #initializationTransfer = { requestBytes: 0, responseBytes: 0 };

  constructor(workerIndex: number, threadSlot: number) {
    this.#workerIndex = workerIndex;
    this.#threadSlot = threadSlot;
  }

  get initializationTransfer(): Readonly<{ requestBytes: number; responseBytes: number }> {
    return this.#initializationTransfer;
  }

  initialize(input: TsAccountWorkerInitPayload): Promise<WorkerRequestResult | undefined> {
    if (input.accounts.length > 0) return this.request('init', input);
    // An empty shard contributes the canonical empty root. Keep its client
    // and frame lifecycle, but take a pool residency only for actual work;
    // the unchanged init must succeed before its first financial request.
    this.#deferEmptyInitialization(input);
    return Promise.resolve(undefined);
  }

  #deferEmptyInitialization(input: TsAccountWorkerInitPayload): void {
    if (
      input.accounts.length !== 0 ||
      this.#residency ||
      this.#initialization.kind !== 'ready' ||
      this.#closed
    ) {
      throw new Error(`TS_ACCOUNT_WORKER_DEFER_INVALID:${this.#workerIndex}`);
    }
    // Freeze the original initialization bytes now. Later Entity/J mutations
    // must not change the parent loaded before this shard's first real work.
    const startedAt = getPerfMs();
    const payload = this.#requestEncoder.encode(input);
    this.#initialization = { kind: 'deferred', payload, encodeMs: getPerfMs() - startedAt };
  }

  async request(kind: WorkerRequestKind, value: unknown): Promise<WorkerRequestResult> {
    if (this.#closed) throw new Error(`TS_ACCOUNT_WORKER_CLIENT_CLOSED:${this.#workerIndex}`);
    // Freeze this request before awaiting cold initialization, just as a warm
    // client does before posting; caller mutations cannot change accepted work.
    const encodeStart = getPerfMs();
    const payload = this.#requestEncoder.encode(value);
    const encodeMs = getPerfMs() - encodeStart;
    if (this.#initialization.kind === 'deferred') {
      const { payload, encodeMs } = this.#initialization;
      const pending = this.#send('init', payload, encodeMs).then(response => {
        const result = parseWorkerInitResult(response.value, this.#workerIndex);
        if (result.accountCount !== 0 || result.subroots.length !== 0) {
          throw new Error(`TS_ACCOUNT_WORKER_DEFER_ROOT_NOT_EMPTY:${this.#workerIndex}`);
        }
        this.#initialization = { kind: 'ready' };
      });
      this.#initialization = { kind: 'starting', pending };
    }
    if (this.#initialization.kind === 'starting') await this.#initialization.pending;
    return this.#send(kind, payload, encodeMs);
  }

  async #send(kind: WorkerRequestKind, payload: ArrayBuffer, encodeMs: number): Promise<WorkerRequestResult> {
    if (this.#closed) throw new Error(`TS_ACCOUNT_WORKER_CLIENT_CLOSED:${this.#workerIndex}`);
    // The first message of every resident is its init, direct or deferred.
    this.#residency ??= acquireTsAccountWorkerResidency(this.#threadSlot);
    const { thread, residentId } = this.#residency;
    // Posting transfers (detaches) the buffer; measure it first.
    const requestBytes = payload.byteLength;
    const sentAt = getPerfMs();
    const response = await thread.send(residentId, kind, payload);
    let value: unknown;
    const decodeStart = getPerfMs();
    try {
      value = this.#responseDecoder.decode(response.payload);
    } catch (error) {
      throw new Error(`TS_ACCOUNT_WORKER_RESPONSE_DECODE:${this.#workerIndex}:${asWorkerError(error).message}`);
    }
    const decodeMs = getPerfMs() - decodeStart;
    const result: WorkerRequestResult = {
      value,
      requestBytes,
      responseBytes: response.payload.byteLength,
      encodeMs,
      decodeMs,
      roundTripMs: getPerfMs() - sentAt,
      workerEncodeMs: response.encodeUs / 1_000,
    };
    if (kind === 'init') {
      this.#initializationTransfer = { requestBytes: result.requestBytes, responseBytes: result.responseBytes };
    }
    return result;
  }

  /**
   * Owner shutdown or fail-stop poison: reject this resident's in-flight
   * requests and free its isolate state. Co-residents keep their thread.
   */
  close(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#residency?.thread.release(this.#residency.residentId, error);
  }
}

export const requireWorkerInteger = (value: number, code: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(code);
  return value;
};

export const requireWorkerFrameId = (frameId: string): string => {
  if (typeof frameId !== 'string' || frameId.length === 0) {
    throw new Error('TS_ACCOUNT_WORKER_FRAME_ID_INVALID');
  }
  return frameId;
};

export const parseWorkerInitResult = (
  value: unknown,
  expectedWorkerIndex: number,
): TsAccountWorkerInitResult => {
  if (value === null || typeof value !== 'object') throw new Error('TS_ACCOUNT_WORKER_INIT_RESULT_INVALID');
  const result = value as TsAccountWorkerInitResult;
  if (result.workerIndex !== expectedWorkerIndex) {
    throw new Error(`TS_ACCOUNT_WORKER_INIT_RESULT_SLOT:${expectedWorkerIndex}:${result.workerIndex}`);
  }
  if (!Number.isSafeInteger(result.accountCount) || result.accountCount < 0 || !Array.isArray(result.subroots)) {
    throw new Error(`TS_ACCOUNT_WORKER_INIT_RESULT_SHAPE:${expectedWorkerIndex}`);
  }
  return result;
};

export const parseWorkerPhaseResult = (
  value: unknown,
  expectedWorkerIndex: number,
): TsAccountWorkerPhaseResult => {
  if (value === null || typeof value !== 'object') throw new Error('TS_ACCOUNT_WORKER_PHASE_RESULT_INVALID');
  const result = value as TsAccountWorkerPhaseResult;
  if (
    result.workerIndex !== expectedWorkerIndex
    || !Array.isArray(result.effects)
    || !Array.isArray(result.skippedProposals)
    || !Array.isArray(result.subroots)
    || (result.postAccounts !== undefined && !Array.isArray(result.postAccounts))
    || !Number.isSafeInteger(result.operations)
    || !Array.isArray(result.shardRows)
    || result.operationsProfile === null
    || typeof result.operationsProfile !== 'object'
    || Array.isArray(result.operationsProfile)
    || !Number.isSafeInteger(result.elapsedUs)
    || !Number.isFinite(result.heapUsedBytes)
    || !Number.isSafeInteger(result.threadCpuUserUs)
    || !Number.isSafeInteger(result.threadCpuSystemUs)
    || result.timings === null
    || typeof result.timings !== 'object'
  ) throw new Error(`TS_ACCOUNT_WORKER_PHASE_RESULT_SHAPE:${expectedWorkerIndex}`);
  for (const row of result.shardRows) {
    if (!Array.isArray(row) || row.length !== 2
      || !Number.isSafeInteger(row[0]) || row[0] < 0 || row[0] >= 4096
      || !Number.isSafeInteger(row[1]) || row[1] < 1) {
      throw new Error(`TS_ACCOUNT_WORKER_PHASE_SHARD_ROWS:${expectedWorkerIndex}`);
    }
  }
  return result;
};

export const parseBookWorkerResult = (
  value: unknown,
  expectedWorkerIndex: number,
): TsBookWorkerResult => {
  if (value === null || typeof value !== 'object') throw new Error('TS_BOOK_WORKER_RESULT_INVALID');
  const result = value as TsBookWorkerResult;
  if (result.workerIndex !== expectedWorkerIndex || !Array.isArray(result.slots)) {
    throw new Error(`TS_BOOK_WORKER_RESULT_SHAPE:${expectedWorkerIndex}`);
  }
  return result;
};

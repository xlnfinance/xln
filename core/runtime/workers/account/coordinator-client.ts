import { TsAccountWorkerTransferDecoder, TsAccountWorkerTransferEncoder } from './codec';
import { getPerfMs } from '../../../support/time';
import type {
  TsAccountWorkerInitResult,
  TsAccountWorkerInitPayload,
  TsAccountWorkerPhaseResult,
  TsAccountWorkerRequestEnvelope,
  TsAccountWorkerResponseEnvelope,
  TsBookWorkerResult,
} from './protocol';

export type WorkerRequestResult = Readonly<{
  value: unknown;
  requestBytes: number;
  responseBytes: number;
  encodeMs: number;
  decodeMs: number;
  roundTripMs: number;
  workerEncodeMs: number;
}>;

type PendingRequest = Readonly<{
  resolve(value: WorkerRequestResult): void;
  reject(error: Error): void;
  requestBytes: number;
  encodeMs: number;
  sentAt: number;
}>;

export const asWorkerError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

export class TsAccountWorkerClient {
  #worker: Worker | null = null;
  readonly #workerIndex: number;
  readonly #pending = new Map<number, PendingRequest>();
  #nextRequestId = 1;
  #closed = false;
  readonly #requestEncoder = new TsAccountWorkerTransferEncoder();
  readonly #responseDecoder = new TsAccountWorkerTransferDecoder();
  #initialization:
    | { kind: 'ready' }
    | { kind: 'deferred'; payload: ArrayBuffer; encodeMs: number }
    | { kind: 'starting'; pending: Promise<void> } = { kind: 'ready' };
  #initializationTransfer = { requestBytes: 0, responseBytes: 0 };

  constructor(workerIndex: number) {
    this.#workerIndex = workerIndex;
  }

  get initializationTransfer(): Readonly<{ requestBytes: number; responseBytes: number }> {
    return this.#initializationTransfer;
  }

  initialize(input: TsAccountWorkerInitPayload): Promise<WorkerRequestResult | undefined> {
    if (input.accounts.length > 0) return this.request('init', input);
    // An empty shard contributes the canonical empty root. Keep its client
    // and frame lifecycle, but allocate the isolate only for actual work;
    // the unchanged init must succeed before its first financial request.
    this.#deferEmptyInitialization(input);
    return Promise.resolve(undefined);
  }

  #deferEmptyInitialization(input: TsAccountWorkerInitPayload): void {
    if (
      input.accounts.length !== 0 ||
      this.#worker ||
      this.#nextRequestId !== 1 ||
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

  #startWorker(): Worker {
    if (this.#worker) return this.#worker;
    // Bun resolves the source module beside this file. A production browser
    // loads the separately bundled worker from the same public origin; using
    // the source-relative URL there incorrectly requested `/worker.ts`.
    const location = Reflect.get(globalThis, 'location') as { origin?: unknown } | undefined;
    const workerUrl = typeof location?.origin === 'string'
      ? new URL('/account-worker.js', location.origin)
      : new URL('./worker.ts', import.meta.url);
    // The browser bundle intentionally retains import.meta in the optional
    // shadow instrumentation path. A classic worker rejects that syntax before
    // initialization; module workers accept it and Bun supports the same mode.
    this.#worker = new Worker(workerUrl, { type: 'module' });
    this.#worker.onmessage = event => this.#handleResponse(event.data as TsAccountWorkerResponseEnvelope);
    this.#worker.onerror = event =>
      this.#retire(
        new Error(
          `TS_ACCOUNT_WORKER_ERROR:${this.#workerIndex}:${event.message}:${event.filename}:${event.lineno}:${event.colno}`,
        ),
      );
    this.#worker.addEventListener('close', () => {
      if (!this.#closed) this.#retire(new Error(`TS_ACCOUNT_WORKER_CLOSED:${this.#workerIndex}`));
    });
    return this.#worker;
  }

  #handleResponse(response: TsAccountWorkerResponseEnvelope): void {
    const pending = this.#pending.get(response.requestId);
    if (!pending) {
      // Preserve envelope shape, never financial payloads or signing material,
      // when a foreign/malformed message poisons this isolate's mailbox.
      const fields = Object.keys(response).slice(0, 8).map(key => key.slice(0, 32)).join(',');
      this.#retire(new Error(
        `TS_ACCOUNT_WORKER_UNMATCHED_RESPONSE:${this.#workerIndex}:${response.requestId}`
        + `:fields=${fields}:kindType=${typeof response.kind}:pending=${this.#pending.size}`,
      ));
      return;
    }
    this.#pending.delete(response.requestId);
    if (response.kind === 'fatal') {
      pending.reject(new Error(
        `TS_ACCOUNT_WORKER_FATAL:${this.#workerIndex}:${response.error}`
        + (response.stack ? `\n${response.stack}` : ''),
      ));
      return;
    }
    try {
      const decodeStart = getPerfMs();
      const value = this.#responseDecoder.decode(response.payload);
      const decodeMs = getPerfMs() - decodeStart;
      pending.resolve({
        value,
        requestBytes: pending.requestBytes,
        responseBytes: response.payload.byteLength,
        encodeMs: pending.encodeMs,
        decodeMs,
        roundTripMs: getPerfMs() - pending.sentAt,
        workerEncodeMs: response.encodeUs / 1_000,
      });
    } catch (error) {
      pending.reject(new Error(
        `TS_ACCOUNT_WORKER_RESPONSE_DECODE:${this.#workerIndex}:${asWorkerError(error).message}`,
      ));
    }
  }

  #retire(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const request of pending) request.reject(error);
  }

  async request(kind: TsAccountWorkerRequestEnvelope['kind'], value: unknown): Promise<WorkerRequestResult> {
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

  #send(
    kind: TsAccountWorkerRequestEnvelope['kind'],
    payload: ArrayBuffer,
    encodeMs: number,
  ): Promise<WorkerRequestResult> {
    if (this.#closed) {
      return Promise.reject(new Error(`TS_ACCOUNT_WORKER_CLIENT_CLOSED:${this.#workerIndex}`));
    }
    const requestId = this.#nextRequestId;
    this.#nextRequestId += 1;
    const request: TsAccountWorkerRequestEnvelope = { requestId, kind, payload };
    const sentAt = getPerfMs();
    return new Promise<WorkerRequestResult>((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject, requestBytes: payload.byteLength, encodeMs, sentAt });
      try {
        this.#startWorker().postMessage(request, [payload]);
      } catch (error) {
        this.#pending.delete(requestId);
        reject(asWorkerError(error));
      }
    }).then(result => {
      if (kind === 'init')
        this.#initializationTransfer = {
          requestBytes: result.requestBytes,
          responseBytes: result.responseBytes,
        };
      return result;
    });
  }

  terminate(): void {
    if (!this.#closed) {
      this.#closed = true;
      const error = new Error(`TS_ACCOUNT_WORKER_TERMINATED:${this.#workerIndex}`);
      const pending = [...this.#pending.values()];
      this.#pending.clear();
      for (const request of pending) request.reject(error);
    }
    this.#worker?.terminate();
  }

  /**
   * Fail-stop owns the isolate as well as its mailbox. A poisoned coordinator
   * can never dispatch again, so retaining the Worker only leaks a schedulable
   * thread and can starve the next Runtime/test pool under aggregate load.
   */
  poison(error: Error): void {
    this.#retire(error);
    this.#worker?.terminate();
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

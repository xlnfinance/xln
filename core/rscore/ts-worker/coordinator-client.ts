import { TsAccountWorkerTransferDecoder, TsAccountWorkerTransferEncoder } from './codec';
import { getPerfMs } from '../../support/time';
import type {
  TsAccountWorkerInitResult,
  TsAccountWorkerPhaseResult,
  TsAccountWorkerRequestEnvelope,
  TsAccountWorkerResponseEnvelope,
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
  readonly #worker: Worker;
  readonly #workerIndex: number;
  readonly #pending = new Map<number, PendingRequest>();
  #nextRequestId = 1;
  #closed = false;
  readonly #requestEncoder = new TsAccountWorkerTransferEncoder();
  readonly #responseDecoder = new TsAccountWorkerTransferDecoder();

  constructor(workerIndex: number) {
    this.#workerIndex = workerIndex;
    // Crypto lanes already refuse to spawn from a worker isolate. Keeping the
    // constructor Web Worker-compatible also avoids copying the entire process
    // environment into every long-lived Account owner.
    this.#worker = new Worker(new URL('./worker.ts', import.meta.url));
    this.#worker.onmessage = event => this.#handleResponse(event.data as TsAccountWorkerResponseEnvelope);
    this.#worker.onerror = event => this.#retire(new Error(
      `TS_ACCOUNT_WORKER_ERROR:${workerIndex}:${event.message}:${event.filename}:${event.lineno}:${event.colno}`,
    ));
    this.#worker.addEventListener('close', () => {
      if (!this.#closed) this.#retire(new Error(`TS_ACCOUNT_WORKER_CLOSED:${workerIndex}`));
    });
  }

  #handleResponse(response: TsAccountWorkerResponseEnvelope): void {
    const pending = this.#pending.get(response.requestId);
    if (!pending) {
      this.#retire(new Error(`TS_ACCOUNT_WORKER_UNMATCHED_RESPONSE:${this.#workerIndex}:${response.requestId}`));
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

  request(kind: TsAccountWorkerRequestEnvelope['kind'], value: unknown): Promise<WorkerRequestResult> {
    if (this.#closed) {
      return Promise.reject(new Error(`TS_ACCOUNT_WORKER_CLIENT_CLOSED:${this.#workerIndex}`));
    }
    const requestId = this.#nextRequestId;
    this.#nextRequestId += 1;
    const encodeStart = getPerfMs();
    const payload = this.#requestEncoder.encode(value);
    const encodeMs = getPerfMs() - encodeStart;
    const request: TsAccountWorkerRequestEnvelope = { requestId, kind, payload };
    const sentAt = getPerfMs();
    return new Promise((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject, requestBytes: payload.byteLength, encodeMs, sentAt });
      try {
        this.#worker.postMessage(request, [payload]);
      } catch (error) {
        this.#pending.delete(requestId);
        reject(asWorkerError(error));
      }
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
    this.#worker.terminate();
  }

  /**
   * Fail-stop owns the isolate as well as its mailbox. A poisoned coordinator
   * can never dispatch again, so retaining the Worker only leaks a schedulable
   * thread and can starve the next Runtime/test pool under aggregate load.
   */
  poison(error: Error): void {
    this.#retire(error);
    this.#worker.terminate();
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

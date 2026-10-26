import type {
  TsAccountWorkerRequestEnvelope,
  TsAccountWorkerResponseEnvelope,
} from '../protocol';

/**
 * Process-wide TypeScript Account worker pool.
 *
 * Every owner Entity replica (coordinator) is a set of residents multiplexed
 * over the same fixed thread set; it never spawns threads of its own. A
 * thread is a placement choice only: each resident keeps its own state and
 * codec pair inside the isolate, so results never depend on which thread or
 * which co-residents served a request. A thread executes one request at a
 * time in arrival order.
 *
 * Fail-stop: a fatal response, uncaught error, close or foreign message
 * retires the whole thread and rejects every co-resident in flight; later
 * requests by those residents reject with the same cause. Only a resident
 * acquired afterwards gets a fresh thread in that slot.
 */

type ResultEnvelope = Extract<TsAccountWorkerResponseEnvelope, { kind: 'result' }>;

type ThreadPending = Readonly<{
  residentId: number;
  resolve(response: ResultEnvelope): void;
  reject(error: Error): void;
}>;

type RefWorker = Worker & { ref?(): void; unref?(): void };

/** Validate the isolate's envelope before any settlement; never echo payloads. */
const parseResponseEnvelope = (slot: number, data: unknown): TsAccountWorkerResponseEnvelope => {
  const envelope = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
  const { requestId, kind } = envelope;
  const validId = typeof requestId === 'number' && Number.isSafeInteger(requestId) && requestId > 0;
  if (validId && kind === 'result' && envelope['payload'] instanceof ArrayBuffer
    && typeof envelope['encodeUs'] === 'number' && Number.isFinite(envelope['encodeUs'])) {
    return envelope as TsAccountWorkerResponseEnvelope;
  }
  if (validId && kind === 'fatal' && typeof envelope['error'] === 'string'
    && (envelope['stack'] === undefined || typeof envelope['stack'] === 'string')) {
    return envelope as TsAccountWorkerResponseEnvelope;
  }
  const fields = Object.keys(envelope).slice(0, 8).map(key => key.slice(0, 32)).join(',');
  throw new Error(
    `TS_ACCOUNT_WORKER_MALFORMED_RESPONSE:${slot}:type=${data === null ? 'null' : typeof data}`
    + `:fields=${fields}:kind=${typeof kind === 'string' ? kind.slice(0, 32) : typeof kind}`,
  );
};

class TsAccountWorkerThread {
  readonly #slot: number;
  readonly #worker: RefWorker;
  readonly #pending = new Map<number, ThreadPending>();
  /** Released residents' in-flight request ids; their late results are dropped. */
  readonly #abandoned = new Set<number>();
  readonly #residents = new Set<number>();
  #nextRequestId = 1;
  #retired: Error | null = null;

  constructor(slot: number) {
    this.#slot = slot;
    // Bun resolves the source module beside the parent directory. A production
    // browser loads the separately bundled worker from the same public origin;
    // module workers accept the retained import.meta of shadow instrumentation.
    const location = Reflect.get(globalThis, 'location') as { origin?: unknown } | undefined;
    const workerUrl = typeof location?.origin === 'string'
      ? new URL('/account-worker.js', location.origin)
      : new URL('../worker.ts', import.meta.url);
    this.#worker = new Worker(workerUrl, { type: 'module' });
    this.#worker.onmessage = (event: MessageEvent<unknown>) => {
      try {
        this.#handleResponse(parseResponseEnvelope(slot, event.data));
      } catch (error) {
        this.#retire(error instanceof Error ? error : new Error(String(error)));
      }
    };
    this.#worker.onerror = event => this.#retire(new Error(
      `TS_ACCOUNT_WORKER_ERROR:${slot}:${event.message}:${event.filename}:${event.lineno}:${event.colno}`,
    ));
    this.#worker.addEventListener('close', () => this.#retire(new Error(`TS_ACCOUNT_WORKER_CLOSED:${slot}`), false));
    // An idle pool must not keep a finished process alive; work in flight does.
    this.#worker.unref?.();
  }

  get retired(): Error | null {
    return this.#retired;
  }

  get residents(): number {
    return this.#residents.size;
  }

  attach(residentId: number): void {
    if (this.#retired) throw this.#retired;
    this.#residents.add(residentId);
  }

  send(
    residentId: number,
    kind: Exclude<TsAccountWorkerRequestEnvelope['kind'], 'release'>,
    payload: ArrayBuffer,
  ): Promise<ResultEnvelope> {
    if (this.#retired) return Promise.reject(this.#retired);
    if (!this.#residents.has(residentId)) {
      return Promise.reject(new Error(`TS_ACCOUNT_WORKER_RESIDENT_DETACHED:${this.#slot}:${residentId}`));
    }
    const requestId = this.#nextRequestId;
    this.#nextRequestId += 1;
    return new Promise((resolve, reject) => {
      this.#pending.set(requestId, { residentId, resolve, reject });
      if (this.#pending.size === 1) this.#worker.ref?.();
      try {
        this.#worker.postMessage({ requestId, residentId, kind, payload }, [payload]);
      } catch (error) {
        this.#settle(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Free one resident's isolate state; its in-flight requests reject with `error`. */
  release(residentId: number, error: Error): void {
    if (this.#retired || !this.#residents.delete(residentId)) return;
    for (const [requestId, pending] of [...this.#pending]) {
      if (pending.residentId !== residentId) continue;
      this.#settle(requestId);
      this.#abandoned.add(requestId);
      pending.reject(error);
    }
    const requestId = this.#nextRequestId;
    this.#nextRequestId += 1;
    try {
      this.#worker.postMessage({ requestId, residentId, kind: 'release' });
    } catch (error) {
      // Cleanup never throws past the coordinator's remaining clients; an
      // unreachable isolate is retired for every co-resident instead.
      this.#retire(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #settle(requestId: number): void {
    this.#pending.delete(requestId);
    if (this.#pending.size === 0) this.#worker.unref?.();
  }

  #handleResponse(response: TsAccountWorkerResponseEnvelope): void {
    // The isolate never serves again after a fatal response; every
    // co-resident's state died with it. One stack-bearing error rejects the
    // failing request and every co-resident alike.
    if (response.kind === 'fatal') {
      this.#retire(new Error(
        `TS_ACCOUNT_WORKER_THREAD_FATAL:${this.#slot}:request=${response.requestId}:${response.error}`
        + (response.stack ? `\n${response.stack}` : ''),
      ));
      return;
    }
    const pending = this.#pending.get(response.requestId);
    if (pending) {
      this.#settle(response.requestId);
      pending.resolve(response);
    } else if (!this.#abandoned.delete(response.requestId)) {
      // Preserve envelope shape, never financial payloads or signing material,
      // when a foreign/malformed message poisons this isolate's mailbox.
      const fields = Object.keys(response).slice(0, 8).map(key => key.slice(0, 32)).join(',');
      this.#retire(new Error(
        `TS_ACCOUNT_WORKER_UNMATCHED_RESPONSE:${this.#slot}:${response.requestId}`
        + `:fields=${fields}:kindType=${typeof response.kind}:pending=${this.#pending.size}`,
      ));
    }
  }

  #retire(error: Error, terminate = true): void {
    if (this.#retired) return;
    this.#retired = error;
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    this.#abandoned.clear();
    this.#residents.clear();
    for (const request of pending) request.reject(error);
    // Fail-stop owns the isolate as well as its mailbox: retaining it would
    // only leak a schedulable thread into the next pool user.
    if (terminate) this.#worker.terminate();
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

let poolSize: number | null = null;
const threads: Array<TsAccountWorkerThread | undefined> = [];
let nextResidentId = 1;

/** Fixed for the process at first use. */
export const tsAccountWorkerPoolSize = (): number => {
  poolSize ??= canonicalTsAccountWorkerCount();
  return poolSize;
};

/**
 * Placement only, never consensus: rotate each owner's logical workers by its
 * id so co-located owners whose Accounts share shards (MM Entities facing the
 * same hubs) still spread across threads.
 */
export const tsAccountWorkerThreadSlot = (ownerEntityId: string, workerIndex: number): number => {
  const ownerOffset = Number.parseInt(ownerEntityId.slice(2, 10), 16);
  if (!Number.isSafeInteger(ownerOffset)) throw new Error(`TS_ACCOUNT_WORKER_OWNER_SLOT:${ownerEntityId}`);
  return (ownerOffset + workerIndex) % tsAccountWorkerPoolSize();
};

export type TsAccountWorkerResidency = Readonly<{ thread: TsAccountWorkerThread; residentId: number }>;

const liveThread = (slot: number): TsAccountWorkerThread => {
  let thread = threads[slot];
  if (thread === undefined || thread.retired !== null) {
    thread = new TsAccountWorkerThread(slot);
    threads[slot] = thread;
  }
  return thread;
};

/**
 * Start every pool isolate now. Module load (~140 ms per isolate) then runs on
 * the worker threads while the main thread proceeds, instead of stalling the
 * first Account dispatch. Placement and results are unchanged.
 */
export const startTsAccountWorkerPool = (): void => {
  for (let slot = 0; slot < tsAccountWorkerPoolSize(); slot += 1) liveThread(slot);
};

export const acquireTsAccountWorkerResidency = (slot: number): TsAccountWorkerResidency => {
  if (!Number.isSafeInteger(slot) || slot < 0 || slot >= tsAccountWorkerPoolSize()) {
    throw new Error(`TS_ACCOUNT_WORKER_POOL_SLOT:${slot}:${tsAccountWorkerPoolSize()}`);
  }
  const thread = liveThread(slot);
  const residentId = nextResidentId;
  nextResidentId += 1;
  thread.attach(residentId);
  return { thread, residentId };
};

export const tsAccountWorkerPoolStats = (): Readonly<{ size: number; threads: number; residents: number }> => {
  const live = threads.filter((thread): thread is TsAccountWorkerThread =>
    thread !== undefined && thread.retired === null);
  return {
    size: tsAccountWorkerPoolSize(),
    threads: live.length,
    residents: live.reduce((sum, thread) => sum + thread.residents, 0),
  };
};

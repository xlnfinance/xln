const PATCHED = Symbol.for('xln.performance.boundaryAudit.patched');

type BoundaryAuditCounters = Readonly<{
  countOp(name: string, bytes?: number, durationUs?: number): void;
  countOpWithSite(name: string, bytes?: number, skipFrames?: number): void;
}>;
let auditCounters: BoundaryAuditCounters | undefined;

const countOp = (name: string, bytes = 0, durationUs = 0): void => {
  if (!auditCounters) throw new Error('BOUNDARY_AUDIT_COUNTERS_NOT_INSTALLED');
  auditCounters.countOp(name, bytes, durationUs);
};

const countOpWithSite = (name: string, bytes = 0, skipFrames = 2): void => {
  if (!auditCounters) throw new Error('BOUNDARY_AUDIT_COUNTERS_NOT_INSTALLED');
  auditCounters.countOpWithSite(name, bytes, skipFrames);
};

const byteLengthOf = (value: unknown): number => {
  if (typeof value === 'string') return new TextEncoder().encode(value).byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  return 0;
};

const markPatched = (target: object): void => {
  Object.defineProperty(target, PATCHED, { value: true, configurable: false });
};

const countRpcMethods = (body: unknown): void => {
  if (typeof body !== 'string') return;
  let counted = 0;
  for (const match of body.matchAll(/"method"\s*:\s*"([A-Za-z0-9_.:-]{1,80})"/g)) {
    const method = match[1];
    if (method === undefined) throw new Error('BOUNDARY_AUDIT_RPC_METHOD_CAPTURE_MISSING');
    countOp(`boundary.http.rpc.${method}`);
    counted += 1;
    if (counted >= 256) break;
  }
};

const installFetchAudit = (): void => {
  const original = globalThis.fetch;
  if (typeof original !== 'function' || PATCHED in original) return;
  const audited = (async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const init = args[1];
    const bytes = byteLengthOf(init?.body);
    countOpWithSite('boundary.http.request', bytes, 1);
    countRpcMethods(init?.body);
    const startedAt = performance.now();
    try {
      const response = await original(...args);
      countOp(`boundary.http.response.${Math.floor(response.status / 100)}xx`);
      return response;
    } finally {
      countOp('boundary.http.duration', 0, Math.round((performance.now() - startedAt) * 1_000));
    }
  }) as typeof fetch;
  markPatched(audited);
  globalThis.fetch = audited;
};

const patchWebSocketConstructor = (value: unknown): void => {
  if (typeof value !== 'function') return;
  const prototype = Reflect.get(value, 'prototype') as unknown;
  if (!prototype || typeof prototype !== 'object' || PATCHED in prototype) return;
  const original = Reflect.get(prototype, 'send') as unknown;
  if (typeof original !== 'function') return;
  Reflect.set(prototype, 'send', function (this: unknown, ...args: unknown[]): unknown {
    countOpWithSite('boundary.socket.send', byteLengthOf(args[0]), 1);
    return original.apply(this, args);
  });
  markPatched(prototype);
};

const installWebSocketAudit = async (): Promise<void> => {
  patchWebSocketConstructor((globalThis as typeof globalThis & { WebSocket?: unknown }).WebSocket);
  if ((globalThis as typeof globalThis & { Bun?: unknown }).Bun !== undefined) return;
  const ws = await import('ws');
  patchWebSocketConstructor(ws.WebSocket);
};

const installBunServerSocketAudit = (): void => {
  const bun = (globalThis as { Bun?: object }).Bun;
  if (!bun || PATCHED in bun) return;
  const originalServe = Reflect.get(bun, 'serve') as unknown;
  if (typeof originalServe !== 'function') return;
  const patchableBun = bun;
  Reflect.set(patchableBun, 'serve', function (this: unknown, ...args: unknown[]): unknown {
    const options = args[0];
    if (options && typeof options === 'object') {
      const websocket = (options as Record<string, unknown>)['websocket'];
      if (websocket && typeof websocket === 'object') {
        const callbacks = websocket;
        for (const hook of ['open', 'message', 'drain', 'close']) {
          const originalHook = Reflect.get(callbacks, hook) as unknown;
          if (typeof originalHook !== 'function') continue;
          Reflect.set(callbacks, hook, function (this: unknown, ...callbackArgs: unknown[]): unknown {
            const socket = callbackArgs[0];
            if (socket && typeof socket === 'object') {
              patchWebSocketConstructor((socket as { constructor?: unknown }).constructor);
            }
            return originalHook.apply(this, callbackArgs);
          });
        }
      }
    }
    return originalServe.apply(this, args);
  });
  markPatched(patchableBun);
};

const wrapPromiseMethod = (
  prototype: object,
  method: string,
  operation: string,
  requestBytesAt: (args: readonly unknown[]) => number,
  resultBytesAt: (result: unknown) => number = () => 0,
): void => {
  const original = Reflect.get(prototype, method) as unknown;
  if (typeof original !== 'function') return;
  Reflect.set(prototype, method, function (this: unknown, ...args: unknown[]): unknown {
    countOpWithSite(`${operation}.call`, requestBytesAt(args), 1);
    const startedAt = performance.now();
    const result = original.apply(this, args);
    if (!(result instanceof Promise)) return result;
    return result.then((resolved) => {
      countOp(`${operation}.result`, resultBytesAt(resolved));
      return resolved;
    }).finally(() => {
      countOp(`${operation}.duration`, 0, Math.round((performance.now() - startedAt) * 1_000));
    });
  });
};

const batchBytes = (value: unknown): number => {
  if (!Array.isArray(value)) return 0;
  return value.reduce((total, operation) => {
    if (!operation || typeof operation !== 'object') return total;
    const record = operation as Record<string, unknown>;
    return total + byteLengthOf(record['key']) + byteLengthOf(record['value']);
  }, 0);
};

const patchChainedLevelBatch = (chained: object): void => {
  if (!(PATCHED in chained)) {
    for (const [method, operation] of [['put', 'boundary.level.chainedPut'], ['del', 'boundary.level.chainedDel']] as const) {
      const original = Reflect.get(chained, method) as unknown;
      if (typeof original !== 'function') continue;
      Reflect.set(chained, method, function (this: unknown, ...args: unknown[]): unknown {
        countOpWithSite(operation, byteLengthOf(args[0]) + byteLengthOf(args[1]), 1);
        return original.apply(this, args);
      });
    }
    wrapPromiseMethod(chained, 'write', 'boundary.level.chainedWrite', () => 0);
    markPatched(chained);
  }
};

const installLevelAudit = async (): Promise<void> => {
  const { Level } = await import('level');
  const level = Level.prototype;
  if (PATCHED in level) return;
  wrapPromiseMethod(level, 'get', 'boundary.level.get', args =>
    byteLengthOf(args[0]), byteLengthOf);
  wrapPromiseMethod(level, 'put', 'boundary.level.put', args =>
    byteLengthOf(args[0]) + byteLengthOf(args[1]));
  wrapPromiseMethod(level, 'del', 'boundary.level.del', args => byteLengthOf(args[0]));
  const originalBatch = Reflect.get(level, 'batch') as unknown;
  if (typeof originalBatch === 'function') {
    Reflect.set(level, 'batch', function (this: unknown, ...args: unknown[]): unknown {
      countOpWithSite('boundary.level.batch.call', batchBytes(args[0]), 1);
      const startedAt = performance.now();
      const result = originalBatch.apply(this, args);
      if (result && typeof result === 'object' && !(result instanceof Promise)) {
        patchChainedLevelBatch(Object.getPrototypeOf(result) as object);
        return result;
      }
      if (!(result instanceof Promise)) return result;
      return result.finally(() => {
        countOp('boundary.level.batch.duration', 0, Math.round((performance.now() - startedAt) * 1_000));
      });
    });
  }
  markPatched(level);
};

const installTimerAudit = (): void => {
  const originalTimeout = globalThis.setTimeout;
  if (!(PATCHED in originalTimeout)) {
    const auditedTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      countOpWithSite('boundary.timer.timeoutScheduled', 0, 1);
      const auditedHandler = typeof handler === 'function'
        ? (...callbackArgs: unknown[]): unknown => {
            countOp('boundary.timer.timeoutTick');
            return handler(...callbackArgs);
          }
        : handler;
      return originalTimeout(auditedHandler, timeout, ...args);
    }) as typeof setTimeout;
    markPatched(auditedTimeout);
    globalThis.setTimeout = auditedTimeout;
  }

  const originalInterval = globalThis.setInterval;
  if (!(PATCHED in originalInterval)) {
    const auditedInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      countOpWithSite('boundary.timer.intervalScheduled', 0, 1);
      const auditedHandler = typeof handler === 'function'
        ? (...callbackArgs: unknown[]): unknown => {
            countOp('boundary.timer.intervalTick');
            return handler(...callbackArgs);
          }
        : handler;
      return originalInterval(auditedHandler, timeout, ...args);
    }) as typeof setInterval;
    markPatched(auditedInterval);
    globalThis.setInterval = auditedInterval;
  }
};

/** Diagnostic-only coverage net for system boundaries. Explicit counters stay
 * authoritative; this patch finds forgotten call sites by sampled stacks. */
export const installBoundaryAudit = async (counters: BoundaryAuditCounters): Promise<void> => {
  auditCounters = counters;
  installFetchAudit();
  installTimerAudit();
  installBunServerSocketAudit();
  await installWebSocketAudit();
  await installLevelAudit();
};

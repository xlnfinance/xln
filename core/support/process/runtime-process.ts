type RuntimeProcessLike = { env?: Record<string, string | undefined> };

// Web Workers do not expose `window`, but they are still browser runtimes and
// need the same minimal process shim as the page bundle. Bun/Node workers keep
// their real global process, so this does not misclassify server workers.
export const runtimeIsBrowser =
  typeof window !== 'undefined' || typeof globalThis.process === 'undefined';

export const readRuntimeEnv = (name: string): string | undefined => {
  try {
    const proc = (globalThis as typeof globalThis & { process?: RuntimeProcessLike }).process;
    const value = proc?.env?.[name];
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
};

const ensureBrowserProcessShim = (): void => {
  if (!runtimeIsBrowser || typeof globalThis.process !== 'undefined') return;

  const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
  const hrtime = (prev?: [number, number]) => {
    const ms = nowMs();
    const sec = Math.floor(ms / 1000);
    const ns = Math.floor((ms - sec * 1000) * 1e6);
    if (prev) {
      let secDiff = sec - prev[0];
      let nsDiff = ns - prev[1];
      if (nsDiff < 0) {
        secDiff -= 1;
        nsDiff += 1e9;
      }
      return [secDiff, nsDiff] as [number, number];
    }
    return [sec, ns] as [number, number];
  };
  type BrowserProcessShim = {
    env: Record<string, string | undefined>;
    browser: true;
    version: string;
    versions: { node: string };
    nextTick: (cb: (...args: unknown[]) => void, ...args: unknown[]) => void;
    hrtime: (prev?: [number, number]) => [number, number];
    uptime: () => number;
    cwd: () => string;
  };
  const processShim: BrowserProcessShim = {
    env: {},
    browser: true,
    version: '0',
    versions: { node: '0' },
    nextTick: (cb: (...args: unknown[]) => void, ...args: unknown[]) => {
      if (typeof queueMicrotask === 'function') {
        queueMicrotask(() => cb(...args));
      } else {
        Promise.resolve().then(() => cb(...args));
      }
    },
    hrtime,
    uptime: () => nowMs() / 1000,
    cwd: () => '/',
  };
  Object.assign(globalThis, { process: processShim });
};

ensureBrowserProcessShim();

export const runtimeProcessEnv =
  typeof globalThis === 'object'
    ? (globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } }).process?.env
    : undefined;

export const isProductionRuntime = runtimeProcessEnv?.['NODE_ENV'] === 'production';
export const nodeProcess = !runtimeIsBrowser && typeof globalThis.process !== 'undefined'
  ? globalThis.process
  : undefined;

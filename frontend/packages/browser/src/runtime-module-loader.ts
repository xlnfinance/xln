export type BrowserRuntimeModuleLoaderOptions<RuntimeModule> = Readonly<{
  validate: (candidate: unknown) => candidate is RuntimeModule;
  readSchemaVersion: (runtime: RuntimeModule) => unknown;
  readOrigin?: () => string;
  readCacheKey?: () => string;
  importModule?: (url: string) => Promise<unknown>;
}>;

export type BrowserRuntimeModuleLoader<RuntimeModule> = Readonly<{
  load: () => Promise<RuntimeModule>;
  readLoaded: () => RuntimeModule | null;
}>;

const defaultOrigin = (): string => {
  if (typeof window === 'undefined') throw new Error('RUNTIME_BROWSER_WINDOW_REQUIRED');
  return window.location.origin;
};

const defaultImport = (url: string): Promise<unknown> =>
  import(/* @vite-ignore */ url) as Promise<unknown>;

const validateSchemaVersion = <RuntimeModule>(
  runtime: RuntimeModule,
  readSchemaVersion: (runtime: RuntimeModule) => unknown,
): void => {
  const rawSchema = readSchemaVersion(runtime);
  const schema = Number(rawSchema ?? Number.NaN);
  if (Number.isFinite(schema) && schema >= 1) return;
  throw new Error(`RUNTIME_VERSION_MISMATCH: invalid runtime schema=${String(rawSchema ?? 'undefined')}`);
};

export const createBrowserRuntimeModuleLoader = <RuntimeModule>(
  options: BrowserRuntimeModuleLoaderOptions<RuntimeModule>,
): BrowserRuntimeModuleLoader<RuntimeModule> => {
  let loaded: RuntimeModule | null = null;
  let inFlight: Promise<RuntimeModule> | null = null;
  const readOrigin = options.readOrigin ?? defaultOrigin;
  const readCacheKey = options.readCacheKey ?? (() => String(Date.now()));
  const importModule = options.importModule ?? defaultImport;

  const loadOnce = async (): Promise<RuntimeModule> => {
    const runtimeUrl = new URL(`/runtime.js?v=${readCacheKey()}`, readOrigin()).href;
    const candidate = await importModule(runtimeUrl);
    if (!options.validate(candidate)) {
      throw new Error('RUNTIME_API_MISMATCH: runtime.js is missing required bootstrap exports');
    }
    validateSchemaVersion(candidate, options.readSchemaVersion);
    loaded = candidate;
    return candidate;
  };

  const load = async (): Promise<RuntimeModule> => {
    if (loaded) return loaded;
    if (!inFlight) inFlight = loadOnce();
    try {
      return await inFlight;
    } catch (error: unknown) {
      inFlight = null;
      throw error;
    }
  };

  return { load, readLoaded: () => loaded };
};

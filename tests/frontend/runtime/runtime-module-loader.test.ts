import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { createBrowserRuntimeModuleLoader } from '../../../frontend/packages/browser/src/runtime-module-loader';

type TestRuntime = Readonly<{ schema: number; main: () => void }>;

const isTestRuntime = (candidate: unknown): candidate is TestRuntime =>
  Boolean(candidate && typeof candidate === 'object' && typeof (candidate as { main?: unknown }).main === 'function');

const createLoader = (importModule: (url: string) => Promise<unknown>) =>
  createBrowserRuntimeModuleLoader<TestRuntime>({
    validate: isTestRuntime,
    readSchemaVersion: (runtime) => runtime.schema,
    readOrigin: () => 'https://wallet.example',
    readCacheKey: () => 'candidate-7',
    importModule,
  });

describe('browser Runtime module loader', () => {
  test('loads the exact same-origin Runtime route with one page-load cache key', async () => {
    const urls: string[] = [];
    const runtime = { schema: 1, main: () => {} };
    const loader = createLoader(async (url) => { urls.push(url); return runtime; });

    expect(await Promise.all([loader.load(), loader.load()])).toEqual([runtime, runtime]);
    expect(await loader.load()).toBe(runtime);
    expect(loader.readLoaded()).toBe(runtime);
    expect(urls).toEqual(['https://wallet.example/runtime.js?v=candidate-7']);
  });

  test('rejects a module without the required public Runtime API', async () => {
    const loader = createLoader(async () => ({ schema: 1 }));
    await expect(loader.load()).rejects.toThrow('RUNTIME_API_MISMATCH');
    expect(loader.readLoaded()).toBeNull();
  });

  test('rejects missing and invalid schema versions', async () => {
    for (const schema of [undefined, 0, Number.NaN]) {
      const loader = createLoader(async () => ({ schema, main: () => {} }));
      await expect(loader.load()).rejects.toThrow('RUNTIME_VERSION_MISMATCH');
    }
  });

  test('clears a failed import so an explicit retry can succeed', async () => {
    const runtime = { schema: 2, main: () => {} };
    let attempts = 0;
    const loader = createLoader(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('RUNTIME_FETCH_FAILED');
      return runtime;
    });

    await expect(loader.load()).rejects.toThrow('RUNTIME_FETCH_FAILED');
    expect(await loader.load()).toBe(runtime);
    expect(attempts).toBe(2);
  });

  test('is the single loader used by both Svelte and React boot paths', () => {
    const svelte = readFileSync('frontend/src/lib/stores/bootstrap/xlnRuntimeLoader.ts', 'utf8');
    const react = readFileSync('frontend/apps/wallet/src/wallet-embedded-runtime-bootstrap.ts', 'utf8');
    for (const source of [svelte, react]) {
      expect(source).toContain('createBrowserRuntimeModuleLoader');
      expect(source).not.toContain('import(/* @vite-ignore */ runtimeUrl)');
    }
  });
});

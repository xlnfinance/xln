import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clearJurisdictionsCache, loadJurisdictions } from '../jurisdiction/adapter/jurisdiction-loader';

const tempRoots: string[] = [];

const captureConsole = async <T>(fn: () => T | Promise<T>): Promise<{ result: T; messages: unknown[][] }> => {
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  const messages: unknown[][] = [];
  console.log = (...args: unknown[]) => messages.push(args);
  console.warn = (...args: unknown[]) => messages.push(args);
  console.error = (...args: unknown[]) => messages.push(args);

  try {
    const result = await fn();
    return { result, messages };
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
};

const useTempJurisdictionsPath = (filename = 'jurisdictions.json'): string => {
  const root = mkdtempSync(join(tmpdir(), 'xln-jurisdiction-loader-'));
  tempRoots.push(root);
  const path = join(root, filename);
  process.env['XLN_JURISDICTIONS_PATH'] = path;
  clearJurisdictionsCache();
  return path;
};

afterEach(() => {
  delete process.env['XLN_JURISDICTIONS_PATH'];
  delete process.env['XLN_JURISDICTIONS_DEBUG'];
  clearJurisdictionsCache();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('jurisdiction loader diagnostics', () => {
  test('uses structured logging without direct console output', () => {
    const source = readFileSync(join(process.cwd(), 'runtime/jurisdiction/adapter/jurisdiction-loader.ts'), 'utf8');

    expect(source).toContain("const jurisdictionLoaderLog = createStructuredLogger('runtime.jurisdiction_loader');");
    expect(source).toContain("logJurisdictionLoaderDebug('config_loaded'");
    expect(source).toContain("logJurisdictionLoaderDebug('cache_cleared'");
    expect(source).toContain('JURISDICTIONS_CONFIG_MISSING');
    expect(source).not.toContain('console.');
    expect(source).not.toContain('new Date()');
  });

  test('missing canonical config fails loud without logging', async () => {
    const path = useTempJurisdictionsPath();
    const { messages } = await captureConsole(async () => {
      expect(() => loadJurisdictions())
        .toThrow(`JURISDICTIONS_LOAD_FAILED:path=unknown:JURISDICTIONS_CONFIG_MISSING:path=${path}`);
    });
    expect(messages).toEqual([]);
  });

  test('invalid config fails loud with path-scoped load error', () => {
    const path = useTempJurisdictionsPath();
    writeFileSync(path, '{not-json', 'utf8');

    expect(() => loadJurisdictions()).toThrow(`JURISDICTIONS_LOAD_FAILED:path=${path}:`);
  });
});

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getAvailableJurisdictions } from '../../../jurisdiction/adapter/core/config';
import { resolveJurisdictionsJsonPath } from '../../../jurisdiction/adapter/jurisdictions-path';

test('canonical jurisdiction path follows the repository contract config', () => {
  const normalized = resolveJurisdictionsJsonPath().replaceAll('\\', '/');
  expect(normalized).toEndWith('/jurisdictions/jurisdictions.json');
  expect(normalized).not.toContain('/runtime/jurisdictions/');
});

test('jurisdiction config loader uses structured logging without direct console output', () => {
  const source = readFileSync(join(process.cwd(), 'runtime/jurisdiction/adapter/core/config.ts'), 'utf8');

  expect(source).toContain("const jurisdictionConfigLog = createStructuredLogger('runtime.jurisdiction_config');");
  expect(source).toContain('JURISDICTIONS_BROWSER_FETCH_FAILED');
  expect(source).toContain("jurisdictionConfigLog.error('browser_config_invalid'");
  expect(source).toContain('JURISDICTIONS_BROWSER_CONFIG_INVALID');
  expect(source).not.toContain('console.');
});

test('node jurisdiction load stays quiet for valid canonical config', async () => {
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
    const jurisdictions = await getAvailableJurisdictions();
    expect(jurisdictions.length).toBeGreaterThan(0);
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }

  expect(messages).toEqual([]);
});

test('canonical Sepolia deployment stays pending so local debug only loads anvil/Tron', async () => {
  const jurisdictions = await getAvailableJurisdictions();
  const sepolia = jurisdictions.find((entry) => entry.chainId === 11_155_111);
  expect(sepolia).toBeUndefined();

  const chainIds = new Set(jurisdictions.map((entry) => entry.chainId));
  expect(chainIds.has(31_337)).toBe(true);
  expect(chainIds.has(31_338)).toBe(true);
  expect(chainIds.has(11_155_111)).toBe(false);
});

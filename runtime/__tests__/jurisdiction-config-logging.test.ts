import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getAvailableJurisdictions } from '../jurisdiction-config';

test('jurisdiction config loader uses structured logging without direct console output', () => {
  const source = readFileSync(join(process.cwd(), 'runtime/jurisdiction-config.ts'), 'utf8');

  expect(source).toContain("const jurisdictionConfigLog = createStructuredLogger('runtime.jurisdiction_config');");
  expect(source).toContain("jurisdictionConfigLog.debug('browser_api_unavailable'");
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

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { calculateSolvency, verifySolvency } from '../account/solvency';
import type { Env } from '../types';

const ENTITY_A = `0x${'11'.repeat(32)}`;
const ENTITY_B = `0x${'22'.repeat(32)}`;

const makeEnv = (): Env => ({
  eReplicas: new Map([
    ['a', {
      state: {
        entityId: ENTITY_A,
        reserves: new Map([[1, 5n]]),
        accounts: new Map([
          [ENTITY_B, {
            deltas: new Map([
              [1, { collateral: 3n }],
            ]),
          }],
        ]),
      },
    }],
  ]),
  jReplicas: new Map(),
  height: 0,
  timestamp: 0,
} as unknown as Env);

test('solvency diagnostics use structured logging only', () => {
  const source = readFileSync(join(process.cwd(), 'runtime/account/solvency.ts'), 'utf8');

  expect(source).toContain("const solvencyLog = createStructuredLogger('runtime.solvency');");
  expect(source).toContain("solvencyLog.error('violation'");
  expect(source).toContain("solvencyLog.info('ok'");
  expect(source).not.toContain('console.');
});

test('calculate and verify solvency preserve aggregate behavior', () => {
  const env = makeEnv();
  const solvency = calculateSolvency(env);

  expect(solvency.reserves).toBe(5n);
  expect(solvency.collateral).toBe(3n);
  expect(solvency.total).toBe(8n);
  expect(solvency.byToken.get(1)).toEqual({ reserves: 5n, collateral: 3n, total: 8n });

  const previousScopes = process.env['XLN_LOG_SCOPES'];
  process.env['XLN_LOG_SCOPES'] = 'test-suppressed';
  try {
    expect(verifySolvency(env, 8n, 'unit')).toBe(true);
    expect(() => verifySolvency(env, 9n, 'unit')).toThrow('Solvency check failed: 8 !== 9');
  } finally {
    if (previousScopes === undefined) delete process.env['XLN_LOG_SCOPES'];
    else process.env['XLN_LOG_SCOPES'] = previousScopes;
  }
});

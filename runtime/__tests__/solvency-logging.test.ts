import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { calculateSolvency, verifySolvency } from '../account/solvency';
import type { Env } from '../types';

const ENTITY_A = `0x${'11'.repeat(32)}`;
const ENTITY_B = `0x${'22'.repeat(32)}`;
const ENTITY_C = `0x${'55'.repeat(32)}`;
const ENTITY_D = `0x${'ff'.repeat(32)}`;
const DEPOSITORY = `0x${'33'.repeat(20)}`;
const SECOND_DEPOSITORY = `0x${'66'.repeat(20)}`;

const expectVerificationFailure = (env: Env, label: string): void => {
  const previousScopes = process.env['XLN_LOG_SCOPES'];
  process.env['XLN_LOG_SCOPES'] = 'test-suppressed';
  try {
    expect(() => verifySolvency(env, label)).toThrow('Solvency check failed');
  } finally {
    if (previousScopes === undefined) delete process.env['XLN_LOG_SCOPES'];
    else process.env['XLN_LOG_SCOPES'] = previousScopes;
  }
};

const makeEnv = (): Env => ({
  eReplicas: new Map([
    ['a', {
      state: {
        entityId: ENTITY_A,
        height: 1,
        config: {
          mode: 'proposer-based', threshold: 1n, validators: ['signer'], shares: { signer: 1n },
          jurisdiction: {
            address: DEPOSITORY, name: 'Testnet', chainId: 31337,
            entityProviderAddress: `0x${'44'.repeat(20)}`, depositoryAddress: DEPOSITORY,
          },
        },
        reserves: new Map([[1, 3n]]),
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

test('calculate and verify solvency keep every jurisdiction asset independent', () => {
  const env = makeEnv();
  const solvency = calculateSolvency(env);
  const assetKey = `31337:${DEPOSITORY}:1`;

  expect(solvency.isValid).toBe(true);
  expect(solvency.byAsset.get(assetKey)).toEqual({
    stackId: `31337:${DEPOSITORY}`,
    chainId: 31337,
    depositoryAddress: DEPOSITORY,
    tokenId: 1,
    reserves: 3n,
    confirmedCollateral: 3n,
    pendingCollateral: 0n,
    delta: 0n,
    isValid: true,
  });

  const previousScopes = process.env['XLN_LOG_SCOPES'];
  process.env['XLN_LOG_SCOPES'] = 'test-suppressed';
  try {
    expect(verifySolvency(env, 'unit')).toBe(true);
    env.eReplicas.values().next().value!.state.reserves = new Map([[1, 1n], [2, 2n]]);
    env.eReplicas.values().next().value!.state.accounts.get(ENTITY_B)!.deltas = new Map([
      [1, { collateral: 2n }],
      [2, { collateral: 1n }],
    ] as never);
    expectVerificationFailure(env, 'unit');
  } finally {
    if (previousScopes === undefined) delete process.env['XLN_LOG_SCOPES'];
    else process.env['XLN_LOG_SCOPES'] = previousScopes;
  }
});

test('a surplus in one token never covers a deficit in another token', () => {
  const env = makeEnv();
  const state = env.eReplicas.values().next().value!.state;
  state.reserves = new Map([[1, 1n], [2, 2n]]);
  state.accounts.get(ENTITY_B)!.deltas = new Map([
    [1, { collateral: 2n }],
    [2, { collateral: 1n }],
  ] as never);

  const solvency = calculateSolvency(env);
  expect(solvency.byAsset.get(`31337:${DEPOSITORY}:1`)?.delta).toBe(-1n);
  expect(solvency.byAsset.get(`31337:${DEPOSITORY}:2`)?.delta).toBe(1n);
  expect(solvency.isValid).toBe(false);
  expectVerificationFailure(env, 'cross-token-cancellation');
});

test('the same token id in two Depositories remains two independent assets', () => {
  const env = makeEnv();
  const secondReplica = structuredClone(env.eReplicas.values().next().value!);
  secondReplica.entityId = ENTITY_C;
  secondReplica.signerId = 'second-stack-signer';
  secondReplica.state.entityId = ENTITY_C;
  secondReplica.state.config.jurisdiction = {
    ...secondReplica.state.config.jurisdiction!,
    address: SECOND_DEPOSITORY,
    depositoryAddress: SECOND_DEPOSITORY,
  };
  secondReplica.state.reserves = new Map([[1, 7n]]);
  secondReplica.state.accounts = new Map([
    [ENTITY_D, { deltas: new Map([[1, { collateral: 7n }]]) }],
  ] as never);
  env.eReplicas.set('second-stack', secondReplica);

  const solvency = calculateSolvency(env);
  expect(solvency.entityCount).toBe(2);
  expect(solvency.byAsset.size).toBe(2);
  expect(solvency.byAsset.get(`31337:${DEPOSITORY}:1`)?.reserves).toBe(3n);
  expect(solvency.byAsset.get(`31337:${SECOND_DEPOSITORY}:1`)?.reserves).toBe(7n);
  expect(solvency.isValid).toBe(true);
});

test('multiple validator replicas of one Entity are counted once', () => {
  const env = makeEnv();
  const firstReplica = env.eReplicas.values().next().value!;
  firstReplica.entityId = ENTITY_A;
  firstReplica.signerId = 'validator-b';
  firstReplica.state.accounts = new Map();
  const secondReplica = structuredClone(firstReplica);
  secondReplica.signerId = 'validator-a';
  env.eReplicas.set('second-validator', secondReplica);

  const solvency = calculateSolvency(env);
  expect(solvency.entityCount).toBe(1);
  expect(solvency.byAsset.get(`31337:${DEPOSITORY}:1`)?.reserves).toBe(3n);
});

test('same-height divergent validator replicas fail loud', () => {
  const env = makeEnv();
  const firstReplica = env.eReplicas.values().next().value!;
  firstReplica.entityId = ENTITY_A;
  firstReplica.signerId = 'validator-a';
  firstReplica.state.accounts = new Map();
  const conflictingReplica = structuredClone(firstReplica);
  conflictingReplica.signerId = 'validator-b';
  conflictingReplica.state.reserves = new Map([[1, 4n]]);
  env.eReplicas.set('conflicting-validator', conflictingReplica);

  expect(() => calculateSolvency(env)).toThrow('SOLVENCY_ENTITY_REPLICA_DIVERGENCE');
});

import { expect, test } from 'bun:test';

import { calculateSolvency } from '../../../runtime/swap-cmd/solvency';
import { computeCanonicalEntityConsensusStateHash, computeEntityAccountValueHash } from '../../../entity/consensus/state-root';
import { PersistentEntityAccountMap } from '../../../entity/state/persistent-account-map';
import type { RuntimeReplica } from '../../../runtime/types';

const ENTITY_A = `0x${'11'.repeat(32)}`;
const ENTITY_B = `0x${'22'.repeat(32)}`;
const ENTITY_C = `0x${'55'.repeat(32)}`;
const ENTITY_D = `0x${'ff'.repeat(32)}`;
const DEPOSITORY = `0x${'33'.repeat(20)}`;
const SECOND_DEPOSITORY = `0x${'66'.repeat(20)}`;

/** Depository totals the jurisdiction would report, keyed `stackId:tokenId`. */
const onChain = (entries: Array<[string, bigint]>): Map<string, bigint> => new Map(entries);

const makeEnv = (): RuntimeReplica => ({
  state: {
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
        paybook: { entries: new Map(), feesEarned: 0n },
        accounts: new Map([
          [ENTITY_B, {
            state: {
              deltas: new Map([
                [1, { collateral: 3n }],
              ]),
            },
          }],
        ]),
      },
    }],
    ]),
    jReplicas: new Map(),
    height: 0,
    timestamp: 0,
  },
} as unknown as RuntimeReplica);

test('calculate solvency keeps every jurisdiction asset independent', () => {
  const env = makeEnv();
  const assetKey = `31337:${DEPOSITORY}:1`;
  // reserves 3 + collateral 3: the Depository would report 6 held for token 1.
  const totals = onChain([[assetKey, 6n]]);
  const solvency = calculateSolvency(env, undefined, totals);

  expect(solvency.isValid).toBe(true);
  expect(solvency.byAsset.get(assetKey)).toEqual({
    stackId: `31337:${DEPOSITORY}`,
    chainId: 31337,
    depositoryAddress: DEPOSITORY,
    tokenId: 1,
    reserves: 3n,
    confirmedCollateral: 3n,
    internalValue: 6n,
    expectedInternalValue: 6n,
    delta: 0n,
    isValid: true,
  });

  env.state.eReplicas.values().next().value!.state.reserves = new Map([[1, 1n], [2, 2n]]);
  env.state.eReplicas.values().next().value!.state.accounts.get(ENTITY_B)!.state.deltas = new Map([
    [1, { collateral: 2n }],
    [2, { collateral: 1n }],
  ] as never);
  // Internal value for token 1 is now 3, but the Depository still holds 6.
  expect(calculateSolvency(env, undefined, totals).isValid).toBe(false);
});

/**
 * The previous formula compared reserves against collateral, which is not the
 * law the jurisdiction enforces (`invariant_valueConservation`: reserves +
 * collateral == minted + external backing). Without the Depository totals a
 * Runtime cannot evaluate that law at all, so the absence of a verdict must be
 * visible as `null` and must never be reported as a pass.
 */
test('an unchecked asset reports no verdict rather than a green one', () => {
  const env = makeEnv();
  const solvency = calculateSolvency(env);
  const asset = solvency.byAsset.get(`31337:${DEPOSITORY}:1`);

  expect(asset?.internalValue).toBe(6n);
  expect(asset?.expectedInternalValue).toBeNull();
  expect(asset?.delta).toBeNull();
  expect(asset?.isValid).toBeNull();
  expect(solvency.isValid).toBeNull();
});

test('partial on-chain totals never produce a green aggregate verdict', () => {
  const env = makeEnv();
  const state = env.state.eReplicas.values().next().value!.state;
  state.reserves = new Map([[1, 3n], [2, 2n]]);
  state.accounts.get(ENTITY_B)!.state.deltas = new Map([
    [1, { collateral: 3n }],
    [2, { collateral: 1n }],
  ] as never);
  const tokenOneKey = `31337:${DEPOSITORY}:1`;
  const tokenTwoKey = `31337:${DEPOSITORY}:2`;
  const totals = onChain([[tokenOneKey, 6n]]);

  const solvency = calculateSolvency(env, undefined, totals);

  expect(solvency.byAsset.get(tokenOneKey)?.isValid).toBe(true);
  expect(solvency.byAsset.get(tokenTwoKey)?.isValid).toBeNull();
  expect(solvency.isValid).toBeNull();
});

test('a surplus in one token never covers a deficit in another token', () => {
  const env = makeEnv();
  const state = env.state.eReplicas.values().next().value!.state;
  state.reserves = new Map([[1, 1n], [2, 2n]]);
  state.accounts.get(ENTITY_B)!.state.deltas = new Map([
    [1, { collateral: 2n }],
    [2, { collateral: 1n }],
  ] as never);

  // Token 1 holds 3 internally but 4 on chain; token 2 holds 3 but 2 on chain.
  // The two errors cancel in aggregate and must still be reported separately.
  const totals = onChain([
    [`31337:${DEPOSITORY}:1`, 4n],
    [`31337:${DEPOSITORY}:2`, 2n],
  ]);
  const solvency = calculateSolvency(env, undefined, totals);
  expect(solvency.byAsset.get(`31337:${DEPOSITORY}:1`)?.delta).toBe(-1n);
  expect(solvency.byAsset.get(`31337:${DEPOSITORY}:2`)?.delta).toBe(1n);
  expect(solvency.isValid).toBe(false);
});

test('the same token id in two Depositories remains two independent assets', () => {
  const env = makeEnv();
  const secondReplica = structuredClone(env.state.eReplicas.values().next().value!);
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
    [ENTITY_D, { state: { deltas: new Map([[1, { collateral: 7n }]]) } }],
  ] as never);
  env.state.eReplicas.set('second-stack', secondReplica);

  const solvency = calculateSolvency(env, undefined, onChain([
    [`31337:${DEPOSITORY}:1`, 6n],
    [`31337:${SECOND_DEPOSITORY}:1`, 14n],
  ]));
  expect(solvency.entityCount).toBe(2);
  expect(solvency.byAsset.size).toBe(2);
  expect(solvency.byAsset.get(`31337:${DEPOSITORY}:1`)?.reserves).toBe(3n);
  expect(solvency.byAsset.get(`31337:${SECOND_DEPOSITORY}:1`)?.reserves).toBe(7n);
  expect(solvency.isValid).toBe(true);
});

test('multiple validator replicas of one Entity are counted once', () => {
  const env = makeEnv();
  const firstReplica = env.state.eReplicas.values().next().value!;
  firstReplica.entityId = ENTITY_A;
  firstReplica.signerId = 'validator-b';
  firstReplica.state.accounts = PersistentEntityAccountMap.empty(ENTITY_A, computeEntityAccountValueHash);
  const secondReplica = { ...firstReplica, state: { ...firstReplica.state } };
  secondReplica.signerId = 'validator-a';
  env.state.eReplicas.set('second-validator', secondReplica);

  const solvency = calculateSolvency(env);
  expect(solvency.entityCount).toBe(1);
  expect(solvency.byAsset.get(`31337:${DEPOSITORY}:1`)?.reserves).toBe(3n);
});

test('same-height divergent validator replicas fail loud', () => {
  const env = makeEnv();
  const firstReplica = env.state.eReplicas.values().next().value!;
  firstReplica.entityId = ENTITY_A;
  firstReplica.signerId = 'validator-a';
  firstReplica.state.accounts = PersistentEntityAccountMap.empty(ENTITY_A, computeEntityAccountValueHash);
  const conflictingReplica = { ...firstReplica, state: { ...firstReplica.state } };
  conflictingReplica.signerId = 'validator-b';
  conflictingReplica.state.reserves = new Map([[1, 4n]]);
  env.state.eReplicas.set('conflicting-validator', conflictingReplica);

  const originalRoot = computeCanonicalEntityConsensusStateHash(firstReplica.state);
  const conflictingRoot = computeCanonicalEntityConsensusStateHash(conflictingReplica.state);
  expect(originalRoot).not.toBe(conflictingRoot);
  expect(() => calculateSolvency(env)).toThrow(
    `SOLVENCY_ENTITY_REPLICA_DIVERGENCE:${ENTITY_A}:1:${originalRoot}:${conflictingRoot}`,
  );
});

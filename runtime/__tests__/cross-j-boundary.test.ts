import { describe, expect, test } from 'bun:test';

import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../account/crypto';
import {
  entityInputHasCrossJurisdictionIntraRuntimeTx,
  isCrossJurisdictionSiblingPair,
} from '../extensions/cross-j/boundary';
import { deriveCanonicalCrossJurisdictionBookOwnerForLegs } from '../extensions/cross-j/market';
import {
  assertCrossJLocalOwnerCohort,
  assertCrossJLocalCohorts,
  assertInboundCrossJRuntimeTopology,
} from '../runtime/cross-j-topology';
import { applyPreparedRuntimeFrame } from '../runtime/frame/apply';
import { createFrameExecutionState } from '../runtime/frame/input/execution-state';
import { createRuntimeProcessProfile } from '../runtime/frame/process-profile';
import { createEmptyEnv } from '../runtime';
import type { CrossJurisdictionSwapRoute } from '../types/cross-jurisdiction';
import type { EntityTx } from '../types/entity-tx';
import { addReplica, addr, makeJurisdiction, makeState } from './helpers/cross-j';

const SOURCE_USER = `0x${'a1'.repeat(32)}`;
const TARGET_USER = `0x${'a2'.repeat(32)}`;
const SOURCE_HUB = `0x${'b1'.repeat(32)}`;
const TARGET_HUB = `0x${'b2'.repeat(32)}`;
const SOURCE_USER_SIGNER = addr('c1');
const TARGET_USER_SIGNER = addr('c2');
const SOURCE_HUB_SIGNER = addr('d1');
const TARGET_HUB_SIGNER = addr('d2');

const route: CrossJurisdictionSwapRoute = {
  orderId: 'cross-pull-close-boundary',
  makerEntityId: SOURCE_USER,
  hubEntityId: SOURCE_HUB,
  bookOwnerEntityId: SOURCE_HUB,
  sourceSignerId: SOURCE_USER_SIGNER,
  targetSignerId: TARGET_USER_SIGNER,
  sourceHubSignerId: SOURCE_HUB_SIGNER,
  targetHubSignerId: TARGET_HUB_SIGNER,
  source: {
    jurisdiction: 'source',
    entityId: SOURCE_USER,
    counterpartyEntityId: SOURCE_HUB,
    tokenId: 1,
    amount: 10n,
  },
  target: {
    jurisdiction: 'target',
    entityId: TARGET_HUB,
    counterpartyEntityId: TARGET_USER,
    tokenId: 2,
    amount: 20n,
  },
  status: 'resting',
  createdAt: 1,
  updatedAt: 2,
};

const closeTx = (txRoute?: CrossJurisdictionSwapRoute): EntityTx => ({
  type: 'crossPullClose',
  data: {
    counterpartyEntityId: TARGET_HUB,
    pullId: 'target-pull',
    binary: '0x01',
    proof: {
      orderId: route.orderId,
      routeHash: `0x${'44'.repeat(32)}`,
      sourcePullId: 'source-pull',
      targetPullId: 'target-pull',
      fillRatio: 65_535,
      cumulativeSourceAmount: 10n,
      cumulativeTargetAmount: 20n,
      binaryHash: `0x${'55'.repeat(32)}`,
      closeMode: 'full',
    },
    ...(txRoute ? { route: txRoute } : {}),
  },
});

const inputWith = (tx: EntityTx) => ({ entityTxs: [tx] });

const localSignerDeps = {
  hasLocalSignerForEntitySigner: (env: ReturnType<typeof createEmptyEnv>, entityId: string, signerId: string) =>
    [...env.state.eReplicas.values()].some(replica =>
      replica.entityId.toLowerCase() === entityId.toLowerCase() &&
      replica.signerId.toLowerCase() === signerId.toLowerCase()),
};

const ownedSignerDeps = (...signerIds: string[]) => ({
  hasLocalSignerForEntitySigner: (
    _env: ReturnType<typeof createEmptyEnv>,
    _entityId: string,
    signerId: string,
  ) => signerIds.some(local => local.toLowerCase() === signerId.toLowerCase()),
});

const addRouteOwner = (
  env: ReturnType<typeof createEmptyEnv>,
  entityId: string,
  signerId: string,
  counterpartyEntityId: string,
  ownerRoute: CrossJurisdictionSwapRoute = route,
) => {
  const state = makeState(entityId, signerId, makeJurisdiction('Topology', 1, '11', '12'), counterpartyEntityId);
  state.crossJurisdictionSwaps?.set(ownerRoute.orderId, ownerRoute);
  addReplica(env, state, signerId);
};

describe('cross-j runtime boundary', () => {
  test('classifies cross-j Entity inputs without pretending any remote hop is allowed', () => {
    expect(entityInputHasCrossJurisdictionIntraRuntimeTx(inputWith(closeTx(route)))).toBe(true);
    expect(entityInputHasCrossJurisdictionIntraRuntimeTx(inputWith(closeTx()))).toBe(true);
  });

  test('allows only the two sibling edges encoded by the route', () => {
    expect(isCrossJurisdictionSiblingPair(route, SOURCE_HUB, TARGET_HUB)).toBe(true);
    expect(isCrossJurisdictionSiblingPair(route, TARGET_HUB, SOURCE_HUB)).toBe(true);
    expect(isCrossJurisdictionSiblingPair(route, SOURCE_USER, TARGET_USER)).toBe(true);
    expect(isCrossJurisdictionSiblingPair(route, TARGET_USER, SOURCE_USER)).toBe(true);
  });

  test('rejects every Account edge and diagonal as a sibling message', () => {
    expect(isCrossJurisdictionSiblingPair(route, SOURCE_USER, SOURCE_HUB)).toBe(false);
    expect(isCrossJurisdictionSiblingPair(route, TARGET_HUB, TARGET_USER)).toBe(false);
    expect(isCrossJurisdictionSiblingPair(route, SOURCE_USER, TARGET_HUB)).toBe(false);
    expect(isCrossJurisdictionSiblingPair(route, SOURCE_HUB, TARGET_USER)).toBe(false);
  });

  test('chooses one book owner by numeric chain id in either trade direction', () => {
    const chain10 = `stack:10:0x${'10'.repeat(20)}`;
    const chain42161 = `stack:42161:0x${'42'.repeat(20)}`;
    expect(deriveCanonicalCrossJurisdictionBookOwnerForLegs(
      chain42161, TARGET_HUB, chain10, SOURCE_HUB,
    )).toBe(SOURCE_HUB);
    expect(deriveCanonicalCrossJurisdictionBookOwnerForLegs(
      chain10, SOURCE_HUB, chain42161, TARGET_HUB,
    )).toBe(SOURCE_HUB);
  });

  test('keeps every token market on the same stack-pair owner', () => {
    const chain10 = `stack:10:0x${'10'.repeat(20)}`;
    const chain42161 = `stack:42161:0x${'42'.repeat(20)}`;
    expect(deriveCanonicalCrossJurisdictionBookOwnerForLegs(
      chain10, SOURCE_HUB, chain42161, TARGET_HUB,
    )).toBe(SOURCE_HUB);
  });

  test('rejects a same-stack route before selecting a book owner', () => {
    const stack = `stack:10:0x${'10'.repeat(20)}`;
    expect(() => deriveCanonicalCrossJurisdictionBookOwnerForLegs(
      stack, SOURCE_HUB, stack, TARGET_HUB,
    )).toThrow('CROSS_J_REQUIRES_DISTINCT_STACKS');
  });

  test('fails closed when a book leg has no canonical chain id', () => {
    expect(() => deriveCanonicalCrossJurisdictionBookOwnerForLegs(
      'tron', SOURCE_HUB, `stack:10:0x${'10'.repeat(20)}`, TARGET_HUB,
    )).toThrow('CROSS_J_BOOK_JURISDICTION_INVALID');
  });

  test('requires both exact user and hub owner siblings on their Runtime', () => {
    const users = createEmptyEnv('cross-j-topology-users');
    addRouteOwner(users, SOURCE_USER, SOURCE_USER_SIGNER, SOURCE_HUB);
    expect(() => assertCrossJLocalOwnerCohort(users, route, 'user', localSignerDeps))
      .toThrow('USER_SIBLING_1_NOT_LOCAL');
    addRouteOwner(users, TARGET_USER, TARGET_USER_SIGNER, TARGET_HUB);
    expect(() => assertCrossJLocalOwnerCohort(users, route, 'user', localSignerDeps)).not.toThrow();

    const hubs = createEmptyEnv('cross-j-topology-hubs');
    addRouteOwner(hubs, SOURCE_HUB, SOURCE_HUB_SIGNER, SOURCE_USER);
    expect(() => assertCrossJLocalOwnerCohort(hubs, route, 'hub', localSignerDeps))
      .toThrow('HUB_SIBLING_1_NOT_LOCAL');
    addRouteOwner(hubs, TARGET_HUB, TARGET_HUB_SIGNER, TARGET_USER);
    expect(() => assertCrossJLocalOwnerCohort(hubs, route, 'hub', localSignerDeps)).not.toThrow();
  });

  test('authenticated hub ingress rejects split user owner runtimes', () => {
    const env = createEmptyEnv('cross-j-topology-ingress');
    addRouteOwner(env, SOURCE_HUB, SOURCE_HUB_SIGNER, SOURCE_USER);
    addRouteOwner(env, TARGET_HUB, TARGET_HUB_SIGNER, TARGET_USER);
    const runtimeByOwner = new Map([
      [`${SOURCE_USER}:${SOURCE_USER_SIGNER}`, 'user-runtime'],
      [`${TARGET_USER}:${TARGET_USER_SIGNER}`, 'other-user-runtime'],
      [`${SOURCE_HUB}:${SOURCE_HUB_SIGNER}`, env.runtimeId!],
      [`${TARGET_HUB}:${TARGET_HUB_SIGNER}`, env.runtimeId!],
    ]);
    expect(() => assertInboundCrossJRuntimeTopology(env, route, 'user-runtime', {
      ...localSignerDeps,
      resolveRuntimeId: (entityId, signerId) => runtimeByOwner.get(`${entityId}:${signerId}`) ?? null,
    })).toThrow('OWNER_RUNTIME_MISMATCH');
  });

  test('rejects user and hub sibling self-cycles', () => {
    const env = createEmptyEnv('cross-j-topology-self-cycle');
    expect(() => assertCrossJLocalOwnerCohort(env, {
      ...route,
      target: { ...route.target, counterpartyEntityId: SOURCE_USER },
      targetSignerId: SOURCE_USER_SIGNER,
    }, 'user', localSignerDeps)).toThrow('USER_SIBLINGS_NOT_DISTINCT');
    expect(() => assertCrossJLocalOwnerCohort(env, {
      ...route,
      target: { ...route.target, entityId: SOURCE_HUB },
      targetHubSignerId: SOURCE_HUB_SIGNER,
    }, 'hub', localSignerDeps)).toThrow('HUB_SIBLINGS_NOT_DISTINCT');
  });

  test('state guard rejects orphan, collocated, and incomplete terminal owner cohorts', () => {
    const env = createEmptyEnv('cross-j-topology-restore');
    addRouteOwner(env, SOURCE_USER, SOURCE_USER_SIGNER, SOURCE_HUB);
    expect(() => assertCrossJLocalCohorts(env, ownedSignerDeps(SOURCE_USER_SIGNER)))
      .toThrow('CROSS_J_LOCAL_SIBLING_MISSING');
    addRouteOwner(env, TARGET_USER, TARGET_USER_SIGNER, TARGET_HUB);
    expect(() => assertCrossJLocalCohorts(
      env,
      ownedSignerDeps(SOURCE_USER_SIGNER, TARGET_USER_SIGNER),
    )).not.toThrow();
    addRouteOwner(env, SOURCE_HUB, SOURCE_HUB_SIGNER, SOURCE_USER);
    expect(() => assertCrossJLocalCohorts(
      env,
      ownedSignerDeps(SOURCE_USER_SIGNER, TARGET_USER_SIGNER, SOURCE_HUB_SIGNER),
    )).toThrow('CROSS_J_OWNER_RUNTIME_COLLISION');

    expect(() => assertCrossJLocalCohorts(
      env,
      ownedSignerDeps(SOURCE_USER_SIGNER, TARGET_USER_SIGNER),
    )).not.toThrow();

    const terminalEnv = createEmptyEnv('cross-j-topology-terminal-restore');
    const state = makeState(SOURCE_USER, SOURCE_USER_SIGNER, makeJurisdiction('Topology', 1, '11', '12'), SOURCE_HUB);
    state.crossJurisdictionSwaps?.set(route.orderId, { ...route, status: 'settled' });
    addReplica(terminalEnv, state, SOURCE_USER_SIGNER);
    expect(() => assertCrossJLocalCohorts(terminalEnv, ownedSignerDeps(SOURCE_USER_SIGNER)))
      .toThrow('CROSS_J_LOCAL_SIBLING_MISSING');
  });

  test('Runtime frame guard rejects a live half-cohort and accepts both siblings together', async () => {
    const env = createEmptyEnv('cross-j-frame-cohort');
    const sourceSeed = 'cross-j-frame-source';
    const targetSeed = 'cross-j-frame-target';
    const sourceSigner = deriveSignerAddressSync(sourceSeed, '1').toLowerCase();
    const targetSigner = deriveSignerAddressSync(targetSeed, '1').toLowerCase();
    registerSignerKey(env, sourceSigner, deriveSignerKeySync(sourceSeed, '1'));
    registerSignerKey(env, targetSigner, deriveSignerKeySync(targetSeed, '1'));
    const liveRoute = { ...route, sourceSignerId: sourceSigner, targetSignerId: targetSigner };
    addRouteOwner(env, SOURCE_USER, sourceSigner, SOURCE_HUB, liveRoute);
    const input = { runtimeTxs: [], entityInputs: [] };
    const apply = () => applyPreparedRuntimeFrame(
      env,
      input,
      true,
      false,
      true,
      false,
      createFrameExecutionState(),
      createRuntimeProcessProfile(env, 'cross-j-frame-cohort'),
      {
        setApplyAllowed: () => undefined,
        applyRuntimeInput: async () => ({
          appliedRuntimeInput: input,
          entityOutbox: [],
          jOutbox: [],
          reliableIngressCommits: [],
          immediateReliableReceipts: [],
        }),
      },
    );
    await expect(apply()).rejects.toThrow('CROSS_J_LOCAL_SIBLING_MISSING');
    addRouteOwner(env, TARGET_USER, targetSigner, TARGET_HUB, liveRoute);
    await expect(apply()).resolves.toMatchObject({ entityOutbox: [], jOutbox: [] });
  });
});

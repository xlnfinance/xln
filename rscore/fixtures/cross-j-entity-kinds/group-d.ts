import { createHash } from 'node:crypto';

import { computeAccountStateRoot, encodeAccountStateValue } from '../../../core/account/commitment/state-root';
import { canonicalAccountTxForFrameHash } from '../../../core/account/consensus/frame/hash';
import { applyEntityTx } from '../../../core/entity/tx/apply';
import { readEntityFrameEvents } from '../../../core/entity/frame-events';
import { computeEntityAccountValueHash } from '../../../core/entity/consensus/state-root';
import { PersistentEntityCollectionMap } from '../../../core/entity/state/persistent-collection-map';
import { createEmptyEnv } from '../../../core/runtime';
import { safeStringify } from '../../../core/protocol/serialization';
import { encodeBinaryPayload } from '../../../core/protocol/serialization/binary-codec';
import {
  buildCrossJurisdictionPullBinding,
  buildCrossJurisdictionPullReveal,
  buildPreparedCrossJurisdictionRoute,
  cloneCrossJurisdictionRoute,
  getCrossJurisdictionPrivateSeed,
  withCanonicalCrossJurisdictionRouteHash,
} from '../../../core/extensions/cross-j';
import { getStaticSwapTokenDimensions } from '../../../core/orderbook/types';
import { appendDefaultProposerCrossJMaterializations } from '../../../core/entity/transition/cross-j-proposer-materialization';
import {
  addr,
  entity,
  getTestAccountForWrite,
  installJurisdictions,
  jref,
  makeJurisdiction,
  makeState,
  putTestAccountPull,
  putTestAccountSwapOffer,
} from '../../../core/__tests__/helpers/cross-j';
import type { EntityCandidateEffect, EntityReplica, EntityState } from '../../../core/entity/types';
import type { EntityTx } from '../../../core/types/entity-tx';
import type { CrossJurisdictionBookAdmission, CrossJurisdictionSwapRoute } from '../../../core/types/cross-jurisdiction';
import type { RuntimeOverlayRecord } from '../../../core/runtime/overlay';

const SEED = 'cross-j-entity-kinds-group-d-v1';
const NOW = 10_000;
const SOURCE_USER = entity('31');
const SOURCE_HUB = entity('41');
const TARGET_HUB = entity('42');
const TARGET_USER = entity('32');
const SOURCE_USER_SIGNER = addr('51');
const SOURCE_HUB_SIGNER = addr('61');
const TARGET_HUB_SIGNER = addr('62');
const TARGET_USER_SIGNER = addr('52');
const SOURCE_J = makeJurisdiction('Group D Source', 1, '11', '12');
const TARGET_J = makeJurisdiction('Group D Target', 8453, '21', '22');

const env = createEmptyEnv(SEED);
env.scenarioMode = true;
env.quietRuntimeLogs = true;
env.state.timestamp = NOW;
installJurisdictions(env, SOURCE_J, TARGET_J);

const digest = (value: unknown): string => `0x${createHash('sha256')
  .update(safeStringify(value))
  .digest('hex')}`;

const accountTxDigest = (tx: Parameters<typeof canonicalAccountTxForFrameHash>[0]): string =>
  `0x${createHash('sha256')
    .update(encodeAccountStateValue(canonicalAccountTxForFrameHash(tx)))
    .digest('hex')}`;

const entityTxDigest = (tx: EntityTx): string => `0x${createHash('sha256')
  .update(encodeBinaryPayload({ type: tx.type, data: tx.data }))
  .digest('hex')}`;

const baseRoute = (): CrossJurisdictionSwapRoute => withCanonicalCrossJurisdictionRouteHash({
  orderId: 'cross-j-group-d-order',
  makerEntityId: SOURCE_USER,
  hubEntityId: SOURCE_HUB,
  bookOwnerEntityId: SOURCE_HUB,
  sourceSignerId: SOURCE_USER_SIGNER,
  sourceHubSignerId: SOURCE_HUB_SIGNER,
  targetHubSignerId: TARGET_HUB_SIGNER,
  targetSignerId: TARGET_USER_SIGNER,
  bookHubSignerId: SOURCE_HUB_SIGNER,
  sourceDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
  targetDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
  source: {
    jurisdiction: jref(SOURCE_J), entityId: SOURCE_USER,
    counterpartyEntityId: SOURCE_HUB, tokenId: 1, amount: 1_000n,
  },
  target: {
    jurisdiction: jref(TARGET_J), entityId: TARGET_HUB,
    counterpartyEntityId: TARGET_USER, tokenId: 1, amount: 900n,
  },
  status: 'intent', createdAt: NOW, updatedAt: NOW, expiresAt: 70_000,
});

const preparedRoute = (): CrossJurisdictionSwapRoute => buildPreparedCrossJurisdictionRoute(
  baseRoute(),
  { runtimeSeed: SEED, now: NOW },
);

const filledRoute = (): CrossJurisdictionSwapRoute => ({
  ...preparedRoute(),
  status: 'partially_filled',
  fillSeq: 1,
  cumulativeFillRatio: 32_768,
  claimedRatio: 32_768,
  fillNumerator: 1n,
  fillDenominator: 2n,
  filledSourceAmount: 500n,
  filledTargetAmount: 450n,
  sourceClaimed: 500n,
  targetClaimed: 450n,
});

const state = (owner: string, signer: string, peer: string, route?: CrossJurisdictionSwapRoute): EntityState => {
  const jurisdiction = owner === TARGET_HUB || owner === TARGET_USER ? TARGET_J : SOURCE_J;
  const value = makeState(owner, signer, jurisdiction, peer);
  value.timestamp = NOW;
  value.profile.isHub = owner === SOURCE_HUB || owner === TARGET_HUB;
  if (route) value.crossJurisdictionSwaps?.set(route.orderId, cloneCrossJurisdictionRoute(route));
  return value;
};

const collection = (values: ReadonlyMap<string, unknown> | undefined) => ({
  entries: [...(values ?? [])],
  root: values && 'rootHash' in values
    ? (values as ReadonlyMap<string, unknown> & { rootHash(): string }).rootHash()
    : null,
});

const projectState = (value: EntityState) => ({
  entityId: value.entityId,
  timestamp: value.timestamp,
  knownAccounts: [...value.accounts.keys()],
  accounts: [...value.accounts.entries()].map(([accountId, account]) => ({
    accountId,
    accountStateRoot: computeAccountStateRoot(account.state),
    entityLeaf: computeEntityAccountValueHash(account),
    status: account.status,
    disputePrepare: account.disputePrepare ?? null,
    activeDispute: account.activeDispute ?? null,
  })),
  crossJurisdictionSwaps: collection(value.crossJurisdictionSwaps),
  crossJurisdictionAuthorizations: collection(value.crossJurisdictionAuthorizations),
  crossJurisdictionBookAdmissions: collection(value.crossJurisdictionBookAdmissions),
});

const runCase = async (name: string, initial: EntityState, tx: EntityTx) => {
  const storageChanges: RuntimeOverlayRecord[] = [];
  const candidateEffects: EntityCandidateEffect[] = [];
  const before = projectState(initial);
  const priorEventCount = readEntityFrameEvents(initial).length;
  const result = await applyEntityTx(env, initial, tx, {
    storageChanges,
    candidateEffects,
  });
  const events = readEntityFrameEvents(result.newState).slice(priorEventCount);
  const effects = {
    storageChanges,
    candidateEffects,
    swapOffersCreated: result.swapOffersCreated ?? [],
  };
  const outbox = {
    outputs: result.outputs.map(output => ({
      entityId: output.entityId,
      signerId: output.signerId,
      entityTxs: (output.entityTxs ?? []).map(entityTx => ({
        tx: entityTx,
        txDigest: entityTxDigest(entityTx),
      })),
    })),
    accountTxs: (result.accountTxs ?? []).map(row => ({
      accountId: row.accountId,
      tx: row.tx,
      txDigest: accountTxDigest(row.tx),
    })),
  };
  return {
    name,
    signerId: initial.config.validators[0],
    authorityJurisdiction: initial.config.jurisdiction,
    before,
    tx,
    after: projectState(result.newState),
    events,
    effects,
    outbox,
    digests: {
      events: digest(events),
      effects: digest(effects),
      outbox: digest(outbox),
    },
  };
};

const admission = (route: CrossJurisdictionSwapRoute): CrossJurisdictionBookAdmission => ({
  orderId: route.orderId,
  routeHash: route.routeHash!,
  sourceEntityId: route.source.entityId,
  bookOwnerEntityId: route.bookOwnerEntityId!,
  status: 'admitted',
  route: cloneCrossJurisdictionRoute(route),
  admittedAt: NOW,
  updatedAt: NOW,
});

const bookState = (route: CrossJurisdictionSwapRoute): EntityState => {
  const value = state(SOURCE_HUB, SOURCE_HUB_SIGNER, SOURCE_USER, route);
  value.crossJurisdictionBookAdmissions = PersistentEntityCollectionMap.from(new Map([
    [`${SOURCE_USER}:${route.orderId}`, admission(route)],
  ]));
  return value;
};

const noticeData = (route: CrossJurisdictionSwapRoute) => ({
  orderId: route.orderId,
  routeHash: route.routeHash!,
  fillSeq: Math.floor(Number(route.fillSeq ?? 0)) + 1,
  cumulativeFillRatio: 65_535,
});

const addPull = (value: EntityState, peer: string, route: CrossJurisdictionSwapRoute, role: 'source' | 'target') => {
  const pull = role === 'source' ? route.sourcePull! : route.targetPull!;
  putTestAccountPull(getTestAccountForWrite(value, peer), pull.pullId, {
    pullId: pull.pullId,
    tokenId: pull.tokenId,
    amount: pull.signedAmount,
    claimedRatio: 0,
    claimedAmount: 0n,
    fullHash: pull.fullHash,
    partialRoot: pull.partialRoot,
    crossJurisdiction: buildCrossJurisdictionPullBinding(route, role),
    createdHeight: 0,
    createdTimestamp: NOW,
  });
};

const addSourceOffer = (value: EntityState, route: CrossJurisdictionSwapRoute) => {
  const account = getTestAccountForWrite(value, SOURCE_USER);
  putTestAccountSwapOffer(account, {
    offerId: route.orderId,
    ...getStaticSwapTokenDimensions(1, 1),
    giveTokenId: 1,
    giveAmount: 1_000n,
    wantTokenId: 1,
    wantAmount: 900n,
    maxFee: 0n,
    minNetReceive: 900n,
    priceTicks: 900n,
    timeInForce: 0,
    makerIsLeft: account.state.leftEntity === SOURCE_USER,
    createdHeight: 0,
    crossJurisdiction: cloneCrossJurisdictionRoute(route),
  });
};

export const executeCrossJEntityKindsGroupD = async () => {
  const route = filledRoute();
  const cases = [];
  cases.push(await runCase(
    'prepareCrossJurisdictionSwap',
    state(SOURCE_USER, SOURCE_USER_SIGNER, SOURCE_HUB),
    { type: 'prepareCrossJurisdictionSwap', data: { route: baseRoute() } },
  ));
  cases.push(await runCase(
    'admitCrossJurisdictionBookOrder',
    state(SOURCE_HUB, SOURCE_HUB_SIGNER, SOURCE_USER),
    { type: 'admitCrossJurisdictionBookOrder', data: { route: { ...preparedRoute(), status: 'resting' }, reason: 'group-d-admit' } },
  ));
  const { routeHash: _routeHash, ...routeWithoutHash } = route;
  const remoteBookRoute = withCanonicalCrossJurisdictionRouteHash({
    ...routeWithoutHash,
    bookOwnerEntityId: TARGET_HUB,
    bookHubSignerId: TARGET_HUB_SIGNER,
  });
  const removingRemote = state(TARGET_HUB, TARGET_HUB_SIGNER, TARGET_USER, remoteBookRoute);
  removingRemote.crossJurisdictionBookAdmissions = PersistentEntityCollectionMap.from(new Map([
    [`${SOURCE_USER}:${remoteBookRoute.orderId}`, admission(remoteBookRoute)],
  ]));
  cases.push(await runCase(
    'removeCrossJurisdictionBookOrder',
    removingRemote,
    { type: 'removeCrossJurisdictionBookOrder', data: {
      orderId: remoteBookRoute.orderId, sourceEntityId: SOURCE_USER, sourceAccountId: SOURCE_USER,
      route: remoteBookRoute, reason: 'group-d-remove',
    } },
  ));
  const removedAt = NOW;
  const removed = state(SOURCE_HUB, SOURCE_HUB_SIGNER, SOURCE_USER, remoteBookRoute);
  removed.crossJurisdictionBookAdmissions = PersistentEntityCollectionMap.from(new Map([
    [`${SOURCE_USER}:${remoteBookRoute.orderId}`, admission(remoteBookRoute)],
  ]));
  addSourceOffer(removed, remoteBookRoute);
  cases.push(await runCase(
    'crossJurisdictionBookOrderRemoved',
    removed,
    { type: 'crossJurisdictionBookOrderRemoved', data: {
      orderId: remoteBookRoute.orderId, sourceEntityId: SOURCE_USER, sourceAccountId: SOURCE_USER,
      route: remoteBookRoute, removedAt, reason: 'group-d-remove',
    } },
  ));
  const notice = state(SOURCE_HUB, SOURCE_HUB_SIGNER, SOURCE_USER, route);
  addPull(notice, SOURCE_USER, route, 'source');
  cases.push(await runCase(
    'crossJurisdictionFillNotice',
    notice,
    { type: 'crossJurisdictionFillNotice', data: noticeData(route) },
  ));

  const clearStart = state(SOURCE_HUB, SOURCE_HUB_SIGNER, SOURCE_USER, route);
  addPull(clearStart, SOURCE_USER, route, 'source');
  const request = await runCase(
    'requestCrossJurisdictionClear',
    clearStart,
    { type: 'requestCrossJurisdictionClear', data: { orderId: route.orderId, cancelRemainder: true } },
  );
  cases.push(request);
  const requestedState = (await applyEntityTx(env, clearStart, request.tx)).newState;
  const [materialize] = appendDefaultProposerCrossJMaterializations(env, {
    entityId: SOURCE_HUB, signerId: SOURCE_HUB_SIGNER, entityEncPubKey: '',
    state: requestedState, mempool: [],
  } as EntityReplica, []);
  if (!materialize || materialize.type !== 'materializeCrossJurisdictionClear') {
    throw new Error('GROUP_D_CLEAR_MATERIALIZATION_MISSING');
  }
  cases.push(await runCase('materializeCrossJurisdictionClear', requestedState, materialize));
  const materialized = await applyEntityTx(env, requestedState, materialize);
  const targetClose = materialized.outputs
    .flatMap(output => output.entityTxs ?? [])
    .find(tx => tx.type === 'crossPullClose');
  if (!targetClose || targetClose.type !== 'crossPullClose') throw new Error('GROUP_D_TARGET_CLOSE_MISSING');
  const targetState = state(TARGET_HUB, TARGET_HUB_SIGNER, TARGET_USER, targetClose.data.route);
  addPull(targetState, TARGET_USER, targetClose.data.route, 'target');
  cases.push(await runCase('crossPullClose', targetState, targetClose));

  const resting = preparedRoute();
  const { routeHash: _restingHash, ...restingWithoutHash } = resting;
  const expiredRoute = withCanonicalCrossJurisdictionRouteHash({
    ...restingWithoutHash,
    status: 'resting',
    expiresAt: NOW - 1,
  });
  const sweepState = state(SOURCE_HUB, SOURCE_HUB_SIGNER, SOURCE_USER, expiredRoute);
  addPull(sweepState, SOURCE_USER, expiredRoute, 'source');
  addSourceOffer(sweepState, expiredRoute);
  cases.push(await runCase(
    'orderbookSweepCrossJurisdiction',
    sweepState,
    { type: 'orderbookSweepCrossJurisdiction', data: { reason: 'group-d-expired' } },
  ));

  const salvageRoute = filledRoute();
  const salvageState = state(TARGET_USER, TARGET_USER_SIGNER, TARGET_HUB, salvageRoute);
  const salvageBinary = buildCrossJurisdictionPullReveal(
    salvageRoute,
    32_768,
    getCrossJurisdictionPrivateSeed(env, salvageRoute),
  ).binary;
  cases.push(await runCase(
    'crossJurisdictionSalvage',
    salvageState,
    { type: 'crossJurisdictionSalvage', data: {
      routeId: salvageRoute.orderId,
      binary: salvageBinary,
      fillRatio: 32_768,
      sourceEntityId: SOURCE_USER,
      sourceCounterpartyEntityId: SOURCE_HUB,
      observedAt: NOW,
    } },
  ));

  const forceRoute = preparedRoute();
  const forceState = state(SOURCE_USER, SOURCE_USER_SIGNER, SOURCE_HUB, forceRoute);
  addPull(forceState, SOURCE_HUB, forceRoute, 'source');
  cases.push(await runCase(
    'crossJurisdictionForceSiblingDispute',
    forceState,
    { type: 'crossJurisdictionForceSiblingDispute', data: {
      routeId: forceRoute.orderId,
      observedCounterpartyEntityId: TARGET_HUB,
      observedAt: NOW,
    } },
  ));

  return {
    version: 1,
    canonicalSource: 'TypeScript applyEntityTx cross-j Group D semantic transitions',
    seed: SEED,
    cases,
  };
};

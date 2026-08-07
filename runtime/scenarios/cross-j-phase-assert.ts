/**
 * Fail-fast phase asserts for cross-j dual-Runtime scenarios / e2e.
 * Reuses orchestrator mesh + orderbook helpers — no parallel credit math.
 */

import type { RuntimeReplica } from '../runtime/types';
import type { CrossJurisdictionSwapRoute } from '../types/cross-jurisdiction';
import {
  getAccountReplica,
  getCreditGrantedByEntity,
  hasCommittedAccountState,
  isAccountWriteLaneIdle,
} from '../orchestrator/mesh-common';
import { hasCrossJurisdictionBookOrder } from '../orderbook/cross-j';
import { getEntityReplicaById } from '../api/server/entity-lookup';
import { assert } from './helpers';

const HUB_CREDIT = (n: number) => BigInt(n) * 10n ** 18n;

export type CrossJAccountPair = Readonly<{
  hubEntityId: string;
  userEntityId: string;
  tokenId: number;
  hubCreditMin: bigint;
  userCreditMin: bigint;
}>;

const ok = (message: string): void => {
  console.log(`[OK] ${message}`);
};

/** PHASE 1 — bilateral open committed and write-lane idle. */
export const assertAccountsOpenPhase = (
  env: RuntimeReplica,
  pairs: readonly CrossJAccountPair[],
  role: string,
): void => {
  for (const pair of pairs) {
    const account =
      getAccountReplica(env, pair.hubEntityId, pair.userEntityId)
      ?? getAccountReplica(env, pair.userEntityId, pair.hubEntityId);
    assert(
      hasCommittedAccountState(account),
      `phase=ACCOUNTS_OPEN role=${role} account missing/inactive ` +
      `hub=${pair.hubEntityId.slice(-8)} user=${pair.userEntityId.slice(-8)}`,
      env,
    );
    assert(
      isAccountWriteLaneIdle(account),
      `phase=ACCOUNTS_OPEN role=${role} account not idle ` +
      `h=${account.currentHeight} pending=${Boolean(account.pendingFrame)} ` +
      `mempool=${account.mempool.length}`,
      env,
    );
  }
  ok(`phase=ACCOUNTS_OPEN role=${role} pairs=${pairs.length}`);
};

/**
 * PHASE 2 — hub→user credit committed (hub is trusted).
 * User open credit may be smaller; do not require symmetric 500k mutual.
 */
export const assertCreditReadyPhase = (
  env: RuntimeReplica,
  pairs: readonly CrossJAccountPair[],
  role: string,
): void => {
  for (const pair of pairs) {
    const account =
      getAccountReplica(env, pair.hubEntityId, pair.userEntityId)
      ?? getAccountReplica(env, pair.userEntityId, pair.hubEntityId);
    assert(
      isAccountWriteLaneIdle(account),
      `phase=CREDIT_READY role=${role} account not idle ` +
      `hub=${pair.hubEntityId.slice(-8)} user=${pair.userEntityId.slice(-8)}`,
      env,
    );
    // getCreditGrantedByEntity → deriveDelta(...).peerCreditLimit only.
    const fromHub = getCreditGrantedByEntity(account, pair.hubEntityId, pair.tokenId);
    const fromUser = getCreditGrantedByEntity(account, pair.userEntityId, pair.tokenId);
    assert(
      fromHub >= pair.hubCreditMin,
      `phase=CREDIT_READY role=${role} hub credit too low ` +
      `have=${fromHub} need=${pair.hubCreditMin} token=${pair.tokenId}`,
      env,
    );
    assert(
      fromUser >= pair.userCreditMin,
      `phase=CREDIT_READY role=${role} user credit too low ` +
      `have=${fromUser} need=${pair.userCreditMin} token=${pair.tokenId}`,
      env,
    );
  }
  ok(`phase=CREDIT_READY role=${role} pairs=${pairs.length}`);
};

/** Default hub/user credit floors used by the dual-Runtime scenario. */
export const defaultCrossJCreditPairs = (
  hubSrcId: string,
  mmId: string,
  hubTgtId: string,
  mmtId: string,
  usdc = 1,
  weth = 2,
): CrossJAccountPair[] => [
  {
    hubEntityId: hubSrcId,
    userEntityId: mmId,
    tokenId: usdc,
    hubCreditMin: HUB_CREDIT(500_000),
    userCreditMin: HUB_CREDIT(100_000),
  },
  {
    hubEntityId: hubTgtId,
    userEntityId: mmtId,
    tokenId: weth,
    hubCreditMin: HUB_CREDIT(500_000),
    userCreditMin: HUB_CREDIT(100_000),
  },
];

/**
 * PHASE 3b — after materialize: Entity route resting + Account offer/pulls +
 * cross-j book row on the book owner. Same-j surface = committed swapOffers.
 */
export const assertCrossJOrderbooksReady = (
  env: RuntimeReplica,
  orderId: string,
  sourceHubEntityId: string,
  targetHubEntityId: string,
): CrossJurisdictionSwapRoute => {
  const sourceHub = getEntityReplicaById(env, sourceHubEntityId);
  const targetHub = getEntityReplicaById(env, targetHubEntityId);
  assert(Boolean(sourceHub), `phase=ORDERBOOK source hub missing ${sourceHubEntityId.slice(-8)}`, env);
  assert(Boolean(targetHub), `phase=ORDERBOOK target hub missing ${targetHubEntityId.slice(-8)}`, env);

  const sourceRoute = sourceHub!.state.crossJurisdictionSwaps?.get(orderId);
  const targetRoute = targetHub!.state.crossJurisdictionSwaps?.get(orderId);
  assert(Boolean(sourceRoute), `phase=ORDERBOOK source route missing orderId=${orderId}`, env);
  assert(Boolean(targetRoute), `phase=ORDERBOOK target route missing orderId=${orderId}`, env);
  assert(
    sourceRoute!.status === 'resting',
    `phase=ORDERBOOK source status=${sourceRoute!.status} want=resting`,
    env,
  );
  assert(
    targetRoute!.status === 'resting',
    `phase=ORDERBOOK target status=${targetRoute!.status} want=resting`,
    env,
  );
  assert(Boolean(sourceRoute!.sourcePull), `phase=ORDERBOOK sourcePull missing`, env);
  assert(Boolean(sourceRoute!.targetPull), `phase=ORDERBOOK targetPull missing`, env);

  const sourceUser = String(sourceRoute!.source.entityId);
  const targetUser = String(sourceRoute!.target.counterpartyEntityId);
  const sourceAccount = getAccountReplica(env, sourceHubEntityId, sourceUser);
  const targetAccount = getAccountReplica(env, targetHubEntityId, targetUser);
  assert(Boolean(sourceAccount), `phase=ORDERBOOK source account missing`, env);
  assert(Boolean(targetAccount), `phase=ORDERBOOK target account missing`, env);

  // Same-j bilateral surface: committed swap offer on source hub↔MM.
  const offer = sourceAccount!.state.swapOffers?.get(orderId);
  assert(
    Boolean(offer?.crossJurisdiction),
    `phase=ORDERBOOK same-j offer missing on source account orderId=${orderId}`,
    env,
  );
  assert(
    Boolean(sourceAccount!.state.pulls?.has(sourceRoute!.sourcePull!.pullId)),
    `phase=ORDERBOOK source pull not committed pullId=${sourceRoute!.sourcePull!.pullId.slice(-8)}`,
    env,
  );
  assert(
    Boolean(targetAccount!.state.pulls?.has(sourceRoute!.targetPull!.pullId)),
    `phase=ORDERBOOK target pull not committed pullId=${sourceRoute!.targetPull!.pullId.slice(-8)}`,
    env,
  );

  // Cross-j book row on the book owner (usually source hub / book hub).
  const bookOwnerId = String(
    sourceRoute!.bookOwnerEntityId || sourceRoute!.hubEntityId || sourceHubEntityId,
  ).toLowerCase();
  const bookOwner = getEntityReplicaById(env, bookOwnerId);
  assert(Boolean(bookOwner), `phase=ORDERBOOK book owner missing ${bookOwnerId.slice(-8)}`, env);
  assert(
    hasCrossJurisdictionBookOrder(bookOwner!.state, sourceRoute!),
    `phase=ORDERBOOK cross-j book row missing owner=${bookOwnerId.slice(-8)} orderId=${orderId}`,
    env,
  );

  ok(
    `phase=ORDERBOOK orderId=${orderId} status=resting ` +
    `sameJOffer=1 sourcePull=1 targetPull=1 crossJBook=1`,
  );
  return sourceRoute!;
};

export const assertCrossJSettled = (
  env: RuntimeReplica,
  orderId: string,
  sourceHubEntityId: string,
): void => {
  const hub = getEntityReplicaById(env, sourceHubEntityId);
  const status = hub?.state.crossJurisdictionSwaps?.get(orderId)?.status;
  assert(
    status === 'settled' || status === 'cancelled',
    `phase=SETTLED status=${status ?? 'ABSENT'} orderId=${orderId}`,
    env,
  );
  ok(`phase=SETTLED orderId=${orderId} status=${status}`);
};

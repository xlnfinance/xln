import {
  buildCrossJurisdictionCloseProof,
  buildCrossJurisdictionPullReveal,
  buildPreparedCrossJurisdictionRoute,
  getCrossJurisdictionCommittedFillAmounts,
  getCrossJurisdictionPrivateSeed,
} from '../extensions/cross-j/index';
import { committedCrossJSourceDisputeDelayMs } from '../extensions/cross-j/prepared-route';
import type { EntityReplica, EntityTx, Env } from '../types';
import { findAccountKey, normalizeEntityRef } from './tx/account-key';
import { accountHasPullResolveQueued } from './tx/cross-jurisdiction-helpers';

const normalized = (value: unknown): string => String(value ?? '').trim().toLowerCase();

const nestedTxs = (tx: EntityTx): readonly EntityTx[] =>
  tx.type === 'entityCommand' ? tx.data.txs : [tx];

const pendingOrderIds = (replica: EntityReplica, txs: readonly EntityTx[]): Set<string> => {
  const ids = new Set<string>();
  for (const tx of [...replica.mempool, ...txs]) {
    for (const nested of nestedTxs(tx)) {
      if (nested.type === 'materializeCrossJurisdictionSwap') ids.add(`setup:${nested.data.route.orderId}`);
      if (nested.type === 'materializeCrossJurisdictionClear') ids.add(`clear:${nested.data.orderId}`);
    }
  }
  return ids;
};

/**
 * Raw source-user intent is already durable before this runs. The source-hub
 * default proposer owns the private ladder seed and publishes only public
 * commitments in an ordinary signed command. Validators replay those exact
 * bytes and never read validator-local seeds.
 */
export const appendDefaultProposerCrossJMaterializations = (
  env: Env,
  replica: EntityReplica,
  txs: readonly EntityTx[],
): EntityTx[] => {
  const defaultProposer = normalized(replica.state.config.validators[0]);
  if (!defaultProposer || normalized(replica.signerId) !== defaultProposer) return [...txs];

  const pending = pendingOrderIds(replica, txs);
  const additions: EntityTx[] = [];
  const routes = [...(replica.state.crossJurisdictionSwaps?.values() ?? [])]
    .sort((left, right) => left.orderId.localeCompare(right.orderId));
  for (const route of routes) {
    if (
      route.status !== 'intent' ||
      route.sourcePull ||
      route.targetPull ||
      pending.has(`setup:${route.orderId}`) ||
      normalized(route.source.counterpartyEntityId) !== normalized(replica.entityId)
    ) continue;
    const preparedRoute = buildPreparedCrossJurisdictionRoute(route, {
      runtimeSeed: env.runtimeSeed,
      sourceDisputeDelayMs: committedCrossJSourceDisputeDelayMs(replica.state, route),
      now: env.timestamp,
    });
    additions.push({
      type: 'materializeCrossJurisdictionSwap',
      data: { proposerSignerId: replica.signerId, route: preparedRoute },
    });
    pending.add(`setup:${route.orderId}`);
  }

  for (const route of routes) {
    if (
      route.status !== 'clear_requested' ||
      !route.sourcePull ||
      !route.targetPull ||
      pending.has(`clear:${route.orderId}`) ||
      normalizeEntityRef(route.source.counterpartyEntityId) !== normalizeEntityRef(replica.entityId)
    ) continue;
    const { fillRatio } = getCrossJurisdictionCommittedFillAmounts(route);
    if (fillRatio <= 0) continue;
    const accountId = findAccountKey(replica.state, route.source.entityId);
    const account = accountId ? replica.state.accounts.get(accountId) : undefined;
    if (
      !account ||
      account.swapOffers?.has(route.orderId) ||
      !account.pulls?.has(route.sourcePull.pullId) ||
      accountHasPullResolveQueued(account, route.sourcePull.pullId)
    ) continue;
    const reveal = buildCrossJurisdictionPullReveal(
      route,
      fillRatio,
      getCrossJurisdictionPrivateSeed(env, route),
    );
    additions.push({
      type: 'materializeCrossJurisdictionClear',
      data: {
        proposerSignerId: replica.signerId,
        orderId: route.orderId,
        binary: reveal.binary,
        proof: buildCrossJurisdictionCloseProof(route, reveal.binary),
      },
    });
    pending.add(`clear:${route.orderId}`);
  }
  return additions.length > 0 ? [...txs, ...additions] : [...txs];
};

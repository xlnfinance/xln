import {
  buildCrossJurisdictionCloseProof,
  buildCrossJurisdictionPullReveal,
  buildPreparedCrossJurisdictionRoute,
  getCrossJurisdictionCommittedFillAmounts,
  getCrossJurisdictionPrivateSeed,
} from '../extensions/cross-j/index';
import { committedCrossJSourceDisputeDelayMs } from '../extensions/cross-j/prepared-route';
import { MAX_ACCOUNT_FRAME_TXS } from '../account/consensus/frame';
import type {
  AccountMachine,
  AccountTx,
  CrossJurisdictionSwapRoute,
  EntityReplica,
  EntityState,
  EntityTx,
  Env,
} from '../types';
import { findAccountKey, normalizeEntityRef } from './tx/account-key';
import { accountHasPullResolveQueued } from './tx/cross-jurisdiction-helpers';

const normalized = (value: unknown): string => String(value ?? '').trim().toLowerCase();

const nestedTxs = (tx: EntityTx): readonly EntityTx[] =>
  tx.type === 'entityCommand'
    ? tx.data.txs
    : tx.type === 'runtimeOutput' && tx.data.protocol === 'cross-j'
      ? tx.data.entityTxs
      : [tx];

const pendingOrderIds = (replica: EntityReplica, txs: readonly EntityTx[]): Set<string> => {
  const ids = new Set<string>();
  for (const tx of [...replica.mempool, ...txs]) {
    for (const nested of nestedTxs(tx)) {
      if (nested.type === 'materializeCrossJurisdictionSwap') ids.add(`setup:${nested.data.route.orderId}`);
      if (nested.type === 'registerCrossJurisdictionSwap') ids.add(`setup:${nested.data.route.orderId}`);
      if (nested.type === 'materializeCrossJurisdictionClear') ids.add(`clear:${nested.data.orderId}`);
    }
  }
  return ids;
};

export const entityTxContainsAccountTransition = (tx: EntityTx): boolean =>
  nestedTxs(tx).some(
    nested =>
      nested.type === 'accountInput' ||
      (nested.type === 'consensusOutput' && nested.data.entityTxs.some(outputTx => outputTx.type === 'accountInput')),
  );

export const entityTxContainsCrossJMaterialization = (tx: EntityTx): boolean =>
  nestedTxs(tx).some(
    nested => nested.type === 'materializeCrossJurisdictionSwap' || nested.type === 'materializeCrossJurisdictionClear',
  );

export const entityTxContainsCrossJRegistration = (tx: EntityTx): boolean =>
  nestedTxs(tx).some(nested => nested.type === 'registerCrossJurisdictionSwap');

export const entityTxContainsCrossJSetup = (tx: EntityTx): boolean =>
  entityTxContainsCrossJMaterialization(tx) || entityTxContainsCrossJRegistration(tx);

export type CrossJCommitPhaseSelection = Readonly<{
  txs: EntityTx[];
  deferredCrossJSetup: boolean;
}>;

/**
 * Account ACKs free both sibling Accounts for their next proposal. A queued
 * cross-j setup in that same Entity frame can enqueue a fresh route after only
 * one sibling has been freed, producing an unmatched Account leg.
 *
 * Defer the materialization command and every later command by the same author
 * so signed command nonces remain a contiguous prefix. Other authors and
 * protocol inputs remain independently proposable.
 */
export const selectCrossJCommitPhaseTxs = (txs: readonly EntityTx[]): CrossJCommitPhaseSelection => {
  if (!txs.some(entityTxContainsAccountTransition) || !txs.some(entityTxContainsCrossJSetup)) {
    return { txs: [...txs], deferredCrossJSetup: false };
  }

  const deferredAuthors = new Set<string>();
  const selected: EntityTx[] = [];
  for (const tx of txs) {
    if (tx.type === 'entityCommand') {
      const author = `${tx.data.boardHash}:${tx.data.boardEpoch}:${tx.data.authorSignerId}`.toLowerCase();
      if (deferredAuthors.has(author) || entityTxContainsCrossJSetup(tx)) {
        deferredAuthors.add(author);
        continue;
      }
    } else if (entityTxContainsCrossJSetup(tx)) {
      continue;
    }
    selected.push(tx);
  }
  return { txs: selected, deferredCrossJSetup: true };
};

type CrossJOpeningLeg = Readonly<{
  orderId: string;
  route: CrossJurisdictionSwapRoute;
}>;

const crossJOpeningLegs = (txs: readonly AccountTx[]): CrossJOpeningLeg[] => {
  const byOrderId = new Map<string, CrossJOpeningLeg>();
  for (const tx of txs) {
    if (tx.type !== 'pull_lock' || !tx.data.crossJurisdiction || !tx.data.crossJurisdictionRoute) continue;
    const orderId = normalized(tx.data.crossJurisdiction.orderId);
    if (!orderId) throw new Error('CROSS_J_OPENING_ORDER_ID_REQUIRED');
    byOrderId.set(orderId, { orderId, route: tx.data.crossJurisdictionRoute });
  }
  return [...byOrderId.values()].sort((left, right) => left.orderId.localeCompare(right.orderId));
};

type CrossJSiblingAccount = Readonly<{
  entityId: string;
  signerId: string;
  accountId: string;
}>;

const pairedCrossJSiblingAccount = (localEntityId: string, route: CrossJurisdictionSwapRoute): CrossJSiblingAccount => {
  const local = normalized(localEntityId);
  if (local === normalized(route.source.entityId)) {
    return {
      entityId: normalized(route.target.counterpartyEntityId),
      signerId: normalized(route.targetSignerId),
      accountId: normalized(route.target.entityId),
    };
  }
  if (local === normalized(route.source.counterpartyEntityId)) {
    return {
      entityId: normalized(route.target.entityId),
      signerId: normalized(route.targetHubSignerId),
      accountId: normalized(route.target.counterpartyEntityId),
    };
  }
  if (local === normalized(route.target.entityId)) {
    return {
      entityId: normalized(route.source.counterpartyEntityId),
      signerId: normalized(route.sourceHubSignerId),
      accountId: normalized(route.source.entityId),
    };
  }
  if (local === normalized(route.target.counterpartyEntityId)) {
    return {
      entityId: normalized(route.source.entityId),
      signerId: normalized(route.sourceSignerId),
      accountId: normalized(route.source.counterpartyEntityId),
    };
  }
  throw new Error(`CROSS_J_OPENING_LOCAL_ROLE_INVALID:${route.orderId}:${local}`);
};

const siblingKey = (sibling: CrossJSiblingAccount): string =>
  `${sibling.entityId}:${sibling.signerId}:${sibling.accountId}`;

const crossJOpeningOrderId = (tx: AccountTx): string | undefined => {
  if (tx.type === 'pull_lock' && tx.data.crossJurisdiction) {
    const orderId = normalized(tx.data.crossJurisdiction.orderId);
    if (!orderId) throw new Error('CROSS_J_OPENING_ORDER_ID_REQUIRED');
    return orderId;
  }
  if (tx.type === 'swap_offer' && tx.data.crossJurisdiction) {
    const orderId = normalized(tx.data.crossJurisdiction.orderId);
    if (!orderId) throw new Error('CROSS_J_OPENING_ORDER_ID_REQUIRED');
    return orderId;
  }
  return undefined;
};

const selectOpeningTxs = (txs: readonly AccountTx[], orderIds: ReadonlySet<string>): AccountTx[] =>
  txs.filter(tx => {
    const orderId = crossJOpeningOrderId(tx);
    return orderId !== undefined && orderIds.has(orderId);
  });

const reciprocalOpeningOrderIds = (
  txs: readonly AccountTx[],
  siblingEntityId: string,
  localEntityId: string,
  localAccountCounterparty: string,
): Set<string> =>
  new Set(
    crossJOpeningLegs(txs)
      .filter(leg => {
        const reciprocal = pairedCrossJSiblingAccount(siblingEntityId, leg.route);
        return (
          normalized(reciprocal.entityId) === normalized(localEntityId) &&
          normalized(reciprocal.accountId) === localAccountCounterparty
        );
      })
      .map(leg => leg.orderId),
  );

type CrossJOpeningGroup = Readonly<{
  sibling: CrossJSiblingAccount;
  orderIds: Set<string>;
}>;

const fitOpeningCohort = (
  localTxs: readonly AccountTx[],
  siblingTxs: readonly AccountTx[],
  candidateOrderIds: readonly string[],
): Set<string> => {
  const selected = new Set<string>();
  let localCount = 0;
  let siblingCount = 0;
  for (const orderId of candidateOrderIds) {
    const oneOrder = new Set([orderId]);
    const nextLocalCount = selectOpeningTxs(localTxs, oneOrder).length;
    const nextSiblingCount = selectOpeningTxs(siblingTxs, oneOrder).length;
    if (nextLocalCount === 0 || nextSiblingCount === 0) continue;
    if (localCount + nextLocalCount > MAX_ACCOUNT_FRAME_TXS || siblingCount + nextSiblingCount > MAX_ACCOUNT_FRAME_TXS)
      break;
    selected.add(orderId);
    localCount += nextLocalCount;
    siblingCount += nextSiblingCount;
  }
  return selected;
};

/**
 * Select one exact two-account opening cohort. The sibling Entities share one
 * Runtime, but their Account schedulers can run in adjacent Runtime frames.
 * Once either side freezes a cohort in a pending frame, the other side must
 * select precisely those order IDs and leave later arrivals queued. Without
 * this partition, a new route appended between the two proposals permanently
 * prevents equality even though the already-signed pair is complete.
 *
 * `undefined` means this is an ordinary Account proposal. `null` means a
 * cross-j opening exists but its reciprocal leg is not available yet.
 */
export const selectCrossJOpeningAccountProposalTxs = (
  env: Env,
  state: EntityState,
  account: AccountMachine,
): AccountTx[] | null | undefined => {
  const localLegs = crossJOpeningLegs(account.mempool);
  if (localLegs.length === 0) return undefined;
  const localAccountCounterparty =
    normalized(account.proofHeader.fromEntity) === normalized(state.entityId)
      ? normalized(account.proofHeader.toEntity)
      : normalized(account.proofHeader.fromEntity);

  const localGroups = new Map<string, CrossJOpeningGroup>();
  for (const leg of localLegs) {
    const sibling = pairedCrossJSiblingAccount(state.entityId, leg.route);
    if (!sibling.entityId || !sibling.signerId || !sibling.accountId) {
      throw new Error(`CROSS_J_OPENING_SIBLING_BINDING_REQUIRED:${leg.orderId}`);
    }
    const key = siblingKey(sibling);
    const group = localGroups.get(key) ?? { sibling, orderIds: new Set<string>() };
    group.orderIds.add(leg.orderId);
    localGroups.set(key, group);
  }

  for (const [, { sibling, orderIds }] of [...localGroups.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const replica = [...env.eReplicas.values()].find(
      candidate =>
        normalized(candidate.entityId) === sibling.entityId && normalized(candidate.signerId) === sibling.signerId,
    );
    if (!replica) throw new Error(`CROSS_J_OPENING_SIBLING_REPLICA_MISSING:${siblingKey(sibling)}`);
    const siblingAccountKey = findAccountKey(replica.state, sibling.accountId);
    const siblingAccount = siblingAccountKey ? replica.state.accounts.get(siblingAccountKey) : undefined;
    if (!siblingAccount) throw new Error(`CROSS_J_OPENING_SIBLING_ACCOUNT_MISSING:${siblingKey(sibling)}`);
    const siblingTxs = siblingAccount.pendingFrame?.accountTxs ?? siblingAccount.mempool;
    const reciprocalOrderIds = reciprocalOpeningOrderIds(
      siblingTxs,
      replica.state.entityId,
      state.entityId,
      localAccountCounterparty,
    );
    if (reciprocalOrderIds.size === 0) continue;

    const commonOrderIds = [...orderIds]
      .filter(orderId => reciprocalOrderIds.has(orderId))
      .sort((left, right) => left.localeCompare(right));
    if (commonOrderIds.length === 0) continue;

    if (siblingAccount.pendingFrame) {
      if (reciprocalOrderIds.size !== commonOrderIds.length) continue;
      const selectedOrderIds = new Set(commonOrderIds);
      const selected = selectOpeningTxs(account.mempool, selectedOrderIds);
      if (selected.length > MAX_ACCOUNT_FRAME_TXS) {
        throw new Error(`CROSS_J_OPENING_RECIPROCAL_COHORT_TOO_LARGE:${selected.length}`);
      }
      return selected;
    }

    const selectedOrderIds = fitOpeningCohort(account.mempool, siblingAccount.mempool, commonOrderIds);
    if (selectedOrderIds.size > 0) return selectOpeningTxs(account.mempool, selectedOrderIds);
  }
  return null;
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

  // Registration and Account ACK/frame application are commit phases of an
  // already-materialized envelope. Pulling a new local intent into either
  // phase can free one sibling Account first and append that route to only one
  // proposal. The peer then correctly rejects the unmatched money leg and both
  // accounts remain pending forever. Keep every commit phase separate from
  // preparation; the next ordinary wake/input materializes both legs together.
  const isCommitPhase = txs.some(tx =>
    entityTxContainsAccountTransition(tx) ||
    nestedTxs(tx).some(nested => nested.type === 'registerCrossJurisdictionSwap')
  );
  if (isCommitPhase) return [...txs];

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

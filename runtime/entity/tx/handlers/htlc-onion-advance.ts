import { deriveDelta, isLeft } from '../../../account/utils';
import { HTLC } from '../../../constants';
import { createStructuredLogger } from '../../../infra/logger';
import {
  validateHtlcOnionAdvanceTx,
  type HtlcOnionAdvanceTx,
} from '../../../protocol/htlc/onion-advance';
import { calculateDirectionalFeePPM, calculateHopFee, sanitizeBaseFee, sanitizeFeePPM } from '../../../routing/fees';
import { addMessage, cloneEntityState } from '../../../state-helpers';
import type {
  AccountTx,
  EntityCandidateEffect,
  EntityInput,
  EntityState,
  Env,
  HtlcRoute,
} from '../../../types';
import { setHtlcRouteNote, terminateHtlcRoute } from '../htlc-route-lifecycle';
import { applyHtlcSecretFollowups } from './account/committed-htlc-followups';

const log = createStructuredLogger('entity.htlc_onion_advance');

type Result = {
  newState: EntityState;
  outputs: EntityInput[];
  mempoolOps: Array<{ accountId: string; tx: AccountTx }>;
};

const queuedResolve = (state: EntityState, accountId: string, lockId: string): boolean => {
  const account = state.accounts.get(accountId);
  return Boolean(
    account?.mempool.some((tx) => tx.type === 'htlc_resolve' && tx.data.lockId === lockId)
    || account?.pendingFrame?.accountTxs.some((tx) => tx.type === 'htlc_resolve' && tx.data.lockId === lockId),
  );
};

const cancelInbound = (
  state: EntityState,
  accountId: string,
  lockId: string,
  hashlock: string,
  reason: string,
  mempoolOps: Result['mempoolOps'],
): void => {
  if (!queuedResolve(state, accountId, lockId)) {
    mempoolOps.push({
      accountId,
      tx: { type: 'htlc_resolve', data: { lockId, outcome: 'error', reason } },
    });
  }
  terminateHtlcRoute(state, hashlock, state.timestamp);
};

const applyFinalAdvance = (
  _env: Env,
  state: EntityState,
  tx: HtlcOnionAdvanceTx,
  mempoolOps: Result['mempoolOps'],
): void => {
  if (tx.data.advance.kind !== 'final') throw new Error('HTLC_ONION_ADVANCE_FINAL_DISPATCH_MISMATCH');
  const { inboundEntityId, inboundLockId, hashlock, tokenId, amount } = tx.data;
  const existingRoute = state.htlcRoutes.get(hashlock);
  if (!existingRoute) {
    state.htlcRoutes.set(hashlock, {
      hashlock,
      tokenId,
      amount,
      ...(tx.data.advance.startedAtMs !== undefined ? { startedAtMs: tx.data.advance.startedAtMs } : {}),
      inboundEntity: inboundEntityId,
      inboundLockId,
      createdTimestamp: state.timestamp,
    });
  } else {
    existingRoute.inboundEntity ??= inboundEntityId;
    existingRoute.inboundLockId ??= inboundLockId;
    if (existingRoute.startedAtMs === undefined && tx.data.advance.startedAtMs !== undefined) {
      existingRoute.startedAtMs = tx.data.advance.startedAtMs;
    }
  }
  const description = tx.data.advance.description?.trim() ?? '';
  if (description) setHtlcRouteNote(state, hashlock, inboundLockId, description);
  if (!queuedResolve(state, inboundEntityId, inboundLockId)) {
    mempoolOps.push({
      accountId: inboundEntityId,
      tx: {
        type: 'htlc_resolve',
        data: { lockId: inboundLockId, outcome: 'offer', offer: tx.data.advance.secretOffer },
      },
    });
  }
};

const applyAcceptOfferAdvance = (
  state: EntityState,
  tx: HtlcOnionAdvanceTx,
  mempoolOps: Result['mempoolOps'],
): void => {
  if (tx.data.advance.kind !== 'acceptOffer') {
    throw new Error('HTLC_ONION_ADVANCE_ACCEPT_DISPATCH_MISMATCH');
  }
  if (!queuedResolve(state, tx.data.inboundEntityId, tx.data.inboundLockId)) {
    mempoolOps.push({
      accountId: tx.data.inboundEntityId,
      tx: {
        type: 'htlc_resolve',
        data: {
          lockId: tx.data.inboundLockId,
          outcome: 'secret',
          offerHash: tx.data.advance.offerHash,
        },
      },
    });
  }
};

const nextHopCapacity = (state: EntityState, nextHop: string, tokenId: number) => {
  const account = state.accounts.get(nextHop);
  const delta = account?.deltas.get(tokenId);
  if (!delta) return { outCapacity: 0n, inCapacity: 0n };
  return deriveDelta(delta, isLeft(state.entityId, nextHop));
};

const applyForwardAdvance = (
  state: EntityState,
  tx: HtlcOnionAdvanceTx,
  mempoolOps: Result['mempoolOps'],
): void => {
  if (tx.data.advance.kind !== 'forward') throw new Error('HTLC_ONION_ADVANCE_FORWARD_DISPATCH_MISMATCH');
  const { inboundEntityId, inboundLockId, hashlock, tokenId, amount, timelock, revealBeforeHeight } = tx.data;
  const { nextHop, forwardAmount, innerEnvelope } = tx.data.advance;
  const existing = state.htlcRoutes.get(hashlock);
  if (existing?.inboundLockId === inboundLockId && existing.outboundLockId === `${inboundLockId}-fwd`) return;

  const route: HtlcRoute = {
    hashlock,
    tokenId,
    amount,
    inboundEntity: inboundEntityId,
    inboundLockId,
    outboundEntity: nextHop,
    outboundLockId: `${inboundLockId}-fwd`,
    createdTimestamp: state.timestamp,
  };
  state.htlcRoutes.set(hashlock, route);
  if (!state.accounts.has(nextHop)) {
    cancelInbound(state, inboundEntityId, inboundLockId, hashlock, `no_account:${nextHop.slice(-4)}`, mempoolOps);
    return;
  }

  const feeAmount = amount - forwardAmount;
  const capacities = nextHopCapacity(state, nextHop, tokenId);
  const config = state.hubRebalanceConfig;
  const baseFee = sanitizeBaseFee(config?.baseFee ?? 0n);
  const basePpm = sanitizeFeePPM(config?.routingFeePPM ?? 1, 1);
  const feePpm = calculateDirectionalFeePPM(basePpm, capacities.outCapacity, capacities.inCapacity);
  const requiredFee = calculateHopFee(amount, feePpm, baseFee);
  if (feeAmount < requiredFee) {
    cancelInbound(
      state,
      inboundEntityId,
      inboundLockId,
      hashlock,
      feeAmount < baseFee ? 'fee_below_base' : 'fee_below_ppm',
      mempoolOps,
    );
    return;
  }
  route.pendingFee = feeAmount;

  const forwardTimelock = timelock - BigInt(HTLC.MIN_TIMELOCK_DELTA_MS);
  const forwardHeight = revealBeforeHeight - HTLC.MIN_REVEAL_HEIGHT_DELTA_BLOCKS;
  if (forwardTimelock < BigInt(state.timestamp) + 1000n) {
    cancelInbound(state, inboundEntityId, inboundLockId, hashlock, 'timelock_too_tight', mempoolOps);
    return;
  }
  if (forwardHeight <= (state.lastFinalizedJHeight || 0)) {
    cancelInbound(state, inboundEntityId, inboundLockId, hashlock, 'height_expired', mempoolOps);
    return;
  }

  mempoolOps.push({
    accountId: nextHop,
    tx: {
      type: 'htlc_lock',
      data: {
        lockId: `${inboundLockId}-fwd`,
        hashlock,
        timelock: forwardTimelock,
        revealBeforeHeight: forwardHeight,
        amount: forwardAmount,
        tokenId,
        envelope: innerEnvelope,
      },
    },
  });
};

export const handleHtlcOnionAdvance = async (
  env: Env,
  entityState: EntityState,
  rawTx: HtlcOnionAdvanceTx,
  candidateEffects: EntityCandidateEffect[] = [],
): Promise<Result> => {
  const validated = await validateHtlcOnionAdvanceTx(env, entityState, rawTx);
  const tx = validated.tx;
  const newState = cloneEntityState(entityState);
  const mempoolOps: Result['mempoolOps'] = [];
  const outputs: EntityInput[] = [];
  if (tx.data.advance.kind === 'final') applyFinalAdvance(env, newState, tx, mempoolOps);
  else if (tx.data.advance.kind === 'acceptOffer') applyAcceptOfferAdvance(newState, tx, mempoolOps);
  else if (tx.data.advance.kind === 'revealAccepted') {
    applyHtlcSecretFollowups(
      { env, state: entityState, newState, outputs, mempoolOps, candidateEffects },
      [{ secret: tx.data.advance.secret, hashlock: tx.data.hashlock }],
    );
  } else applyForwardAdvance(newState, tx, mempoolOps);
  addMessage(newState, `🔐 HTLC onion advanced ${tx.data.inboundLockId}`);
  log.debug('applied', {
    entityId: newState.entityId,
    lockId: tx.data.inboundLockId,
    kind: tx.data.advance.kind,
  });
  return { newState, outputs, mempoolOps };
};

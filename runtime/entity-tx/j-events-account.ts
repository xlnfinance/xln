import type { AccountMachine, JurisdictionEvent } from '../types';
import { getDefaultCreditLimit } from '../account-utils';
import { canonicalJurisdictionEventKey, normalizeJurisdictionEvents } from '../j-event-normalization';
import { createStructuredLogger, shortHash } from '../logger';
import type { JEventClaimTx, JEventMempoolOp } from './j-events-types';

const accountJEventLog = createStructuredLogger('j.event.account');

type AccountJObservation = AccountMachine['leftJObservations'][number];

const isJEventClaimOp = (op: JEventMempoolOp): op is { accountId: string; tx: JEventClaimTx } =>
  op.tx.type === 'j_event_claim';

const normalizeObsEvents = (obs: AccountJObservation): JurisdictionEvent[] => {
  const raw = obs?.events;
  if (!Array.isArray(raw)) return [];
  return normalizeJurisdictionEvents(raw);
};

const sameEventMultiset = (a: JurisdictionEvent[], b: JurisdictionEvent[]): boolean => {
  if (a.length !== b.length) return false;
  const counts = new Map<string, number>();
  for (const event of a) {
    const key = canonicalJurisdictionEventKey(event);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const event of b) {
    const key = canonicalJurisdictionEventKey(event);
    const current = counts.get(key) || 0;
    if (current <= 0) return false;
    counts.set(key, current - 1);
  }
  return Array.from(counts.values()).every((remaining) => remaining === 0);
};

function applyAccountSettledEvent(account: AccountMachine, event: JurisdictionEvent): void {
  if (event.type !== 'AccountSettled') return;
  const { tokenId, collateral, ondelta } = event.data;
  const tokenIdNum = Number(tokenId);

  let delta = account.deltas.get(tokenIdNum);
  if (!delta) {
    const defaultCreditLimit = getDefaultCreditLimit(tokenIdNum);
    delta = {
      tokenId: tokenIdNum,
      collateral: 0n,
      ondelta: 0n,
      offdelta: 0n,
      leftCreditLimit: defaultCreditLimit,
      rightCreditLimit: defaultCreditLimit,
      leftAllowance: 0n,
      rightAllowance: 0n,
    };
    account.deltas.set(tokenIdNum, delta);
  }

  const oldColl = delta.collateral;
  delta.collateral = BigInt(collateral);
  delta.ondelta = BigInt(ondelta);

  const pendingRequest = account.requestedRebalance?.get(tokenIdNum) ?? 0n;
  if (pendingRequest > 0n) {
    const collateralIncrease = delta.collateral > oldColl ? delta.collateral - oldColl : 0n;
    if (collateralIncrease > 0n) {
      const fulfilledAmount = pendingRequest > collateralIncrease ? collateralIncrease : pendingRequest;
      const remaining = pendingRequest - fulfilledAmount;
      if (remaining > 0n) {
        account.requestedRebalance.set(tokenIdNum, remaining);
        const feeState = account.requestedRebalanceFeeState?.get(tokenIdNum);
        if (feeState) feeState.jBatchSubmittedAt = 0;
      } else {
        account.requestedRebalance.delete(tokenIdNum);
        account.requestedRebalanceFeeState?.delete(tokenIdNum);
      }
    }
  }

  const eventNonce = event.data.nonce;
  if (eventNonce != null) {
    const eventNonceNum = Number(eventNonce);
    const prev = account.onChainSettlementNonce ?? 0;
    if (eventNonceNum > prev) account.onChainSettlementNonce = eventNonceNum;
  }
}

function activatePostSettlementProof(account: AccountMachine, counterpartyId: string, leftEvents: JurisdictionEvent[]): void {
  const ws = account.settlementWorkspace;
  if (!ws || (!ws.leftHanko && !ws.rightHanko)) return;

  const postProof = ws.postSettlementDisputeProof;
  if (postProof?.leftHanko && postProof?.rightHanko) {
    const iAmLeftHere = account.leftEntity !== counterpartyId;
    account.currentDisputeProofHanko = iAmLeftHere ? postProof.leftHanko : postProof.rightHanko;
    account.counterpartyDisputeProofHanko = iAmLeftHere ? postProof.rightHanko : postProof.leftHanko;
    account.currentDisputeProofNonce = postProof.nonce;
    account.currentDisputeProofBodyHash = postProof.proofBodyHash;
    account.counterpartyDisputeProofNonce = postProof.nonce;
    account.counterpartyDisputeProofBodyHash = postProof.proofBodyHash;
  }

  const firstSettled = leftEvents.find((event) => event.type === 'AccountSettled');
  const eventNonce = firstSettled?.data?.nonce;
  account.onChainSettlementNonce = typeof eventNonce === 'number'
    ? eventNonce
    : ws.nonceAtSign ?? ((account.onChainSettlementNonce || 0) + 1);
  delete account.settlementWorkspace;
}

export function tryFinalizeAccountJEvents(account: AccountMachine, counterpartyId: string, opts: { timestamp: number }): void {
  const leftMap = new Map<string, AccountJObservation>();
  const rightMap = new Map<string, AccountJObservation>();

  for (const obs of account.leftJObservations) leftMap.set(`${obs.jHeight}:${obs.jBlockHash}`, obs);
  for (const obs of account.rightJObservations) rightMap.set(`${obs.jHeight}:${obs.jBlockHash}`, obs);

  const matches = Array.from(leftMap.keys()).filter((key) => rightMap.has(key));
  if (matches.length === 0) return;

  const finalizedKeys = new Set<string>();
  for (const key of matches) {
    const leftObs = leftMap.get(key)!;
    const rightObs = rightMap.get(key)!;
    const jHeight = leftObs.jHeight;

    if (account.lastFinalizedJHeight >= jHeight) continue;
    if (account.jEventChain.some((block) => block.jHeight === jHeight)) continue;

    const leftRawLen = Array.isArray(leftObs?.events) ? leftObs.events.length : 0;
    const rightRawLen = Array.isArray(rightObs?.events) ? rightObs.events.length : 0;
    const leftEvents = normalizeObsEvents(leftObs);
    const rightEvents = normalizeObsEvents(rightObs);
    if (leftEvents.length === 0 || rightEvents.length === 0) {
      accountJEventLog.warn('bilateral.empty_events', { height: jHeight, block: shortHash(leftObs.jBlockHash) });
      continue;
    }
    if (leftEvents.length !== leftRawLen || rightEvents.length !== rightRawLen) {
      accountJEventLog.warn('bilateral.malformed_events', { height: jHeight, block: shortHash(leftObs.jBlockHash), leftRawLen, leftNormLen: leftEvents.length, rightRawLen, rightNormLen: rightEvents.length });
      continue;
    }
    if (!sameEventMultiset(leftEvents, rightEvents)) {
      accountJEventLog.warn('bilateral.event_mismatch', {
        height: jHeight,
        block: shortHash(leftObs.jBlockHash),
        leftKeys: leftEvents.map(canonicalJurisdictionEventKey),
        rightKeys: rightEvents.map(canonicalJurisdictionEventKey),
      });
      accountJEventLog.trace('bilateral.event_mismatch_payload', { height: jHeight, leftRaw: leftObs.events, rightRaw: rightObs.events });
      continue;
    }

    for (const event of leftEvents) applyAccountSettledEvent(account, event);

    account.jEventChain.push({ jHeight, jBlockHash: leftObs.jBlockHash, events: leftEvents, finalizedAt: opts.timestamp });
    account.lastFinalizedJHeight = Math.max(account.lastFinalizedJHeight, jHeight);
    finalizedKeys.add(key);
    activatePostSettlementProof(account, counterpartyId, leftEvents);
  }

  account.leftJObservations = account.leftJObservations.filter(
    (obs) => !finalizedKeys.has(`${obs.jHeight}:${obs.jBlockHash}`),
  );
  account.rightJObservations = account.rightJObservations.filter(
    (obs) => !finalizedKeys.has(`${obs.jHeight}:${obs.jBlockHash}`),
  );
}

export function mergeAccountJObservations(
  observations: Array<{ jHeight: number; jBlockHash: string; events: JurisdictionEvent[] }>,
): boolean {
  if (observations.length <= 1) return false;
  const groups = new Map<string, number>();
  let changed = false;
  let i = 0;
  while (i < observations.length) {
    const obs = observations[i];
    if (!obs) {
      observations.splice(i, 1);
      changed = true;
      continue;
    }
    const key = `${obs.jHeight}:${obs.jBlockHash}`;
    const existing = groups.get(key);
    if (existing !== undefined) {
      const target = observations[existing];
      if (!target) {
        groups.delete(key);
        i++;
        continue;
      }
      const normalizedEvents = normalizeJurisdictionEvents(obs.events);
      for (const ev of normalizedEvents) {
        const evKey = canonicalJurisdictionEventKey(ev);
        const alreadyHas = target.events.some((event) => canonicalJurisdictionEventKey(event) === evKey);
        if (!alreadyHas) {
          target.events.push(ev);
          changed = true;
        }
      }
      observations.splice(i, 1);
      changed = true;
    } else {
      groups.set(key, i);
      i++;
    }
  }
  return changed;
}

export function mergeJEventClaimOps(ops: JEventMempoolOp[]): void {
  const groups = new Map<string, number>();
  let i = 0;
  while (i < ops.length) {
    const op = ops[i];
    if (!op) {
      ops.splice(i, 1);
      continue;
    }
    if (!isJEventClaimOp(op)) {
      i++;
      continue;
    }
    const key = `${op.accountId}:${op.tx.data.jHeight}:${op.tx.data.jBlockHash}`;
    const existing = groups.get(key);
    if (existing !== undefined) {
      const target = ops[existing];
      if (!target || !isJEventClaimOp(target)) {
        groups.delete(key);
        i++;
        continue;
      }
      target.tx.data.events.push(...normalizeJurisdictionEvents(op.tx.data.events));
      ops.splice(i, 1);
    } else {
      groups.set(key, i);
      i++;
    }
  }
}

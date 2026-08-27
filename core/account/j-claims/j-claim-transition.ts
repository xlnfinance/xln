import type { AccountState, AccountTx } from '../../types/account';
import type { JurisdictionEvent } from '../../types/jurisdiction-events';
import type {
  AccountJClaimAccumulatorState,
  AccountJClaimDomain,
  AccountJClaimNodeStore,
  AccountJClaimProofResult,
  AccountJClaimRecord,
  AccountJClaimSide,
} from '../../types/finance/account-j-claims';
import { canonicalJurisdictionEventsHash } from '../../jurisdiction/machine/event-observation';
import {
  canonicalJurisdictionEventKey,
  compareCanonicalJurisdictionEvents,
  requireCanonicalJurisdictionEvents,
} from '../../jurisdiction/machine/events/event-normalization';
import {
  applyAccountJClaimDelete,
  applyAccountJClaimInsert,
  createAccountJClaimProof,
  createAccountJClaimRecord,
  pruneAccountJClaimsThroughHeight,
  verifyAccountJClaimProof,
} from './j-claim-accumulator';
import type { AccountJClaimSession } from './j-claim-session';

type ClaimTx = Extract<AccountTx, { type: 'j_event_claim' }>;

const canonicalEvents = (value: unknown): JurisdictionEvent[] => {
  const raw = Array.isArray(value) ? value : [];
  const normalized = requireCanonicalJurisdictionEvents(raw);
  if (normalized.length === 0 || normalized.length !== raw.length) {
    throw new Error('ACCOUNT_J_CLAIM_EVENTS_INVALID');
  }
  const ordered = [...normalized].sort(compareCanonicalJurisdictionEvents);
  const keys = ordered.map(canonicalJurisdictionEventKey);
  if (new Set(keys).size !== keys.length) throw new Error('ACCOUNT_J_CLAIM_EVENT_DUPLICATE');
  return ordered;
};

const claimDomain = (account: AccountState, domain: Pick<AccountJClaimDomain, 'chainId' | 'depositoryAddress'>) => ({
  ...domain,
  leftEntity: account.leftEntity,
  rightEntity: account.rightEntity,
});

const buildRecord = (
  account: AccountState,
  domain: Pick<AccountJClaimDomain, 'chainId' | 'depositoryAddress'>,
  side: AccountJClaimSide,
  data: ClaimTx['data'],
  events: JurisdictionEvent[],
): AccountJClaimRecord => createAccountJClaimRecord(claimDomain(account, domain), side, {
  jHeight: data.jHeight,
  jBlockHash: data.jBlockHash,
  eventsHash: canonicalJurisdictionEventsHash(events),
});

export const prepareAccountJClaimTx = (
  account: AccountState,
  tx: ClaimTx,
  domain: Pick<AccountJClaimDomain, 'chainId' | 'depositoryAddress'>,
  session: AccountJClaimSession,
): ClaimTx => {
  const events = canonicalEvents(tx.data.events);
  const left = buildRecord(account, domain, 'left', tx.data, events);
  const right = buildRecord(account, domain, 'right', tx.data, events);
  return {
    type: 'j_event_claim',
    data: {
      jHeight: tx.data.jHeight,
      jBlockHash: tx.data.jBlockHash.toLowerCase(),
      events,
      leftProof: createAccountJClaimProof(session.store, account.leftPendingJClaims.root, left),
      rightProof: createAccountJClaimProof(session.store, account.rightPendingJClaims.root, right),
    },
  };
};

const exactMemberConflict = (
  result: AccountJClaimProofResult,
  expected: AccountJClaimRecord,
  label: string,
): string | undefined => {
  if (result.status !== 'member') return undefined;
  const record = result.record;
  if (record.jBlockHash !== expected.jBlockHash || record.eventsHash !== expected.eventsHash) {
    return `${label}:${expected.side}:${expected.jHeight}`;
  }
  return undefined;
};

export type AccountJEventClaimAdmission = Readonly<{
  events: readonly JurisdictionEvent[];
  leftRecord: AccountJClaimRecord;
  rightRecord: AccountJClaimRecord;
  leftResult: AccountJClaimProofResult;
  rightResult: AccountJClaimProofResult;
}>;

export type AccountJEventClaimAdmissionResult =
  | Readonly<{ ok: true; admission: AccountJEventClaimAdmission }>
  | Readonly<{ ok: false; message: string }>;

export const validateAccountJEventClaimAdmission = (
  account: AccountState,
  tx: ClaimTx,
  domain: Pick<AccountJClaimDomain, 'chainId' | 'depositoryAddress'>,
): AccountJEventClaimAdmissionResult => {
  const events = canonicalEvents(tx.data.events);
  const leftRecord = buildRecord(account, domain, 'left', tx.data, events);
  const rightRecord = buildRecord(account, domain, 'right', tx.data, events);
  const leftResult = verifyAccountJClaimProof(account.leftPendingJClaims.root, leftRecord, tx.data.leftProof);
  const rightResult = verifyAccountJClaimProof(account.rightPendingJClaims.root, rightRecord, tx.data.rightProof);
  const message = exactMemberConflict(leftResult, leftRecord, 'ACCOUNT_J_CLAIM_LEFT_CONFLICT')
    ?? exactMemberConflict(rightResult, rightRecord, 'ACCOUNT_J_CLAIM_RIGHT_CONFLICT');
  return message
    ? { ok: false, message }
    : { ok: true, admission: { events, leftRecord, rightRecord, leftResult, rightResult } };
};

export type AccountJClaimLocalAdmissionPlan =
  | Readonly<{ verdict: 'admit' }>
  | Readonly<{ verdict: 'duplicate' }>
  | Readonly<{ verdict: 'conflict'; message: string }>;

/**
 * FX-3 (proofs/fixes.md, decision D4): the one local j-claim admission
 * planner, shared by enqueue admission and the proposal path (which re-runs
 * the same conflict classification through `validateAccountJEventClaimAdmission`
 * after regenerating proofs). A locally admitted claim carries no proofs yet,
 * so committed membership is decided by building fresh witnesses against the
 * committed accumulator roots — the store is authoritative, never the tx.
 *
 * Verdicts (admission clauses 1-3):
 *  - `duplicate`: exact (jHeight, jBlockHash, eventsHash) already committed or
 *    queued — idempotent skip, never a second mempool row.
 *  - `conflict`: same jHeight with different block/event evidence — a typed
 *    rejection for that row only. Adversarial observations must not halt the
 *    account, so this returns data instead of throwing; store/decode failures
 *    below still fail loud.
 *  - `admit`: no committed or queued evidence at this height.
 */
export const planAccountJClaimLocalAdmission = (
  account: AccountState,
  queued: readonly AccountTx[],
  tx: ClaimTx,
  store: AccountJClaimNodeStore,
  domain: Pick<AccountJClaimDomain, 'chainId' | 'depositoryAddress'>,
): AccountJClaimLocalAdmissionPlan => {
  const events = canonicalEvents(tx.data.events);
  const eventsHash = canonicalJurisdictionEventsHash(events);
  for (const side of ['left', 'right'] as const) {
    const record = buildRecord(account, domain, side, tx.data, events);
    const state = side === 'left' ? account.leftPendingJClaims : account.rightPendingJClaims;
    const result = verifyAccountJClaimProof(
      state.root,
      record,
      createAccountJClaimProof(store, state.root, record),
    );
    if (result.status !== 'member') continue;
    if (result.record.jBlockHash === record.jBlockHash && result.record.eventsHash === record.eventsHash) {
      return { verdict: 'duplicate' };
    }
    return {
      verdict: 'conflict',
      message: `ACCOUNT_J_CLAIM_${side.toUpperCase()}_CONFLICT:${side}:${tx.data.jHeight}`,
    };
  }
  for (const queuedTx of queued) {
    if (queuedTx.type !== 'j_event_claim' || queuedTx.data.jHeight !== tx.data.jHeight) continue;
    const queuedHash = canonicalJurisdictionEventsHash(canonicalEvents(queuedTx.data.events));
    const sameClaim = queuedHash === eventsHash
      && queuedTx.data.jBlockHash.toLowerCase() === tx.data.jBlockHash.toLowerCase();
    if (sameClaim) return { verdict: 'duplicate' };
    return { verdict: 'conflict', message: `ACCOUNT_J_CLAIM_QUEUED_CONFLICT:${tx.data.jHeight}` };
  }
  return { verdict: 'admit' };
};

const pruneSide = (
  state: AccountJClaimAccumulatorState,
  record: AccountJClaimRecord,
  height: number,
  session: AccountJClaimSession,
): AccountJClaimAccumulatorState => {
  const result = pruneAccountJClaimsThroughHeight(state, session.store, record.accountKey, record.side, height);
  session.absorb(result);
  return result.state;
};

export type AccountJClaimTransition = Readonly<{
  status: 'pending' | 'idempotent' | 'finalized' | 'stale';
  left: AccountJClaimAccumulatorState;
  right: AccountJClaimAccumulatorState;
  events: readonly JurisdictionEvent[];
}>;

export const applyAccountJClaimTransition = (
  account: AccountState,
  tx: ClaimTx,
  byLeft: boolean,
  session: AccountJClaimSession,
  admission: AccountJEventClaimAdmission,
): AccountJClaimTransition => {
  const { events, leftRecord, rightRecord, leftResult, rightResult } = admission;

  if (tx.data.jHeight <= account.lastFinalizedJHeight) {
    return {
      status: 'stale',
      left: pruneSide(account.leftPendingJClaims, leftRecord, account.lastFinalizedJHeight, session),
      right: pruneSide(account.rightPendingJClaims, rightRecord, account.lastFinalizedJHeight, session),
      events,
    };
  }

  const ownResult = byLeft ? leftResult : rightResult;
  const peerResult = byLeft ? rightResult : leftResult;
  const ownRecord = byLeft ? leftRecord : rightRecord;
  const peerRecord = byLeft ? rightRecord : leftRecord;
  const ownState = byLeft ? account.leftPendingJClaims : account.rightPendingJClaims;
  const peerState = byLeft ? account.rightPendingJClaims : account.leftPendingJClaims;
  if (peerResult.status === 'absent') {
    if (ownResult.status === 'member') {
      return { status: 'idempotent', left: account.leftPendingJClaims, right: account.rightPendingJClaims, events };
    }
    const inserted = applyAccountJClaimInsert(ownState, ownRecord, byLeft ? tx.data.leftProof : tx.data.rightProof);
    session.absorb(inserted);
    return {
      status: 'pending',
      left: byLeft ? inserted.state : account.leftPendingJClaims,
      right: byLeft ? account.rightPendingJClaims : inserted.state,
      events,
    };
  }

  const peerDeleted = applyAccountJClaimDelete(peerState, peerRecord, byLeft ? tx.data.rightProof : tx.data.leftProof);
  session.absorb(peerDeleted);
  let nextOwn = ownState;
  if (ownResult.status === 'member') {
    const ownDeleted = applyAccountJClaimDelete(ownState, ownRecord, byLeft ? tx.data.leftProof : tx.data.rightProof);
    session.absorb(ownDeleted);
    nextOwn = ownDeleted.state;
  }
  let left = byLeft ? nextOwn : peerDeleted.state;
  let right = byLeft ? peerDeleted.state : nextOwn;
  left = pruneSide(left, leftRecord, tx.data.jHeight, session);
  right = pruneSide(right, rightRecord, tx.data.jHeight, session);
  return { status: 'finalized', left, right, events };
};

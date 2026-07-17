import type { AccountMachine, AccountTx, JurisdictionEvent } from '../types';
import type {
  AccountJClaimAccumulatorState,
  AccountJClaimDomain,
  AccountJClaimProofResult,
  AccountJClaimRecord,
  AccountJClaimSide,
} from '../types/account-j-claims';
import { canonicalJurisdictionEventsHash } from '../jurisdiction/event-observation';
import {
  canonicalJurisdictionEventKey,
  compareCanonicalJurisdictionEvents,
  normalizeJurisdictionEvents,
} from '../jurisdiction/event-normalization';
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
  const normalized = normalizeJurisdictionEvents(raw);
  if (normalized.length === 0 || normalized.length !== raw.length) {
    throw new Error('ACCOUNT_J_CLAIM_EVENTS_INVALID');
  }
  const ordered = [...normalized].sort(compareCanonicalJurisdictionEvents);
  const keys = ordered.map(canonicalJurisdictionEventKey);
  if (new Set(keys).size !== keys.length) throw new Error('ACCOUNT_J_CLAIM_EVENT_DUPLICATE');
  return ordered;
};

const claimDomain = (account: AccountMachine, domain: Pick<AccountJClaimDomain, 'chainId' | 'depositoryAddress'>) => ({
  ...domain,
  leftEntity: account.leftEntity,
  rightEntity: account.rightEntity,
});

const buildRecord = (
  account: AccountMachine,
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
  account: AccountMachine,
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

const assertExactMember = (
  result: AccountJClaimProofResult,
  expected: AccountJClaimRecord,
  label: string,
): void => {
  if (result.status !== 'member') return;
  const record = result.record;
  if (record.jBlockHash !== expected.jBlockHash || record.eventsHash !== expected.eventsHash) {
    throw new Error(`${label}:${expected.side}:${expected.jHeight}`);
  }
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
  account: AccountMachine,
  tx: ClaimTx,
  byLeft: boolean,
  domain: Pick<AccountJClaimDomain, 'chainId' | 'depositoryAddress'>,
  session: AccountJClaimSession,
): AccountJClaimTransition => {
  const events = canonicalEvents(tx.data.events);
  const leftRecord = buildRecord(account, domain, 'left', tx.data, events);
  const rightRecord = buildRecord(account, domain, 'right', tx.data, events);
  const leftResult = verifyAccountJClaimProof(account.leftPendingJClaims.root, leftRecord, tx.data.leftProof);
  const rightResult = verifyAccountJClaimProof(account.rightPendingJClaims.root, rightRecord, tx.data.rightProof);
  assertExactMember(leftResult, leftRecord, 'ACCOUNT_J_CLAIM_LEFT_CONFLICT');
  assertExactMember(rightResult, rightRecord, 'ACCOUNT_J_CLAIM_RIGHT_CONFLICT');

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

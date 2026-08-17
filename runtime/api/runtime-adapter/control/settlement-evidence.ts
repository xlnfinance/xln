/**
 * Operator-only settlement evidence. Requests name bounded public identities;
 * responses expose only counts, commitment flags and digests, never queued
 * payloads, signatures, deltas, secrets or other private Runtime state.
 */

import { keccak256, toUtf8Bytes } from 'ethers';
import { findAccountByCounterparty } from '../../../account/state/account-lookup';
import { getEntityReplicaById } from '../../../entity/replica/replica-lookup';
import { requireBoundaryInteger, requireBoundaryRecord, requireExactBoundaryKeys } from '../../../protocol/boundary-validation';
import { safeStringify } from '../../../protocol/serialization';
import type { RuntimeReplica } from '../../../runtime/types';
import type { AccountFrame } from '../../../types/account';
import {
  buildSettlementBookEvidence,
  decodeSettlementBookEvidence,
  decodeSettlementBookRequest,
  type SettlementBookEvidence,
  type SettlementBookRequest,
} from './settlement-book-evidence';

export const MAX_SETTLEMENT_EVIDENCE_ACCOUNTS = 512;
const MAX_OFFERS = 4_096;
const ENTITY_ID = /^0x[0-9a-f]{64}$/;
const HASH = /^0x[0-9a-f]{64}$/;

export type SettlementEvidenceRequest = Readonly<{
  type: 'settlement-evidence';
  book: SettlementBookRequest | null;
  accounts: readonly Readonly<{
    entityId: string;
    counterpartyEntityId: string;
    offerIds: readonly string[];
  }>[];
}>;

type QueueEvidence = Readonly<{ count: number; digest: string }>;
type OfferEvidence = Readonly<{
  offerId: string;
  offerCommitted: boolean;
  resolveCommitted: boolean;
  live: boolean;
  closed: boolean;
}>;

export type SettlementEvidenceResponse = Readonly<{
  runtimeHeight: number;
  book: SettlementBookEvidence | null;
  queues: Readonly<{
    processing: QueueEvidence;
    pendingOutputs: QueueEvidence;
    pendingNetworkOutputs: QueueEvidence;
    networkInbox: QueueEvidence;
    runtimeEntityInputs: QueueEvidence;
    runtimeTxs: QueueEvidence;
    runtimeJInputs: QueueEvidence;
    pendingReceipts: QueueEvidence;
    retryEntries: QueueEvidence;
  }>;
  accounts: readonly Readonly<{
    entityId: string;
    counterpartyEntityId: string;
    accountKey: string;
    currentHeight: number;
    currentStateHash: string;
    pendingFrame: boolean;
    pendingProposal: boolean;
    mempool: QueueEvidence;
    offers: readonly OfferEvidence[];
  }>[];
}>;

export type SettlementAccountFrameReader = (
  env: RuntimeReplica,
  entityId: string,
  counterpartyEntityId: string,
  limit: number,
) => Promise<AccountFrame[]>;

const requireEntityId = (value: unknown, code: string): string => {
  if (typeof value !== 'string' || !ENTITY_ID.test(value)) throw new Error(code);
  return value;
};

const requireOfferId = (value: unknown, code: string): string => {
  if (typeof value !== 'string' || !value || value.length > 256 || value.includes(':')) throw new Error(code);
  return value;
};

const requireAccountKey = (value: unknown, code: string): string => {
  if (typeof value !== 'string') throw new Error(code);
  const parts = value.split(':');
  if (parts.length !== 2 || parts.some(part => !ENTITY_ID.test(part))) throw new Error(code);
  return value;
};

export const decodeSettlementEvidenceRequest = (value: unknown): SettlementEvidenceRequest => {
  const request = requireBoundaryRecord(value, 'RADAPTER_SETTLEMENT_REQUEST_INVALID');
  requireExactBoundaryKeys(request, ['type', 'book', 'accounts'], [], 'RADAPTER_SETTLEMENT_REQUEST_FIELDS_INVALID');
  if (request['type'] !== 'settlement-evidence' || !Array.isArray(request['accounts']) ||
    request['accounts'].length > MAX_SETTLEMENT_EVIDENCE_ACCOUNTS) throw new Error('RADAPTER_SETTLEMENT_REQUEST_ACCOUNTS_INVALID');
  let offerCount = 0;
  const accounts = request['accounts'].map((raw, index) => {
    const account = requireBoundaryRecord(raw, `RADAPTER_SETTLEMENT_ACCOUNT_INVALID:${index}`);
    requireExactBoundaryKeys(account, ['entityId', 'counterpartyEntityId', 'offerIds'], [], `RADAPTER_SETTLEMENT_ACCOUNT_FIELDS_INVALID:${index}`);
    if (!Array.isArray(account['offerIds'])) throw new Error(`RADAPTER_SETTLEMENT_OFFER_IDS_INVALID:${index}`);
    const offerIds = account['offerIds'].map((entry, offerIndex) =>
      requireOfferId(entry, `RADAPTER_SETTLEMENT_OFFER_ID_INVALID:${index}:${offerIndex}`));
    if (new Set(offerIds).size !== offerIds.length) throw new Error(`RADAPTER_SETTLEMENT_OFFER_IDS_DUPLICATE:${index}`);
    offerCount += offerIds.length;
    return {
      entityId: requireEntityId(account['entityId'], `RADAPTER_SETTLEMENT_ENTITY_INVALID:${index}`),
      counterpartyEntityId: requireEntityId(account['counterpartyEntityId'], `RADAPTER_SETTLEMENT_COUNTERPARTY_INVALID:${index}`),
      offerIds,
    };
  });
  if (offerCount > MAX_OFFERS) throw new Error('RADAPTER_SETTLEMENT_REQUEST_OFFERS_EXCEEDED');
  const keys = accounts.map(account => `${account.entityId}:${account.counterpartyEntityId}`);
  if (new Set(keys).size !== keys.length) throw new Error('RADAPTER_SETTLEMENT_REQUEST_ACCOUNTS_DUPLICATE');
  const book = request['book'] === null ? null : decodeSettlementBookRequest(request['book']);
  return { type: 'settlement-evidence', book, accounts };
};

const digest = (value: unknown): string => keccak256(toUtf8Bytes(safeStringify(value)));
const queue = (values: readonly unknown[]): QueueEvidence => ({ count: values.length, digest: digest(values) });
const mapEntries = (value: ReadonlyMap<string, unknown> | undefined): readonly unknown[] =>
  Array.from(value?.entries() ?? []).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);

const committedOfferFlags = (
  frames: readonly AccountFrame[],
  offerId: string,
): Readonly<{ offerCommitted: boolean; resolveCommitted: boolean }> => {
  let offerCommitted = false;
  let resolveCommitted = false;
  for (const frame of frames) {
    for (const tx of frame.accountTxs) {
      if (tx.type === 'swap_offer' && tx.data.offerId === offerId) offerCommitted = true;
      if ((tx.type === 'swap_resolve' || tx.type === 'cross_swap_fill_ack') && tx.data.offerId === offerId) {
        resolveCommitted = true;
      }
    }
  }
  return { offerCommitted, resolveCommitted };
};

const accountEvidence = async (
  env: RuntimeReplica,
  request: SettlementEvidenceRequest['accounts'][number],
  readAccountFrames: SettlementAccountFrameReader,
): Promise<SettlementEvidenceResponse['accounts'][number]> => {
  const entity = getEntityReplicaById(env, request.entityId);
  const account = entity
    ? findAccountByCounterparty(entity.state.accounts, request.entityId, request.counterpartyEntityId)
    : null;
  if (!account) throw new Error(`RADAPTER_SETTLEMENT_ACCOUNT_NOT_FOUND:${request.entityId}:${request.counterpartyEntityId}`);
  const frames = await readAccountFrames(env, request.entityId, request.counterpartyEntityId, 1_000);
  const certifiedHead = frames.at(-1);
  if (!certifiedHead || certifiedHead.height !== account.currentHeight ||
    certifiedHead.stateHash !== account.currentFrame.stateHash) {
    throw new Error(`RADAPTER_SETTLEMENT_CERTIFIED_HEAD_MISMATCH:${request.entityId}:${request.counterpartyEntityId}`);
  }
  const offers = request.offerIds.map(offerId => {
    const committed = committedOfferFlags(frames, offerId);
    return {
      offerId,
      ...committed,
      live: account.state.swapOffers.has(offerId),
      closed: committed.offerCommitted && committed.resolveCommitted && !account.state.swapOffers.has(offerId),
    };
  });
  if (frames.length === 1_000 && offers.some(offer => !offer.offerCommitted)) {
    throw new Error(`RADAPTER_SETTLEMENT_HISTORY_WINDOW_EXCEEDED:${request.entityId}:${request.counterpartyEntityId}`);
  }
  return {
    entityId: request.entityId,
    counterpartyEntityId: request.counterpartyEntityId,
    accountKey: `${account.state.leftEntity}:${account.state.rightEntity}`,
    currentHeight: certifiedHead.height,
    currentStateHash: certifiedHead.stateHash,
    pendingFrame: account.pendingFrame !== undefined,
    pendingProposal: account.pendingAccountInput !== undefined,
    mempool: queue(account.mempool),
    offers,
  };
};

export const buildSettlementEvidence = async (
  env: RuntimeReplica,
  input: SettlementEvidenceRequest,
  readAccountFrames: SettlementAccountFrameReader,
): Promise<SettlementEvidenceResponse> => {
  const request = decodeSettlementEvidenceRequest(input);
  const mempool = env.runtimeMempool;
  const infrastructure = env.infrastructure;
  return {
    runtimeHeight: env.state.height,
    book: request.book === null ? null : buildSettlementBookEvidence(env, request.book),
    queues: {
      processing: queue(infrastructure?.processingPromise ? ['processing'] : []),
      pendingOutputs: queue(env.pendingOutputs ?? []),
      pendingNetworkOutputs: queue(env.pendingNetworkOutputs ?? []),
      networkInbox: queue(env.networkInbox ?? []),
      runtimeEntityInputs: queue(mempool.entityInputs),
      runtimeTxs: queue(mempool.runtimeTxs),
      runtimeJInputs: queue(mempool.jInputs ?? []),
      pendingReceipts: queue(mempool.reliableReceipts ?? []),
      retryEntries: queue(mapEntries(infrastructure?.deferredNetworkMeta)),
    },
    accounts: await Promise.all(request.accounts.map(account =>
      accountEvidence(env, account, readAccountFrames))),
  };
};

const decodeQueue = (value: unknown, code: string): QueueEvidence => {
  const evidence = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(evidence, ['count', 'digest'], [], `${code}_FIELDS`);
  const digestValue = evidence['digest'];
  if (typeof digestValue !== 'string' || !HASH.test(digestValue)) throw new Error(`${code}_DIGEST`);
  return { count: requireBoundaryInteger(evidence['count'], `${code}_COUNT`), digest: digestValue };
};

const decodeResponseAccount = (value: unknown, index: number): SettlementEvidenceResponse['accounts'][number] => {
  const account = requireBoundaryRecord(value, `RADAPTER_SETTLEMENT_RESPONSE_ACCOUNT_INVALID:${index}`);
  requireExactBoundaryKeys(account, [
    'entityId', 'counterpartyEntityId', 'accountKey', 'currentHeight', 'currentStateHash',
    'pendingFrame', 'pendingProposal', 'mempool', 'offers',
  ], [], `RADAPTER_SETTLEMENT_RESPONSE_ACCOUNT_FIELDS_INVALID:${index}`);
  if (!Array.isArray(account['offers'])) throw new Error(`RADAPTER_SETTLEMENT_RESPONSE_OFFERS_INVALID:${index}`);
  const currentStateHash = account['currentStateHash'];
  if (typeof currentStateHash !== 'string' || !HASH.test(currentStateHash)) throw new Error(`RADAPTER_SETTLEMENT_RESPONSE_ROOT_INVALID:${index}`);
  const offers = account['offers'].map((raw, offerIndex) => {
    const offer = requireBoundaryRecord(raw, `RADAPTER_SETTLEMENT_RESPONSE_OFFER_INVALID:${index}:${offerIndex}`);
    requireExactBoundaryKeys(offer, ['offerId', 'offerCommitted', 'resolveCommitted', 'live', 'closed'], [], `RADAPTER_SETTLEMENT_RESPONSE_OFFER_FIELDS_INVALID:${index}:${offerIndex}`);
    for (const field of ['offerCommitted', 'resolveCommitted', 'live', 'closed'] as const) {
      if (typeof offer[field] !== 'boolean') throw new Error(`RADAPTER_SETTLEMENT_RESPONSE_OFFER_FLAG_INVALID:${index}:${offerIndex}`);
    }
    return {
      offerId: requireOfferId(offer['offerId'], `RADAPTER_SETTLEMENT_RESPONSE_OFFER_ID_INVALID:${index}:${offerIndex}`),
      offerCommitted: offer['offerCommitted'] === true,
      resolveCommitted: offer['resolveCommitted'] === true,
      live: offer['live'] === true,
      closed: offer['closed'] === true,
    };
  });
  if (typeof account['pendingFrame'] !== 'boolean' || typeof account['pendingProposal'] !== 'boolean') throw new Error(`RADAPTER_SETTLEMENT_RESPONSE_PENDING_INVALID:${index}`);
  return {
    entityId: requireEntityId(account['entityId'], `RADAPTER_SETTLEMENT_RESPONSE_ENTITY_INVALID:${index}`),
    counterpartyEntityId: requireEntityId(account['counterpartyEntityId'], `RADAPTER_SETTLEMENT_RESPONSE_COUNTERPARTY_INVALID:${index}`),
    accountKey: requireAccountKey(account['accountKey'], `RADAPTER_SETTLEMENT_RESPONSE_ACCOUNT_KEY_INVALID:${index}`),
    currentHeight: requireBoundaryInteger(account['currentHeight'], `RADAPTER_SETTLEMENT_RESPONSE_HEIGHT_INVALID:${index}`),
    currentStateHash,
    pendingFrame: account['pendingFrame'], pendingProposal: account['pendingProposal'],
    mempool: decodeQueue(account['mempool'], `RADAPTER_SETTLEMENT_RESPONSE_MEMPOOL_INVALID:${index}`),
    offers,
  };
};

export const decodeSettlementEvidenceResponse = (value: unknown): SettlementEvidenceResponse => {
  const response = requireBoundaryRecord(value, 'RADAPTER_SETTLEMENT_RESPONSE_INVALID');
  requireExactBoundaryKeys(response, ['runtimeHeight', 'book', 'queues', 'accounts'], [], 'RADAPTER_SETTLEMENT_RESPONSE_FIELDS_INVALID');
  const queues = requireBoundaryRecord(response['queues'], 'RADAPTER_SETTLEMENT_RESPONSE_QUEUES_INVALID');
  const queueKeys = ['processing', 'pendingOutputs', 'pendingNetworkOutputs', 'networkInbox', 'runtimeEntityInputs', 'runtimeTxs', 'runtimeJInputs', 'pendingReceipts', 'retryEntries'] as const;
  requireExactBoundaryKeys(queues, queueKeys, [], 'RADAPTER_SETTLEMENT_RESPONSE_QUEUE_FIELDS_INVALID');
  if (!Array.isArray(response['accounts'])) throw new Error('RADAPTER_SETTLEMENT_RESPONSE_ACCOUNTS_INVALID');
  const decodedQueues = (key: typeof queueKeys[number]): QueueEvidence =>
    decodeQueue(queues[key], `RADAPTER_SETTLEMENT_RESPONSE_QUEUE_INVALID:${key}`);
  return {
    runtimeHeight: requireBoundaryInteger(response['runtimeHeight'], 'RADAPTER_SETTLEMENT_RESPONSE_HEIGHT_INVALID'),
    book: response['book'] === null ? null : decodeSettlementBookEvidence(response['book']),
    queues: {
      processing: decodedQueues('processing'),
      pendingOutputs: decodedQueues('pendingOutputs'),
      pendingNetworkOutputs: decodedQueues('pendingNetworkOutputs'),
      networkInbox: decodedQueues('networkInbox'),
      runtimeEntityInputs: decodedQueues('runtimeEntityInputs'),
      runtimeTxs: decodedQueues('runtimeTxs'),
      runtimeJInputs: decodedQueues('runtimeJInputs'),
      pendingReceipts: decodedQueues('pendingReceipts'),
      retryEntries: decodedQueues('retryEntries'),
    },
    accounts: response['accounts'].map(decodeResponseAccount),
  };
};

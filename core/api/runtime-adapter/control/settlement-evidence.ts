/**
 * Operator-only settlement evidence. Requests name bounded public identities;
 * responses expose only counts, commitment flags and digests, never queued
 * payloads, signatures, deltas, secrets or other private Runtime state.
 */

import { keccak256, toUtf8Bytes } from 'ethers';
import { findAccountByCounterparty } from '../../../account/state/account-lookup';
import { isLeftEntity } from '../../../account/utils';
import { accountInputAck, accountInputProposal } from '../../../account/consensus/flush';
import { getEntityReplicaById } from '../../../entity/replica/replica-lookup';
import { requireBoundaryInteger, requireBoundaryRecord, requireExactBoundaryKeys } from '../../../protocol/boundary-validation';
import { safeStringify } from '../../../protocol/serialization';
import type { RuntimeReplica } from '../../../runtime/types';
import {
  buildSettlementBookEvidence,
  decodeSettlementBookEvidence,
  decodeSettlementBookRequest,
  type SettlementBookEvidence,
  type SettlementBookRequest,
} from './settlement-book-evidence';

export const MAX_SETTLEMENT_EVIDENCE_ACCOUNTS = 512;
export const MAX_PENDING_ACCOUNT_SAMPLE = 8;
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
  live: boolean;
}>;

type PendingAccountSample = Readonly<{
  entityId: string;
  counterpartyEntityId: string;
  localIsLeft: boolean;
  currentHeight: number;
  currentStateHash: string;
  height: number;
  pendingFrameHash: string;
  pendingFrameTxCount: number;
  pendingInputKind: 'ack_frame';
  pendingAckHeight: number | null;
  pendingProposalHeight: number;
  lastOutboundAckHeight: number | null;
  rollbackCount: number;
  lastRollbackFrameHash: string | null;
  mempoolCount: number;
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
    pendingAccountFrames: QueueEvidence;
  }>;
  pendingAccountSample: readonly PendingAccountSample[];
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
const countedQueue = (count: number): QueueEvidence => ({ count, digest: digest(count) });

/** RAM-only; drain must not walk Account history to learn Hub ACK backlog. */
const pendingAccountFrameSnapshot = (
  env: RuntimeReplica,
): Readonly<{ count: number; sample: readonly PendingAccountSample[] }> => {
  const sample: PendingAccountSample[] = [];
  let count = 0;
  for (const replica of env.state.eReplicas.values()) {
    for (const [counterpartyEntityId, account] of replica.state.accounts) {
      if (!account.pendingFrame) continue;
      count += 1;
      if (sample.length < MAX_PENDING_ACCOUNT_SAMPLE) {
        const pendingInput = account.pendingAccountInput;
        const pendingProposal = pendingInput ? accountInputProposal(pendingInput) : undefined;
        if (!pendingInput || !pendingProposal) {
          throw new Error(
            `SETTLEMENT_PENDING_INPUT_INVARIANT:${replica.state.entityId}:${counterpartyEntityId}:` +
            `height=${account.pendingFrame.height}`,
          );
        }
        const pendingAck = accountInputAck(pendingInput);
        sample.push({
          entityId: replica.state.entityId,
          counterpartyEntityId,
          localIsLeft: isLeftEntity(replica.state.entityId, counterpartyEntityId),
          currentHeight: account.currentHeight,
          currentStateHash: account.currentFrame.stateHash,
          height: account.pendingFrame.height,
          pendingFrameHash: account.pendingFrame.stateHash,
          pendingFrameTxCount: account.pendingFrame.accountTxs.length,
          pendingInputKind: pendingInput.kind,
          pendingAckHeight: pendingAck ? pendingAck.height : null,
          pendingProposalHeight: pendingProposal.frame.height,
          lastOutboundAckHeight: account.lastOutboundAckFrame?.height ?? null,
          rollbackCount: account.rollbackCount,
          lastRollbackFrameHash: account.lastRollbackFrameHash ?? null,
          mempoolCount: account.mempool.length,
        });
      }
    }
  }
  return { count, sample };
};

const accountEvidence = (
  env: RuntimeReplica,
  request: SettlementEvidenceRequest['accounts'][number],
): SettlementEvidenceResponse['accounts'][number] => {
  const entity = getEntityReplicaById(env, request.entityId);
  const account = entity
    ? findAccountByCounterparty(entity.state.accounts, request.entityId, request.counterpartyEntityId)
    : null;
  if (!account) throw new Error(`RADAPTER_SETTLEMENT_ACCOUNT_NOT_FOUND:${request.entityId}:${request.counterpartyEntityId}`);
  const offers = request.offerIds.map(offerId => ({
    offerId,
    live: account.state.swapOffers.has(offerId),
  }));
  return {
    entityId: request.entityId,
    counterpartyEntityId: request.counterpartyEntityId,
    accountKey: `${account.state.leftEntity}:${account.state.rightEntity}`,
    currentHeight: account.currentHeight,
    currentStateHash: account.currentFrame.stateHash,
    pendingFrame: account.pendingFrame !== undefined,
    pendingProposal: account.pendingAccountInput !== undefined,
    mempool: queue(account.mempool),
    offers,
  };
};

export const buildSettlementEvidence = (
  env: RuntimeReplica,
  input: SettlementEvidenceRequest,
): SettlementEvidenceResponse => {
  const request = decodeSettlementEvidenceRequest(input);
  const mempool = env.runtimeMempool;
  const infrastructure = env.infrastructure;
  const pending = pendingAccountFrameSnapshot(env);
  return {
    runtimeHeight: env.state.height,
    book: request.book === null ? null : buildSettlementBookEvidence(env, request.book),
    queues: {
      // Drain authority is queue emptiness. Hashing full signed Account
      // envelopes here used to serialize megabytes while holding the Runtime
      // committed-read lease, starving the WAL writer that must empty them.
      // Count digests retain stable operator evidence without making a
      // diagnostic poll execute the financial payload path a second time.
      processing: countedQueue(infrastructure?.processingPromise ? 1 : 0),
      pendingOutputs: countedQueue(env.pendingOutputs?.length ?? 0),
      pendingNetworkOutputs: countedQueue(env.pendingNetworkOutputs?.length ?? 0),
      networkInbox: countedQueue(env.networkInbox?.length ?? 0),
      runtimeEntityInputs: countedQueue(mempool.entityInputs.length),
      runtimeTxs: countedQueue(mempool.runtimeTxs.length),
      runtimeJInputs: countedQueue(mempool.jInputs?.length ?? 0),
      pendingAccountFrames: countedQueue(pending.count),
    },
    pendingAccountSample: pending.sample,
    accounts: request.accounts.map(account => accountEvidence(env, account)),
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
    requireExactBoundaryKeys(offer, ['offerId', 'live'], [], `RADAPTER_SETTLEMENT_RESPONSE_OFFER_FIELDS_INVALID:${index}:${offerIndex}`);
    if (typeof offer['live'] !== 'boolean') {
      throw new Error(`RADAPTER_SETTLEMENT_RESPONSE_OFFER_FLAG_INVALID:${index}:${offerIndex}`);
    }
    return {
      offerId: requireOfferId(offer['offerId'], `RADAPTER_SETTLEMENT_RESPONSE_OFFER_ID_INVALID:${index}:${offerIndex}`),
      live: offer['live'] === true,
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

const decodePendingAccountSample = (value: unknown): SettlementEvidenceResponse['pendingAccountSample'] => {
  if (!Array.isArray(value) || value.length > MAX_PENDING_ACCOUNT_SAMPLE) {
    throw new Error('RADAPTER_SETTLEMENT_RESPONSE_PENDING_SAMPLE_INVALID');
  }
  return value.map((raw, index) => {
    const entry = requireBoundaryRecord(raw, `RADAPTER_SETTLEMENT_RESPONSE_PENDING_SAMPLE_ENTRY_INVALID:${index}`);
    requireExactBoundaryKeys(
      entry,
      [
        'entityId', 'counterpartyEntityId', 'localIsLeft', 'currentHeight', 'currentStateHash',
        'height', 'pendingFrameHash', 'pendingFrameTxCount', 'pendingInputKind', 'pendingAckHeight',
        'pendingProposalHeight', 'lastOutboundAckHeight', 'rollbackCount', 'lastRollbackFrameHash',
        'mempoolCount',
      ],
      [],
      `RADAPTER_SETTLEMENT_RESPONSE_PENDING_SAMPLE_FIELDS_INVALID:${index}`,
    );
    const requireHash = (field: 'currentStateHash' | 'pendingFrameHash'): string => {
      const hash = entry[field];
      if (typeof hash !== 'string' || !HASH.test(hash)) {
        throw new Error(`RADAPTER_SETTLEMENT_RESPONSE_PENDING_SAMPLE_${field.toUpperCase()}_INVALID:${index}`);
      }
      return hash;
    };
    const requireNullableHeight = (field: 'pendingAckHeight' | 'lastOutboundAckHeight'): number | null =>
      entry[field] === null
        ? null
        : requireBoundaryInteger(
            entry[field],
            `RADAPTER_SETTLEMENT_RESPONSE_PENDING_SAMPLE_${field.toUpperCase()}_INVALID:${index}`,
          );
    const rollbackHash = entry['lastRollbackFrameHash'];
    if (rollbackHash !== null && (typeof rollbackHash !== 'string' || !HASH.test(rollbackHash))) {
      throw new Error(`RADAPTER_SETTLEMENT_RESPONSE_PENDING_SAMPLE_ROLLBACK_HASH_INVALID:${index}`);
    }
    const pendingInputKind = entry['pendingInputKind'];
    if (pendingInputKind !== 'ack_frame') {
      throw new Error(`RADAPTER_SETTLEMENT_RESPONSE_PENDING_SAMPLE_INPUT_KIND_INVALID:${index}`);
    }
    if (typeof entry['localIsLeft'] !== 'boolean') {
      throw new Error(`RADAPTER_SETTLEMENT_RESPONSE_PENDING_SAMPLE_SIDE_INVALID:${index}`);
    }
    return {
      entityId: requireEntityId(entry['entityId'], `RADAPTER_SETTLEMENT_RESPONSE_PENDING_SAMPLE_ENTITY_INVALID:${index}`),
      counterpartyEntityId: requireEntityId(
        entry['counterpartyEntityId'],
        `RADAPTER_SETTLEMENT_RESPONSE_PENDING_SAMPLE_COUNTERPARTY_INVALID:${index}`,
      ),
      localIsLeft: entry['localIsLeft'],
      currentHeight: requireBoundaryInteger(entry['currentHeight'], `RADAPTER_SETTLEMENT_RESPONSE_PENDING_SAMPLE_CURRENT_HEIGHT_INVALID:${index}`),
      currentStateHash: requireHash('currentStateHash'),
      height: requireBoundaryInteger(entry['height'], `RADAPTER_SETTLEMENT_RESPONSE_PENDING_SAMPLE_HEIGHT_INVALID:${index}`),
      pendingFrameHash: requireHash('pendingFrameHash'),
      pendingFrameTxCount: requireBoundaryInteger(entry['pendingFrameTxCount'], `RADAPTER_SETTLEMENT_RESPONSE_PENDING_SAMPLE_TX_COUNT_INVALID:${index}`),
      pendingInputKind,
      pendingAckHeight: requireNullableHeight('pendingAckHeight'),
      pendingProposalHeight: requireBoundaryInteger(entry['pendingProposalHeight'], `RADAPTER_SETTLEMENT_RESPONSE_PENDING_SAMPLE_PROPOSAL_HEIGHT_INVALID:${index}`),
      lastOutboundAckHeight: requireNullableHeight('lastOutboundAckHeight'),
      rollbackCount: requireBoundaryInteger(entry['rollbackCount'], `RADAPTER_SETTLEMENT_RESPONSE_PENDING_SAMPLE_ROLLBACK_COUNT_INVALID:${index}`),
      lastRollbackFrameHash: rollbackHash,
      mempoolCount: requireBoundaryInteger(entry['mempoolCount'], `RADAPTER_SETTLEMENT_RESPONSE_PENDING_SAMPLE_MEMPOOL_COUNT_INVALID:${index}`),
    };
  });
};

export const decodeSettlementEvidenceResponse = (value: unknown): SettlementEvidenceResponse => {
  const response = requireBoundaryRecord(value, 'RADAPTER_SETTLEMENT_RESPONSE_INVALID');
  requireExactBoundaryKeys(response, ['runtimeHeight', 'book', 'queues', 'accounts', 'pendingAccountSample'], [], 'RADAPTER_SETTLEMENT_RESPONSE_FIELDS_INVALID');
  const queues = requireBoundaryRecord(response['queues'], 'RADAPTER_SETTLEMENT_RESPONSE_QUEUES_INVALID');
  const queueKeys = ['processing', 'pendingOutputs', 'pendingNetworkOutputs', 'networkInbox', 'runtimeEntityInputs', 'runtimeTxs', 'runtimeJInputs', 'pendingAccountFrames'] as const;
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
      pendingAccountFrames: decodedQueues('pendingAccountFrames'),
    },
    pendingAccountSample: decodePendingAccountSample(response['pendingAccountSample']),
    accounts: response['accounts'].map(decodeResponseAccount),
  };
};

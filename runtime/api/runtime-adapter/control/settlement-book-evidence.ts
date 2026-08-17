/** Bounded orderbook evidence for the operator-only settlement projection. */

import { keccak256, toUtf8Bytes } from 'ethers';
import { getEntityReplicaById } from '../../../entity/replica/replica-lookup';
import { getBestAsk, getBestBid } from '../../../orderbook';
import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../../../protocol/boundary-validation';
import { safeStringify } from '../../../protocol/serialization';
import type { RuntimeReplica } from '../../../runtime/types';

const ENTITY_ID = /^0x[0-9a-f]{64}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const PAIR_ID = /^[a-zA-Z0-9._:/-]{1,512}$/;

export type SettlementBookRequest = Readonly<{
  entityId: string;
  pairId: string;
}>;

export type SettlementBookEvidence = Readonly<{
  entityId: string;
  pairId: string;
  tradeCount: number;
  bestBidPriceTicks: bigint | null;
  bestAskPriceTicks: bigint | null;
  liveOrderCount: number;
  digest: string;
}>;

const requireEntityId = (value: unknown, code: string): string => {
  if (typeof value !== 'string' || !ENTITY_ID.test(value)) throw new Error(code);
  return value;
};

const requirePairId = (value: unknown, code: string): string => {
  if (typeof value !== 'string' || !PAIR_ID.test(value)) throw new Error(code);
  return value;
};

const requireNullableBigInt = (value: unknown, code: string): bigint | null => {
  if (value === null || typeof value === 'bigint') return value;
  throw new Error(code);
};

export const decodeSettlementBookRequest = (value: unknown): SettlementBookRequest => {
  const request = requireBoundaryRecord(value, 'RADAPTER_SETTLEMENT_BOOK_REQUEST_INVALID');
  requireExactBoundaryKeys(
    request,
    ['entityId', 'pairId'],
    [],
    'RADAPTER_SETTLEMENT_BOOK_REQUEST_FIELDS_INVALID',
  );
  return {
    entityId: requireEntityId(request['entityId'], 'RADAPTER_SETTLEMENT_BOOK_REQUEST_ENTITY_INVALID'),
    pairId: requirePairId(request['pairId'], 'RADAPTER_SETTLEMENT_BOOK_REQUEST_PAIR_INVALID'),
  };
};

export const buildSettlementBookEvidence = (
  env: RuntimeReplica,
  request: SettlementBookRequest,
): SettlementBookEvidence => {
  const entity = getEntityReplicaById(env, request.entityId);
  const book = entity?.state.orderbookExt?.books.get(request.pairId);
  if (!book) throw new Error(`RADAPTER_SETTLEMENT_BOOK_NOT_FOUND:${request.entityId}:${request.pairId}`);
  const digest = keccak256(toUtf8Bytes(safeStringify({
    pairId: request.pairId,
    params: book.params,
    bidRoot: book.bidPages.rootHash(),
    askRoot: book.askPages.rootHash(),
    nextSeq: book.nextSeq,
    tradeCount: book.tradeCount,
    tradeQtySum: book.tradeQtySum,
    lastTradePriceTicks: book.lastTradePriceTicks,
    lastAcceptedUsdAskPriceTicks: book.lastAcceptedUsdAskPriceTicks,
    eventHash: book.eventHash,
  })));
  return {
    entityId: request.entityId,
    pairId: request.pairId,
    tradeCount: book.tradeCount,
    bestBidPriceTicks: getBestBid(book),
    bestAskPriceTicks: getBestAsk(book),
    liveOrderCount: book.orders.size,
    digest,
  };
};

export const decodeSettlementBookEvidence = (value: unknown): SettlementBookEvidence => {
  const evidence = requireBoundaryRecord(value, 'RADAPTER_SETTLEMENT_BOOK_RESPONSE_INVALID');
  requireExactBoundaryKeys(evidence, [
    'entityId', 'pairId', 'tradeCount', 'bestBidPriceTicks', 'bestAskPriceTicks',
    'liveOrderCount', 'digest',
  ], [], 'RADAPTER_SETTLEMENT_BOOK_RESPONSE_FIELDS_INVALID');
  const digest = evidence['digest'];
  if (typeof digest !== 'string' || !HASH.test(digest)) {
    throw new Error('RADAPTER_SETTLEMENT_BOOK_RESPONSE_DIGEST_INVALID');
  }
  return {
    entityId: requireEntityId(evidence['entityId'], 'RADAPTER_SETTLEMENT_BOOK_RESPONSE_ENTITY_INVALID'),
    pairId: requirePairId(evidence['pairId'], 'RADAPTER_SETTLEMENT_BOOK_RESPONSE_PAIR_INVALID'),
    tradeCount: requireBoundaryInteger(evidence['tradeCount'], 'RADAPTER_SETTLEMENT_BOOK_RESPONSE_TRADE_COUNT_INVALID'),
    bestBidPriceTicks: requireNullableBigInt(evidence['bestBidPriceTicks'], 'RADAPTER_SETTLEMENT_BOOK_RESPONSE_BID_INVALID'),
    bestAskPriceTicks: requireNullableBigInt(evidence['bestAskPriceTicks'], 'RADAPTER_SETTLEMENT_BOOK_RESPONSE_ASK_INVALID'),
    liveOrderCount: requireBoundaryInteger(evidence['liveOrderCount'], 'RADAPTER_SETTLEMENT_BOOK_RESPONSE_LIVE_COUNT_INVALID'),
    digest,
  };
};

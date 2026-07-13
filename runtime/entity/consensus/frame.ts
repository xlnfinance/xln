import { ethers } from 'ethers';
import type { AccountTx, EntityState, EntityTx } from '../../types';
import { HEAVY_LOGS } from '../../utils';
import { createStructuredLogger, shortHash, shortId } from '../../infra/logger';
import { safeStringify } from '../../protocol/serialization';
import { compareCanonicalText } from '../../orderbook/swap-execution';
import { canonicalJurisdictionEventsHash } from '../../jurisdiction/event-observation';
import { normalizeJurisdictionEvents } from '../../jurisdiction/event-normalization';
import { canonicalAccountTxForFrameHash } from '../../account/consensus/frame';
import { computeAccountShadowRoot } from '../../account/state-root';

export type EntityFrameHashDebugRecord = {
  entityId: string;
  height: number;
  hash: string;
  payload: unknown;
};

let frameHashDebugRecorder: ((record: EntityFrameHashDebugRecord) => void) | null = null;
const entityFrameLog = createStructuredLogger('entity.frame');

export function setEntityFrameHashDebugRecorder(
  recorder: ((record: EntityFrameHashDebugRecord) => void) | null,
): () => void {
  const previous = frameHashDebugRecorder;
  frameHashDebugRecorder = recorder;
  return () => {
    frameHashDebugRecorder = previous;
  };
}

const compareNumericKey = (
  left: string | number,
  right: string | number,
): number => {
  const leftNum = Number(left);
  const rightNum = Number(right);
  if (Number.isFinite(leftNum) && Number.isFinite(rightNum) && leftNum !== rightNum) {
    return leftNum - rightNum;
  }
  return compareCanonicalText(String(left), String(right));
};

const toRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const toInt = (value: unknown): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.floor(n) : 0;
};

const rawJEvents = (data: Record<string, unknown>): unknown[] =>
  Array.isArray(data['events'])
    ? data['events']
    : data['event'] !== undefined
      ? [data['event']]
      : [];

const canonicalEventsForFrameHash = (data: Record<string, unknown>): Array<Record<string, unknown>> =>
  normalizeJurisdictionEvents(rawJEvents(data)).map((event) => ({
    blockNumber: event.blockNumber ?? null,
    blockHash: event.blockHash?.toLowerCase() ?? null,
    transactionHash: event.transactionHash?.toLowerCase() ?? null,
    logIndex: event.logIndex ?? null,
    eventIndex: event.eventIndex ?? null,
    type: event.type,
    data: event.data,
  }));

const canonicalJEventDataForFrameHash = (value: unknown): Record<string, unknown> => {
  const data = toRecord(value);
  if (!Array.isArray(data['blocks']) || data['rangeHash'] === undefined) {
    throw new Error('ENTITY_FRAME_J_EVENT_RANGE_REQUIRED');
  }
  const blocks = Array.isArray(data['blocks'])
    ? data['blocks'].map((rawBlock) => {
        const block = toRecord(rawBlock);
        const blockEvents = canonicalEventsForFrameHash({ events: block['events'] });
        return {
          blockNumber: toInt(block['blockNumber']),
          blockHash: String(block['blockHash'] ?? '').toLowerCase(),
          eventsHash: String(block['eventsHash'] ?? '').toLowerCase(),
          events: blockEvents,
          disputeFinalizationEvidenceHash: String(block['disputeFinalizationEvidenceHash'] ?? '').toLowerCase(),
        };
      })
    : [];
  return {
    version: 'xln:j-event-range-frame:v1',
    from: String(data['from'] ?? '').toLowerCase(),
    jurisdictionRef: String(data['jurisdictionRef'] ?? '').trim().toLowerCase(),
    baseHeight: toInt(data['baseHeight']),
    scannedThroughHeight: toInt(data['scannedThroughHeight']),
    tipBlockHash: String(data['tipBlockHash'] ?? '').toLowerCase(),
    eventHistoryRoot: String(data['eventHistoryRoot'] ?? '').toLowerCase(),
    rangeHash: String(data['rangeHash'] ?? '').toLowerCase(),
    blocks,
    signature: String(data['signature'] ?? '').toLowerCase(),
    observedAt: toInt(data['observedAt']),
  };
};

const canonicalJEventAccountClaimDataForFrameHash = (value: unknown): Record<string, unknown> => {
  const data = toRecord(value);
  const events = canonicalEventsForFrameHash(data);
  const eventsHash = canonicalJurisdictionEventsHash(normalizeJurisdictionEvents(rawJEvents(data)));
  return {
    version: 'xln:j-event-account-claim-frame:v1',
    counterpartyEntityId: String(data['counterpartyEntityId'] ?? '').toLowerCase(),
    jHeight: toInt(data['jHeight']),
    eventsHash,
    events,
    observedAt: toInt(data['observedAt']),
  };
};

const canonicalNestedAccountFrameForFrameHash = (value: unknown): unknown => {
  const frame = toRecord(value);
  if (!Array.isArray(frame['accountTxs'])) return value;
  return {
    ...frame,
    accountTxs: frame['accountTxs'].map((tx) => canonicalAccountTxForFrameHash(tx as AccountTx)),
  };
};

const canonicalAccountInputForFrameHash = (value: unknown): Record<string, unknown> => {
  const data = toRecord(value);
  return {
    ...data,
    ...(data['proposal'] !== undefined
      ? {
          proposal: {
            ...toRecord(data['proposal']),
            frame: canonicalNestedAccountFrameForFrameHash(toRecord(data['proposal'])['frame']),
          },
        }
      : {}),
  };
};

const canonicalExternalWalletForFrameHash = (
  wallet: NonNullable<EntityState['externalWallet']>,
): Record<string, unknown> => ({
  balances: Array.from(wallet.balances.entries())
    .sort((a, b) => compareCanonicalText(a[0], b[0]))
    .map(([owner, balances]) => [
      owner,
      Array.from(balances.entries())
        .sort((a, b) => compareCanonicalText(a[0], b[0]))
        .map(([key, record]) => [
          key,
          {
            tokenAddress: String(record.tokenAddress || '').toLowerCase(),
            ...(record.tokenId !== undefined ? { tokenId: Number(record.tokenId) } : {}),
            balance: record.balance.toString(),
            jHeight: Number(record.jHeight),
            ...(record.transactionHash ? { transactionHash: record.transactionHash } : {}),
          },
        ]),
    ]),
  allowances: Array.from(wallet.allowances.entries())
    .sort((a, b) => compareCanonicalText(a[0], b[0]))
    .map(([owner, allowances]) => [
      owner,
      Array.from(allowances.entries())
        .sort((a, b) => compareCanonicalText(a[0], b[0]))
        .map(([key, record]) => [
          key,
          {
            tokenAddress: String(record.tokenAddress || '').toLowerCase(),
            spender: String(record.spender || '').toLowerCase(),
            allowance: record.allowance.toString(),
            jHeight: Number(record.jHeight),
            ...(record.transactionHash ? { transactionHash: record.transactionHash } : {}),
          },
        ]),
    ]),
});

const canonicalEntityTxForFrameHash = (tx: EntityTx): Record<string, unknown> => {
  if (tx.type === 'j_event') {
    return { type: tx.type, data: canonicalJEventDataForFrameHash(tx.data) };
  }
  if (tx.type === 'j_event_account_claim') {
    return { type: tx.type, data: canonicalJEventAccountClaimDataForFrameHash(tx.data) };
  }
  if (tx.type === 'accountInput') {
    return { type: tx.type, data: canonicalAccountInputForFrameHash(tx.data) };
  }
  return {
    type: tx.type,
    data: tx.data,
  };
};

// Entity-frame hashes are BFT commitments. Validators recompute the frame from
// txs and sign only if their locally derived state hashes to the proposal hash.
export async function createEntityFrameHash(
  prevFrameHash: string,
  height: number,
  timestamp: number,
  txs: EntityTx[],
  newState: EntityState,
): Promise<string> {
  if (HEAVY_LOGS) {
    const accountSnapshot = Array.from(newState.accounts.entries())
      .sort((a, b) => compareCanonicalText(a[0], b[0]))
      .map(([cpId, acct]) => ({
        cpId: shortId(cpId, 8),
        height: acct.currentHeight,
        stateHash: shortHash(acct.currentFrame?.stateHash || 'genesis'),
        mempoolSize: acct.mempool.length,
        pendingFrame: acct.pendingFrame?.height ?? null,
      }));
    entityFrameLog.debug('frame_hash.input', {
      height,
      prevFrameHash: shortHash(prevFrameHash, 12),
      accounts: accountSnapshot,
    });
  }

  const frameData = {
    prevFrameHash,
    height,
    timestamp,
    txs: txs.map(canonicalEntityTxForFrameHash),
    entityId: newState.entityId,
    leaderState: newState.leaderState ?? {
      activeValidatorId: newState.config.validators[0],
      view: 0,
      changedAtHeight: 0,
    },
    reserves: Array.from(newState.reserves.entries())
      .sort((a, b) => compareNumericKey(a[0], b[0]))
      .map(([k, v]) => [k, v.toString()]),
    ...(newState.externalWallet
      ? {
          externalWalletHash: ethers.keccak256(ethers.toUtf8Bytes(
            safeStringify(canonicalExternalWalletForFrameHash(newState.externalWallet)),
          )),
        }
      : {}),
    lastFinalizedJHeight: newState.lastFinalizedJHeight,
    jHistoryFinality: newState.jHistoryFinality ?? null,
    accountHashes: Array.from(newState.accounts.entries())
      .sort((a, b) => compareCanonicalText(a[0], b[0]))
      .map(([cpId, acct]) => ({
        cpId,
        height: acct.currentHeight,
        stateHash: acct.currentFrame?.stateHash || 'genesis',
      })),
    accountShadowRoot: computeAccountShadowRoot(newState.accounts),
    lendingHash: newState.lending
      ? ethers.keccak256(ethers.toUtf8Bytes(safeStringify(newState.lending)))
      : null,
    htlcRoutesHash: newState.htlcRoutes.size > 0
      ? ethers.keccak256(ethers.toUtf8Bytes(safeStringify(
          Array.from(newState.htlcRoutes.entries())
            .sort((a, b) => compareCanonicalText(String(a[0]), String(b[0]))),
        )))
      : null,
    htlcFeesEarned: newState.htlcFeesEarned.toString(),
    lockBookHash: newState.lockBook.size > 0
      ? ethers.keccak256(ethers.toUtf8Bytes(safeStringify(
          Array.from(newState.lockBook.entries())
            .sort((a, b) => compareCanonicalText(String(a[0]), String(b[0]))),
        )))
      : null,
    orderbookHash: newState.orderbookExt
      ? ethers.keccak256(ethers.toUtf8Bytes(safeStringify(newState.orderbookExt)))
      : null,
    swapTradingPairs: Array.isArray(newState.swapTradingPairs)
      ? [...newState.swapTradingPairs]
          .map(pair => ({
            baseTokenId: Number(pair.baseTokenId),
            quoteTokenId: Number(pair.quoteTokenId),
            pairId: String(pair.pairId || ''),
          }))
          .sort((a, b) => {
            if (a.quoteTokenId !== b.quoteTokenId) return a.quoteTokenId - b.quoteTokenId;
            if (a.baseTokenId !== b.baseTokenId) return a.baseTokenId - b.baseTokenId;
            return compareCanonicalText(a.pairId, b.pairId);
          })
      : [],
  };

  const encoded = safeStringify(frameData);
  const hash = ethers.keccak256(ethers.toUtf8Bytes(encoded));
  if (frameHashDebugRecorder) {
    frameHashDebugRecorder({
      entityId: newState.entityId,
      height,
      hash,
      payload: JSON.parse(encoded),
    });
  }
  return hash;
}

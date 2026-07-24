import { createEmptyAccountJClaimAccumulator } from '../../account/j-claim-accumulator';
import { EMPTY_ACCOUNT_STATE_ROOT } from '../../account/state-root';
import { applyCommand, createBook, type BookState } from '../../orderbook';
import { encodeBuffer } from '../../storage/codec';
import { STORAGE_MAX_PHYSICAL_VALUE_BYTES } from '../../storage/rebranched-db';
import type { StorageAccountDoc, StorageEntityCoreDoc } from '../../storage/types';

export const storageEntityId = `0x${'11'.repeat(32)}`;
export const storageCounterpartyId = `0x${'22'.repeat(32)}`;
export const storagePairId = 'testnet:2/tron:1';

const entityDoc = (bioLength: number): StorageEntityCoreDoc => ({
  entityId: storageEntityId,
  height: 7,
  timestamp: 7_000,
  messages: [],
  nonces: new Map(),
  proposals: new Map(),
  config: {
    mode: 'proposer-based',
    threshold: 1n,
    validators: [storageEntityId],
    shares: { [storageEntityId]: 1n },
  },
  reserves: new Map([[1, 1n]]),
  lastFinalizedJHeight: 0,
  jBlockChain: [],
  profile: {
    name: 'typed-rebranch',
    isHub: true,
    avatar: '',
    bio: 'e'.repeat(bioLength),
    website: '',
  },
  htlcRoutes: new Map(),
  htlcFeesEarned: 0n,
  lockBook: new Map(),
});

export const entityDocWithEncodedSize = (targetBytes: number): StorageEntityCoreDoc => {
  let low = 0;
  let high = targetBytes * 2;
  while (low <= high) {
    const bioLength = Math.floor((low + high) / 2);
    const doc = entityDoc(bioLength);
    const encodedBytes = encodeBuffer(doc).byteLength;
    if (encodedBytes === targetBytes) return doc;
    if (encodedBytes < targetBytes) low = bioLength + 1;
    else high = bioLength - 1;
  }
  throw new Error(`TEST_ENTITY_ENCODED_SIZE_UNREACHABLE:${targetBytes}`);
};

export const oversizedBook = (): BookState => {
  const book = createBook({ bucketWidthTicks: 100n, maxOrders: 1_000, stpPolicy: 0 });
  for (let index = 0; index < 64; index += 1) {
    const result = applyCommand(book, {
      kind: 0,
      ownerId: storageEntityId,
      orderId: `order-${index}-${'b'.repeat(120)}`,
      side: 0,
      tif: 0,
      postOnly: false,
      priceTicks: 10_000n + BigInt(index),
      qtyLots: 1n,
    });
    if (result.events.some(event => event.type === 'REJECT')) {
      throw new Error(`TEST_BOOK_ORDER_REJECTED:${index}`);
    }
  }
  if (encodeBuffer(book).byteLength < STORAGE_MAX_PHYSICAL_VALUE_BYTES) {
    throw new Error('TEST_BOOK_NOT_OVERSIZED');
  }
  return book;
};

export const oversizedAccount = (): StorageAccountDoc => ({
  leftEntity: storageEntityId,
  rightEntity: storageCounterpartyId,
  domain: {
    chainId: 31_337,
    depositoryAddress: `0x${'33'.repeat(20)}`,
  },
  watchSeed: `0x${'44'.repeat(32)}`,
  status: 'active',
  mempool: [],
  currentFrame: {
    height: 0,
    timestamp: 0,
    jHeight: 0,
    accountTxs: [],
    prevFrameHash: '',
    accountStateRoot: EMPTY_ACCOUNT_STATE_ROOT,
    deltas: [],
    stateHash: '',
    byLeft: true,
  },
  deltas: new Map(),
  locks: new Map(),
  swapOffers: new Map(),
  pulls: new Map(),
  globalCreditLimits: { ownLimit: 0n, peerLimit: 0n },
  currentHeight: 0,
  pendingSignatures: [],
  hankoSignature: 'h'.repeat(24_000),
  rollbackCount: 0,
  leftPendingJClaims: createEmptyAccountJClaimAccumulator(),
  rightPendingJClaims: createEmptyAccountJClaimAccumulator(),
  lastFinalizedJHeight: 0,
  proofHeader: {
    fromEntity: storageEntityId,
    toEntity: storageCounterpartyId,
    nextProofNonce: 1,
  },
  proofBody: { tokenIds: [], deltas: [] },
  disputeConfig: { leftDisputeDelay: 576, rightDisputeDelay: 576 },
  jNonce: 0,
  pendingWithdrawals: new Map(),
  requestedRebalance: new Map(),
  requestedRebalanceFeeState: new Map(),
  shadow: { rebalance: { policy: new Map(), submittedAtByToken: new Map() } },
});

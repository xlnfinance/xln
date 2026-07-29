import { describe, expect, test } from 'bun:test';

import { createFrameHash } from '../account/consensus/frame';
import {
  createEntityFrameHash,
  createEntityFrameHashFromStateRoot,
} from '../entity/consensus/frame';
import {
  buildEntityFrameAuthority,
  computeCanonicalEntityConsensusStateHash,
  computeEntityFrameAuthorityRoot,
} from '../entity/consensus/state-root';
import type { AccountFrame } from '../types/account';
import type { EntityState } from '../entity/types';
import type { EntityTx } from '../types/entity-tx';

// Intentional testnet reset: Account frame/state integrity commitments use the
// native-SHA integrity helper; Ethereum-facing proof hashes remain Keccak.
const ACCOUNT_FRAME_GOLDEN_HASH = '0x15cd826cf4c3d968ec506d1ec758c7529963079ca1fcaeb4b29a0fa1d4c0c7b0';
// Independently calculated with a standalone tagged-tuple reference encoder.
// Keep these literal so changing the production codec cannot bless itself.
// Intentional testnet reset: Entity Accounts are committed through the
// persistent radix-Merkle section. Every projected AccountReplica leaf remains
// bound, while unchanged accounts no longer require O(total accounts) hashing.
const ENTITY_STATE_ROOT_GOLDEN_HASH = '0x71ad20cd92f748524f8a14f447a24518465511fb6bfbc95d153d0181230b6509';
const ENTITY_AUTHORITY_ROOT_GOLDEN_HASH = '0xa7c4fd7139d47d2567c6a97c7d7d06bc6d60fc4481acbe8155584f3573b520bd';
const ENTITY_FRAME_GOLDEN_HASH = '0x26f4b8223b76f72b13abadead0e98187d1f0cbd00b4215dc9fc310b5bcaa6c6d';

const makeAccountFrameFixture = (): AccountFrame => ({
  height: 7,
  timestamp: 1_700_000_000_123,
  jHeight: 42,
  byLeft: true,
  prevFrameHash: `0x${'11'.repeat(32)}`,
  accountStateRoot: `0x${'33'.repeat(32)}`,
  accountTxs: [
    { type: 'set_credit_limit', data: { tokenId: 1, amount: 1234n } } as any,
    { type: 'direct_payment', data: { tokenId: 1, amount: 55n, nonce: 'payment-1' } } as any,
  ],
  deltas: [{
    tokenId: 1,
    collateral: 1000n,
    ondelta: 10n,
    offdelta: -55n,
    leftCreditLimit: 5000n,
    rightCreditLimit: 3000n,
    leftAllowance: 100n,
    rightAllowance: 200n,
    leftHold: 7n,
    rightHold: 9n,
  }],
  stateHash: '',
});

const makeEntityStateFixture = (accountHash: string): EntityState => ({
  entityId: `0x${'aa'.repeat(32)}`,
  height: 3,
  timestamp: 1_700_000_000_123,
  nonces: new Map(),
  proposals: new Map(),
  config: {
    mode: 'proposer-based',
    threshold: 1n,
    validators: [`0x${'01'.repeat(20)}`],
    shares: { [`0x${'01'.repeat(20)}`]: 1n },
  },
  reserves: new Map([[1, 123456n], [2, 789n]]),
  accounts: new Map([[
    `0x${'bb'.repeat(32)}`,
    {
      status: 'active',
      currentHeight: 7,
      currentFrame: { stateHash: accountHash },
      mempool: [],
      pendingWithdrawals: new Map(),
      shadow: { rebalance: { policy: new Map(), submittedAtByToken: new Map() } },
    } as any,
  ]]),
  deferredAccountProposals: new Map(),
  lastFinalizedJHeight: 42,
  jBlockChain: [],
  profile: { name: 'Golden Entity', isHub: true, avatar: '', bio: '', website: '' },
  htlcRoutes: new Map(),
  htlcFeesEarned: 12n,
  lockBook: new Map(),
  swapTradingPairs: [{ baseTokenId: 1, quoteTokenId: 2, pairId: '1/2' }],
});

describe('frame hash golden fixtures', () => {
  test('account frame hash stays byte-for-byte stable', async () => {
    await expect(createFrameHash(makeAccountFrameFixture())).resolves.toBe(ACCOUNT_FRAME_GOLDEN_HASH);
  });

  test('entity frame hash stays byte-for-byte stable', async () => {
    const accountFrame = makeAccountFrameFixture();
    const accountHash = await createFrameHash(accountFrame);
    const entityTxs: EntityTx[] = [{
      type: 'accountInput',
      data: {
        kind: 'frame',
        fromEntityId: `0x${'aa'.repeat(32)}`,
        toEntityId: `0x${'bb'.repeat(32)}`,
        proposal: { frame: accountFrame, frameHanko: '0x1234' },
      },
    } as any];

    const entityState = makeEntityStateFixture(accountHash);
    expect(computeCanonicalEntityConsensusStateHash(entityState)).toBe(ENTITY_STATE_ROOT_GOLDEN_HASH);
    expect(computeEntityFrameAuthorityRoot(buildEntityFrameAuthority(entityState))).toBe(
      ENTITY_AUTHORITY_ROOT_GOLDEN_HASH,
    );

    const frameHash = await createEntityFrameHash(
      `0x${'22'.repeat(32)}`,
      4,
      1_700_000_000_456,
      entityTxs,
      entityState,
    );
    expect(frameHash).toBe(ENTITY_FRAME_GOLDEN_HASH);

    // Isolate the canonical v1 authority commitment: state root, events, tx bytes and
    // every other frame field stay fixed while only authorityRoot is corrupt.
    const authorityTamperedHash = createEntityFrameHashFromStateRoot(
      `0x${'22'.repeat(32)}`,
      4,
      1_700_000_000_456,
      entityTxs,
      [],
      entityState.entityId,
      ENTITY_STATE_ROOT_GOLDEN_HASH,
      `0x${'ff'.repeat(32)}`,
    );
    expect(authorityTamperedHash).not.toBe(ENTITY_FRAME_GOLDEN_HASH);
  });
});

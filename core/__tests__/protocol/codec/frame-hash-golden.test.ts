import { describe, expect, test } from 'bun:test';

import { computeFrameHash } from '../../../account/consensus/frame/hash';
import {
  createEntityFrameHashFromStateRoot,
} from '../../../entity/consensus/frame';
import type { AccountFrame, AccountTx } from '../../../types/account';
import type { EntityState } from '../../../entity/types';
import type { EntityTx } from '../../../types/entity-tx';
import type { EntityInfraContext } from '../../../types/entity/infra-context';
import { makeAccount } from '../../helpers/cross-j';

// Intentional testnet reset: Account frame/state integrity commitments use the
// native-SHA integrity helper; Ethereum-facing proof hashes remain Keccak.
const ACCOUNT_FRAME_GOLDEN_HASH = '0x48209002630a2dae349c0ec270c3668afd11e7bad2970121e24d7af157fdc75b';
// Protocol-34 reset after removing duplicate AccountFrame financial/role fields.
// Keep these literal so later codec changes remain explicit protocol changes.
// Intentional testnet reset: Entity Accounts are committed through the
// persistent radix-Merkle section. Every projected AccountReplica leaf remains
// bound, while unchanged accounts no longer require O(total accounts) hashing.
const ENTITY_STATE_ROOT_GOLDEN_HASH = '0x9b55ab751f698879e3215f49008d58305333e699fd7aaaeba87c5eb057206a9c';
const ENTITY_AUTHORITY_ROOT_GOLDEN_HASH = '0xa7c4fd7139d47d2567c6a97c7d7d06bc6d60fc4481acbe8155584f3573b520bd';
// Intentional testnet reset: the canonical Entity frame commits the exact infra context,
// while Entity state commits its shared encryption public key.
const ENTITY_FRAME_GOLDEN_HASH = '0x6c145c7ba53b115383a46279c19d65feb067497bde1ccc7c4d131090ee942cbe';

const makeEntityContextFixture = (): EntityInfraContext => ({
  version: 1,
  proposerReplicaId: `0x${'aa'.repeat(32)}:0x${'01'.repeat(20)}`,
  entityId: `0x${'aa'.repeat(32)}`,
  proposerSignerId: `0x${'01'.repeat(20)}`,
  parentFrameHash: `0x${'22'.repeat(32)}`,
  height: 4,
  gossipProfiles: [],
  peerAssertions: [],
  htlc: { version: 1, entries: [], originated: [] },
});

const makeAccountFrameFixture = (): AccountFrame => ({
  height: 7,
  timestamp: 1_700_000_000_123,
  jHeight: 42,
  prevFrameHash: `0x${'11'.repeat(32)}`,
  accountStateRoot: `0x${'33'.repeat(32)}`,
  accountTxs: [
    { type: 'set_credit_limit', data: { tokenId: 1, amount: 1234n } } as any,
    { type: 'direct_payment', data: { tokenId: 1, amount: 55n, nonce: 'payment-1' } } as any,
  ],
  stateHash: '',
});

const makeEntityStateFixture = (accountHash: string): EntityState => ({
  entityId: `0x${'aa'.repeat(32)}`,
  entityEncryptionPublicKey: `0x${'55'.repeat(32)}`,
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
  accounts: new Map([(() => {
    const counterpartyId = `0x${'bb'.repeat(32)}`;
    const account = makeAccount(`0x${'aa'.repeat(32)}`, counterpartyId);
    account.currentHeight = 7;
    account.currentFrame = { ...makeAccountFrameFixture(), stateHash: accountHash };
    return [counterpartyId, account] as const;
  })()]),
  deferredAccountProposals: new Map(),
  lastFinalizedJHeight: 42,
  profile: { name: 'Golden Entity', isHub: true, avatar: '', bio: '', website: '' },
  htlcRoutes: new Map(),
  htlcFeesEarned: 12n,
  lockBook: new Map(),
  swapTradingPairs: [{ baseTokenId: 1, quoteTokenId: 2, pairId: '1/2' }],
});

describe('frame hash golden fixtures', () => {
  test('account frame hash stays byte-for-byte stable', async () => {
    expect(computeFrameHash(makeAccountFrameFixture())).toBe(ACCOUNT_FRAME_GOLDEN_HASH);
  });

  test('account frame hash binds settlement authority target but not quorum subset bytes', async () => {
    const settlement = {
      type: 'settle_transition',
      data: {
        kind: 'hanko',
        revision: 1,
        workspaceHash: `0x${'61'.repeat(32)}`,
        settlementNonce: 2,
        settlementHash: `0x${'62'.repeat(32)}`,
        settlementHanko: '0xfirst-quorum',
        postProof: {
          nonce: 3,
          proposerIsLeft: true,
          proofBodyHash: `0x${'63'.repeat(32)}`,
          disputeHash: `0x${'64'.repeat(32)}`,
          hanko: '0xfirst-proof-quorum',
        },
      },
    } satisfies Extract<AccountTx, { type: 'settle_transition' }>;
    const first = makeAccountFrameFixture();
    first.accountTxs = [settlement];
    const second = structuredClone(first);
    const secondHankoTx = second.accountTxs[0];
    if (secondHankoTx?.type !== 'settle_transition' || secondHankoTx.data.kind !== 'hanko') {
      throw new Error('SETTLEMENT_HANKO_FIXTURE_INVALID');
    }
    secondHankoTx.data.settlementHanko = '0xsecond-quorum';
    secondHankoTx.data.postProof.hanko = '0xsecond-proof-quorum';
    expect(computeFrameHash(second)).toBe(computeFrameHash(first));

    secondHankoTx.data.settlementHash = `0x${'65'.repeat(32)}`;
    expect(computeFrameHash(second)).not.toBe(computeFrameHash(first));
  });

  test('receiving Entity frame commits exact external settlement Hanko bytes in one round', async () => {
    const peerFrame = makeAccountFrameFixture();
    peerFrame.accountTxs = [{
      type: 'settle_transition',
      data: {
        kind: 'hanko',
        revision: 1,
        workspaceHash: `0x${'71'.repeat(32)}`,
        settlementNonce: 1,
        settlementHash: `0x${'72'.repeat(32)}`,
        settlementHanko: '0xpeer-subset-a',
        postProof: {
          nonce: 2,
          proposerIsLeft: false,
          proofBodyHash: `0x${'73'.repeat(32)}`,
          disputeHash: `0x${'74'.repeat(32)}`,
          hanko: '0xpeer-proof-a',
        },
      },
    }];
    peerFrame.stateHash = computeFrameHash(peerFrame);
    const txs: EntityTx[] = [{
      type: 'accountInput',
      data: {
        kind: 'frame',
        fromEntityId: `0x${'bb'.repeat(32)}`,
        toEntityId: `0x${'aa'.repeat(32)}`,
        proposal: { frame: peerFrame, frameHanko: '0xpeer-frame' },
      },
    } as EntityTx];
    const hash = (input: EntityTx[]): string => createEntityFrameHashFromStateRoot(
      `0x${'22'.repeat(32)}`,
      4,
      1_700_000_000_456,
      input,
      [],
      `0x${'aa'.repeat(32)}`,
      `0x${'31'.repeat(32)}`,
      `0x${'32'.repeat(32)}`,
      makeEntityContextFixture(),
    );
    const changed = structuredClone(txs);
    const changedInput = changed[0];
    if (changedInput?.type !== 'accountInput' || changedInput.data.kind !== 'frame') {
      throw new Error('EXTERNAL_SETTLEMENT_HANKO_FIXTURE_INVALID');
    }
    const hankoTx = changedInput.data.proposal.frame.accountTxs[0];
    if (hankoTx?.type !== 'settle_transition' || hankoTx.data.kind !== 'hanko') {
      throw new Error('EXTERNAL_SETTLEMENT_HANKO_FIXTURE_INVALID');
    }
    hankoTx.data.settlementHanko = '0xpeer-subset-b';
    expect(hash(changed)).not.toBe(hash(txs));
  });

  test('entity frame hash stays byte-for-byte stable', async () => {
    const accountFrame = makeAccountFrameFixture();
    const accountHash = computeFrameHash(accountFrame);
    accountFrame.stateHash = accountHash;
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
    const frameHash = createEntityFrameHashFromStateRoot(
      `0x${'22'.repeat(32)}`,
      4,
      1_700_000_000_456,
      entityTxs,
      [],
      entityState.entityId,
      ENTITY_STATE_ROOT_GOLDEN_HASH,
      ENTITY_AUTHORITY_ROOT_GOLDEN_HASH,
      makeEntityContextFixture(),
    );
    expect(frameHash).toBe(ENTITY_FRAME_GOLDEN_HASH);

    const changedPeerInput = structuredClone(entityTxs);
    const changed = changedPeerInput[0];
    if (changed?.type !== 'accountInput' || changed.data.kind !== 'frame') {
      throw new Error('ENTITY_PEER_HANKO_FIXTURE_INVALID');
    }
    changed.data.proposal.frameHanko = '0x5678';
    expect(createEntityFrameHashFromStateRoot(
      `0x${'22'.repeat(32)}`,
      4,
      1_700_000_000_456,
      changedPeerInput,
      [],
      entityState.entityId,
      ENTITY_STATE_ROOT_GOLDEN_HASH,
      ENTITY_AUTHORITY_ROOT_GOLDEN_HASH,
      makeEntityContextFixture(),
    )).not.toBe(frameHash);

    // Isolate the canonical context + authority commitment: state root, events, tx bytes and
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
      makeEntityContextFixture(),
    );
    expect(authorityTamperedHash).not.toBe(ENTITY_FRAME_GOLDEN_HASH);
  });
});

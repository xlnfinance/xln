import { expect, test } from 'bun:test';

import { assertAccountFrameHash, computeFrameHash } from '../../../account/consensus/frame/hash';
import { createEntityFrameHashFromStateRoot } from '../../../entity/consensus/frame';
import { canonicalAccountInputCommitment } from '../../../entity/consensus/frame/account-input-commitment';
import {
  assertCertifiedOutputSemanticIdentity,
  getRawAccountOutputTx,
} from '../../../entity/consensus/output/certification';
import { encodeCanonicalConsensusValue } from '../../../protocol/serialization/canonical-consensus-value';
import type { AccountFrame } from '../../../types/account';
import type { ConsensusOutputOrigin, EntityTx } from '../../../types/entity-tx';
import type { EntityInfraContext } from '../../../types/entity/infra-context';

const HASH_A = `0x${'11'.repeat(32)}`;
const HASH_B = `0x${'22'.repeat(32)}`;
const STATE_ROOT = `0x${'33'.repeat(32)}`;
const ENTITY = `0x${'aa'.repeat(32)}`;
const PEER = `0x${'bb'.repeat(32)}`;

const entityContext = (): EntityInfraContext => ({
  version: 1,
  proposerReplicaId: `${ENTITY}:0x${'01'.repeat(20)}`,
  entityId: ENTITY,
  proposerSignerId: `0x${'01'.repeat(20)}`,
  parentFrameHash: HASH_A,
  height: 4,
  gossipProfiles: [],
  peerAssertions: [],
  htlc: { version: 1, entries: [], originated: [] },
});

const fatOffer = (offerId: string) => ({
  type: 'add_swap_intent',
  data: {
    offerId,
    giveTokenId: 1,
    giveAmount: 10n ** 18n,
    wantTokenId: 2,
    wantAmount: 2n * 10n ** 18n,
    padding: 'x'.repeat(256),
  },
});

const makeFrame = async (offerId: string): Promise<AccountFrame> => {
  const frame: AccountFrame = {
    height: 7,
    timestamp: 1_700_000_000_123,
    jHeight: 42,
    byLeft: true,
    prevFrameHash: HASH_A,
    accountStateRoot: STATE_ROOT,
    accountTxs: [fatOffer(offerId) as AccountFrame['accountTxs'][number]],
    deltas: [{
      tokenId: 1,
      collateral: 1000n,
      ondelta: 0n,
      offdelta: 0n,
      leftCreditLimit: 1n,
      rightCreditLimit: 1n,
      leftAllowance: 0n,
      rightAllowance: 0n,
      leftHold: 0n,
      rightHold: 0n,
    }],
    stateHash: '',
  };
  frame.stateHash = computeFrameHash(frame);
  return frame;
};

const frameInput = (frame: AccountFrame, frameHanko = '0xframe'): EntityTx => ({
  type: 'accountInput',
  data: {
    kind: 'frame',
    fromEntityId: PEER,
    toEntityId: ENTITY,
    domain: { chainId: 1, depositoryAddress: `0x${'cc'.repeat(20)}` },
    disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
    proposal: { frame, frameHanko },
  },
} as EntityTx);

const entityHash = (txs: EntityTx[]): string =>
  createEntityFrameHashFromStateRoot(
    HASH_A,
    4,
    1_700_000_000_456,
    txs,
    [],
    ENTITY,
    HASH_B,
    HASH_B,
    entityContext(),
  );

const genericOrigin = (semanticHash: string): ConsensusOutputOrigin => ({
  sourceEntityId: PEER,
  lane: 'generic',
  sequence: 7n,
  semanticHash,
  height: 4,
  frameHash: HASH_A,
  outputIndex: 0,
});

test('Entity frame hash binds Account stateHash not nested offer bodies', async () => {
  const left = await makeFrame('offer-a');
  const right = structuredClone(left);
  right.accountTxs = [fatOffer('offer-b') as AccountFrame['accountTxs'][number]];
  expect(left.stateHash).not.toBe(computeFrameHash(right));
  expect(() => assertAccountFrameHash(right, 'TAMPERED_BODY')).toThrow('TAMPERED_BODY');
  expect(entityHash([frameInput(left)])).toBe(entityHash([frameInput(right)]));
});

test('Entity frame hash changes when claimed stateHash changes', async () => {
  const frame = await makeFrame('offer-a');
  const tampered = structuredClone(frame);
  tampered.stateHash = HASH_B;
  expect(entityHash([frameInput(frame)])).not.toBe(entityHash([frameInput(tampered)]));
});

test('Entity frame hash binds inbound settlement Hanko bytes the Account merkle omits', async () => {
  const frame = await makeFrame('offer-a');
  frame.accountTxs.push({
    type: 'settle_transition',
    data: {
      kind: 'seal',
      revision: 1,
      workspaceHash: HASH_A,
      settlementNonce: 1,
      settlementHash: HASH_B,
      settlementHanko: '0xpeer-subset-a',
      postProof: {
        nonce: 2,
        proposerIsLeft: false,
        proofBodyHash: HASH_A,
        disputeHash: HASH_B,
        hanko: '0xpeer-proof-a',
      },
    },
  } as AccountFrame['accountTxs'][number]);
  frame.stateHash = computeFrameHash(frame);
  const changed = structuredClone(frame);
  const seal = changed.accountTxs[1];
  if (seal?.type !== 'settle_transition' || seal.data.kind !== 'seal') {
    throw new Error('SETTLEMENT_SEAL_FIXTURE_INVALID');
  }
  seal.data.settlementHanko = '0xpeer-subset-b';
  expect(computeFrameHash(changed)).toBe(frame.stateHash);
  expect(entityHash([frameInput(changed)])).not.toBe(entityHash([frameInput(frame)]));
});

test('commitment encoding of 100 fat frames stays off the nested offer bytes', async () => {
  const frames = await Promise.all(Array.from({ length: 100 }, (_, i) => makeFrame(`offer-${i}`)));
  const txs = frames.map(frame => frameInput(frame));
  const started = performance.now();
  const hash = entityHash(txs);
  const elapsedMs = performance.now() - started;
  expect(hash.startsWith('0x')).toBe(true);
  const encoded = encodeCanonicalConsensusValue(
    txs.map(tx => canonicalAccountInputCommitment(tx.data)),
  );
  expect(encoded.includes('offer-0')).toBe(false);
  expect(encoded.includes('x'.repeat(64))).toBe(false);
  expect(encoded.includes('0xframe')).toBe(true);
  expect(elapsedMs).toBeLessThan(50);
});

test('AccountInput is raw-only and can never regain an outer certified envelope', async () => {
  const tx = frameInput(await makeFrame('raw-only'));
  const output = { entityId: ENTITY, signerId: '0xsigner', entityTxs: [tx] };
  expect(getRawAccountOutputTx(PEER, output, 0)).toEqual(tx);
  expect(() => getRawAccountOutputTx(ENTITY, output, 0)).toThrow('ACCOUNT_OUTPUT_SOURCE_MISMATCH');
  expect(() => assertCertifiedOutputSemanticIdentity(
    genericOrigin(HASH_B),
    ENTITY,
    [tx],
  )).toThrow('CONSENSUS_OUTPUT_ACCOUNT_INPUT_FORBIDDEN');
});

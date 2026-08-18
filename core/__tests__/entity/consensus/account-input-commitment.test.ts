import { expect, test } from 'bun:test';

import { assertAccountFrameHash, createFrameHash } from '../../../account/consensus/frame/hash';
import { createEntityFrameHashFromStateRoot } from '../../../entity/consensus/frame';
import {
  canonicalAccountInputCommitment,
  canonicalConsensusOutputForEntityFrameHash,
  ENTITY_FRAME_ACCOUNT_INPUT_MODE,
  CERTIFIED_OUTPUT_ACCOUNT_INPUT_MODE,
} from '../../../entity/consensus/frame/account-input-commitment';
import {
  assertCertifiedNestedAccountFrames,
  hashCertifiedEntityOutput,
  hashCertifiedEntityOutputSemantic,
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
  frame.stateHash = await createFrameHash(frame);
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

const origin = (semanticHash: string): ConsensusOutputOrigin => ({
  sourceEntityId: PEER,
  lane: 'account-frame',
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
  expect(left.stateHash).not.toBe(await createFrameHash(right));
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
  frame.stateHash = await createFrameHash(frame);
  const changed = structuredClone(frame);
  const seal = changed.accountTxs[1];
  if (seal?.type !== 'settle_transition' || seal.data.kind !== 'seal') {
    throw new Error('SETTLEMENT_SEAL_FIXTURE_INVALID');
  }
  seal.data.settlementHanko = '0xpeer-subset-b';
  expect(await createFrameHash(changed)).toBe(frame.stateHash);
  expect(entityHash([frameInput(changed)])).not.toBe(entityHash([frameInput(frame)]));
});

test('certified output digest ignores nested offer bodies and envelope Hankos', async () => {
  const frame = await makeFrame('offer-a');
  const left = [frameInput(frame, '0xhanko-a')];
  const bodyTampered = structuredClone(frame);
  bodyTampered.accountTxs = [fatOffer('offer-b') as AccountFrame['accountTxs'][number]];
  const right = [frameInput(bodyTampered, '0xhanko-b')];
  const leftHash = hashCertifiedEntityOutputSemantic(PEER, ENTITY, 'account-frame', 7n, left);
  const rightHash = hashCertifiedEntityOutputSemantic(PEER, ENTITY, 'account-frame', 7n, right);
  expect(leftHash).toBe(rightHash);
  const outputLeft = hashCertifiedEntityOutput(origin(leftHash), ENTITY, left);
  const outputRight = hashCertifiedEntityOutput(origin(rightHash), ENTITY, right);
  expect(outputLeft).toBe(outputRight);
});

test('certified output digest still binds routing and claimed Account height', async () => {
  const frame = await makeFrame('offer-a');
  const base = [frameInput(frame)];
  const routed = structuredClone(base);
  if (routed[0]?.type !== 'accountInput') throw new Error('ACCOUNT_INPUT_FIXTURE_INVALID');
  routed[0].data.fromEntityId = ENTITY;
  expect(
    hashCertifiedEntityOutputSemantic(PEER, ENTITY, 'account-frame', 7n, routed),
  ).not.toBe(
    hashCertifiedEntityOutputSemantic(PEER, ENTITY, 'account-frame', 7n, base),
  );
});

test('local kind:txs bodies remain in the Entity frame digest', () => {
  const tx = (amount: bigint): EntityTx => ({
    type: 'accountInput',
    data: {
      kind: 'txs',
      fromEntityId: ENTITY,
      toEntityId: PEER,
      domain: { chainId: 1, depositoryAddress: `0x${'cc'.repeat(20)}` },
      disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
      txs: [{ type: 'direct_payment', data: { tokenId: 1, amount, nonce: 'p1' } }],
    },
  } as EntityTx);
  expect(entityHash([tx(1n)])).not.toBe(entityHash([tx(2n)]));
});

test('commitment encoding of 100 fat frames stays off the nested offer bytes', async () => {
  const frames = await Promise.all(Array.from({ length: 100 }, (_, i) => makeFrame(`offer-${i}`)));
  const txs = frames.map(frame => frameInput(frame));
  const started = performance.now();
  const hash = entityHash(txs);
  const elapsedMs = performance.now() - started;
  expect(hash.startsWith('0x')).toBe(true);
  const encoded = encodeCanonicalConsensusValue(
    txs.map(tx => canonicalAccountInputCommitment(tx.data, ENTITY_FRAME_ACCOUNT_INPUT_MODE)),
  );
  expect(encoded.includes('offer-0')).toBe(false);
  expect(encoded.includes('x'.repeat(64))).toBe(false);
  const certified = encodeCanonicalConsensusValue(
    txs.map(tx => canonicalAccountInputCommitment(tx.data, CERTIFIED_OUTPUT_ACCOUNT_INPUT_MODE)),
  );
  expect(certified.includes('0xframe')).toBe(false);
  expect(elapsedMs).toBeLessThan(50);
});

test('stolen Account body fails closed before certified consume', async () => {
  const honest = await makeFrame('offer-a');
  const stolen = structuredClone(honest);
  stolen.accountTxs = [fatOffer('offer-b') as AccountFrame['accountTxs'][number]];
  const honestTxs = [frameInput(honest)];
  const stolenTxs = [frameInput(stolen)];
  expect(
    hashCertifiedEntityOutputSemantic(PEER, ENTITY, 'account-frame', 7n, stolenTxs),
  ).toBe(
    hashCertifiedEntityOutputSemantic(PEER, ENTITY, 'account-frame', 7n, honestTxs),
  );
  expect(() => assertCertifiedNestedAccountFrames(honestTxs)).not.toThrow();
  expect(() => assertCertifiedNestedAccountFrames(stolenTxs)).toThrow('CONSENSUS_OUTPUT_ACCOUNT_FRAME_HASH_MISMATCH');
});

test('Entity frame hash of consensusOutput omits nested offer bytes', async () => {
  const frame = await makeFrame('offer-wrapped');
  const nested = [frameInput(frame)];
  const wrapper: EntityTx = {
    type: 'consensusOutput',
    data: {
      targetEntityId: ENTITY,
      entityTxs: nested,
      origin: origin(hashCertifiedEntityOutputSemantic(PEER, ENTITY, 'account-frame', 7n, nested)),
      outputHanko: '0xoutput',
    },
  } as EntityTx;
  const encoded = encodeCanonicalConsensusValue(canonicalConsensusOutputForEntityFrameHash(wrapper.data));
  expect(encoded.includes('offer-wrapped')).toBe(false);
  expect(entityHash([wrapper]).startsWith('0x')).toBe(true);
});

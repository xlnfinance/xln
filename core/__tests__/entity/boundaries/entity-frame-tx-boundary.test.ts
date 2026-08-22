import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { validateProposedEntityFrame, assertEstimatedSealedEntityFrameWire } from '../../../entity/consensus/frame/validation';
import { assertEntityFrameTotalByteBudget, createEntityFrameWirePrefixMeter, ENTITY_FRAME_WIRE_EVENT_SLACK_BYTES, measureEntityFrameWireBytes, selectEntityFrameTxPrefixForWireBudget } from '../../../entity/consensus/frame';
import { LIMITS } from '../../../config/constants';
import { encodeCanonicalConsensusValue } from '../../../protocol/serialization/canonical-consensus-value';

const entityId = `0x${'01'.repeat(32)}`;
const signerId = `0x${'02'.repeat(20)}`;
const emptyContext = {
  version: 1 as const,
  proposerReplicaId: `${entityId}:${signerId}`,
  entityId,
  proposerSignerId: signerId,
  parentFrameHash: 'genesis',
  height: 1,
  gossipProfiles: [],
  peerAssertions: [],
  htlc: { version: 1 as const, entries: [], originated: [] },
};

test('proposed Entity frames reject malformed transactions before replay', () => {
  const malformedFrame = {
    height: 1,
    parentFrameHash: 'genesis',
    stateRoot: `0x${'11'.repeat(32)}`,
    authorityRoot: `0x${'22'.repeat(32)}`,
    timestamp: 1,
    entityContext: emptyContext,
    txs: [{ type: 'chat', data: { from: 'validator-without-message' } }],
    events: [],
    hash: `0x${'33'.repeat(32)}`,
    leader: { proposerSignerId: signerId, view: 0 },
  };

  expect(() => validateProposedEntityFrame(malformedFrame, 'EntityFrame'))
    .toThrow('EntityFrame.txs_0_DATA_FIELDS');
});

test('Entity frame total byte budget rejects aggregate payloads', () => {
  const half = 'x'.repeat(Math.floor(LIMITS.MAX_FRAME_SIZE_BYTES / 2) + 1_000);
  expect(() => assertEntityFrameTotalByteBudget({
    prevFrameHash: 'genesis',
    height: 1,
    timestamp: 1,
    txs: [{ type: 'chat', data: { from: signerId, message: half } }],
    events: [{ type: 'status', message: half }],
    entityId,
    stateRoot: `0x${'11'.repeat(32)}`,
    authorityRoot: `0x${'22'.repeat(32)}`,
    entityContext: emptyContext,
  })).toThrow('ENTITY_FRAME_TOTAL_BYTE_LIMIT_EXCEEDED');
});

test('Entity frame wire selector defers the tail instead of overflowing', () => {
  const bulky = {
    ...emptyContext,
    gossipProfiles: [{ pad: 'x'.repeat(4_000) }],
  };
  const txs = [
    { type: 'chat' as const, data: { from: signerId, message: 'a'.repeat(2_000) } },
    { type: 'chat' as const, data: { from: signerId, message: 'b'.repeat(2_000) } },
  ];
  const rest = {
    prevFrameHash: 'genesis',
    height: 1,
    timestamp: 1,
    events: [] as const,
    entityId,
    stateRoot: `0x${'11'.repeat(32)}`,
    authorityRoot: `0x${'22'.repeat(32)}`,
    entityContext: bulky,
  };
  const one = measureEntityFrameWireBytes({ ...rest, txs: [txs[0]!] });
  const two = measureEntityFrameWireBytes({ ...rest, txs });
  expect(two).toBeGreaterThan(one);
  const selected = selectEntityFrameTxPrefixForWireBudget(txs, rest, Math.floor((one + two) / 2));
  expect(selected).toEqual([txs[0]]);
});

test('Entity frame wire prefix meter is byte-exact for every prefix', () => {
  const txs = [
    { type: 'chat' as const, data: { from: signerId, message: 'α'.repeat(37) } },
    { type: 'chat' as const, data: { from: signerId, message: 'b'.repeat(91) } },
  ];
  const rest = {
    prevFrameHash: 'genesis', height: 1, timestamp: 1, events: [] as const, entityId,
    stateRoot: `0x${'11'.repeat(32)}`, authorityRoot: `0x${'22'.repeat(32)}`,
    entityContext: { ...emptyContext, gossipProfiles: [{ pad: 'x'.repeat(257) }] },
  };
  const measurePrefix = createEntityFrameWirePrefixMeter(txs);
  for (let count = 0; count <= txs.length; count += 1) {
    expect(measurePrefix(rest, count)).toBe(
      measureEntityFrameWireBytes({ ...rest, txs: txs.slice(0, count) }),
    );
  }
});

test('proposed Entity frames require the exact signed-hash manifest', () => {
  const frameWithoutManifest = {
    height: 1,
    parentFrameHash: 'genesis',
    stateRoot: `0x${'11'.repeat(32)}`,
    authorityRoot: `0x${'22'.repeat(32)}`,
    timestamp: 1,
    entityContext: emptyContext,
    txs: [],
    events: [],
    hash: `0x${'33'.repeat(32)}`,
    leader: { proposerSignerId: signerId, view: 0 },
  };

  expect(() => validateProposedEntityFrame(frameWithoutManifest, 'EntityFrame'))
    .toThrow('EntityFrame.hashesToSign');
  expect(() => validateProposedEntityFrame({
    ...frameWithoutManifest,
    hashesToSign: [],
  }, 'EntityFrame')).toThrow('EntityFrame.hashesToSign cannot be empty');
});

test('Entity frame wire fit reserves a third of the 10 MB limit for apply-time events', () => {
  expect(ENTITY_FRAME_WIRE_EVENT_SLACK_BYTES).toBe(Math.floor(LIMITS.MAX_FRAME_SIZE_BYTES / 3));
});

test('sealed Entity frame wire errors name hashesToSign separately from the hash payload', () => {
  const pad = 'x'.repeat(LIMITS.MAX_FRAME_SIZE_BYTES);
  const frame = {
    height: 1,
    parentFrameHash: 'genesis',
    stateRoot: `0x${'11'.repeat(32)}`,
    authorityRoot: `0x${'22'.repeat(32)}`,
    timestamp: 1,
    entityContext: emptyContext,
    txs: [],
    events: [],
    hash: `0x${'33'.repeat(32)}`,
    leader: { proposerSignerId: signerId, view: 0 },
    hashesToSign: [{ hash: `0x${'44'.repeat(32)}`, type: 'entityFrame', context: pad }],
    collectedSigs: new Map([[signerId, [`0x${'55'.repeat(65)}`]]]),
  };
  expect(() => validateProposedEntityFrame(frame, 'EntityFrame')).toThrow(/hashesToSign=\d+:sigs=/);
});

test('unsigned Entity frames estimate sealed bytes before sign', () => {
  const pad = 'x'.repeat(LIMITS.MAX_FRAME_SIZE_BYTES);
  const frame = {
    height: 1,
    parentFrameHash: 'genesis',
    stateRoot: `0x${'11'.repeat(32)}`,
    authorityRoot: `0x${'22'.repeat(32)}`,
    timestamp: 1,
    entityContext: emptyContext,
    txs: [],
    events: [],
    hash: `0x${'33'.repeat(32)}`,
    leader: { proposerSignerId: signerId, view: 0 },
    hashesToSign: [{ hash: `0x${'44'.repeat(32)}`, type: 'entityFrame', context: pad }],
  };
  expect(() => assertEstimatedSealedEntityFrameWire(frame, signerId, true, 'SingleSignerEntityFrame'))
    .toThrow(/hashesToSign=\d+:sigs=/);
});

test('unsigned Entity frame estimate exactly matches every conservative sealed template branch', () => {
  const availableHashes = [
    { hash: `0x${'44'.repeat(32)}`, type: 'entityFrame', context: 'frame' },
    { hash: `0x${'55'.repeat(32)}`, type: 'entityOutput', context: 'output' },
  ];
  const signature = `0x${'11'.repeat(65)}`;
  const hanko = `0x${'22'.repeat(2_200)}`;
  for (const { hashCount, includeHankos } of [
    { hashCount: 1, includeHankos: true },
    { hashCount: 2, includeHankos: true },
    { hashCount: 2, includeHankos: false },
  ]) {
    const hashesToSign = availableHashes.slice(0, hashCount);
    const frame = {
      height: 1,
      parentFrameHash: 'genesis',
      stateRoot: `0x${'11'.repeat(32)}`,
      authorityRoot: `0x${'22'.repeat(32)}`,
      timestamp: 1,
      entityContext: emptyContext,
      txs: [],
      events: [],
      hash: `0x${'33'.repeat(32)}`,
      leader: { proposerSignerId: signerId, view: 0 },
      hashesToSign,
    };
    const exact = new TextEncoder().encode(encodeCanonicalConsensusValue({
      ...frame,
      collectedSigs: new Map([[signerId.toLowerCase(), hashesToSign.map(() => signature)]]),
      ...(includeHankos ? { hankos: [hanko] } : {}),
    })).byteLength;
    expect(assertEstimatedSealedEntityFrameWire(frame, signerId, includeHankos, 'EntityFrame'))
      .toBe(exact);
  }
});

test('single-signer sealed estimate keeps one EntityFrame Hanko across 2000 exact digests', () => {
  const hashesToSign = Array.from({ length: 2_000 }, (_, index) => ({
    hash: `0x${index.toString(16).padStart(64, '0')}`,
    type: index === 0 ? 'entityFrame' : 'accountFrame',
    context: `hash:${index}`,
  }));
  const frameHash = hashesToSign[0]?.hash;
  if (!frameHash) throw new Error('TEST_ENTITY_FRAME_MANIFEST_HEAD_MISSING');
  const frame = {
    height: 1,
    parentFrameHash: 'genesis',
    stateRoot: `0x${'11'.repeat(32)}`,
    authorityRoot: `0x${'22'.repeat(32)}`,
    timestamp: 1,
    entityContext: emptyContext,
    txs: [],
    events: [],
    hash: frameHash,
    leader: { proposerSignerId: signerId, view: 0 },
    hashesToSign,
  };
  expect(assertEstimatedSealedEntityFrameWire(
    frame,
    signerId,
    true,
    'SingleSignerEntityFrame',
  )).toBeLessThan(10_000_000);
});

test('proposal signs only after the estimated sealed wire fits', () => {
  const start = readFileSync(join(import.meta.dir, '../../../entity/consensus/proposal/start.ts'), 'utf8');
  const estimateAt = start.indexOf('assertEstimatedSealedEntityFrameWire');
  const signAt = start.indexOf('signProposalManifest');
  expect(estimateAt).toBeGreaterThan(0);
  expect(estimateAt).toBeLessThan(signAt);
});

import { expect, test } from 'bun:test';
import { ethers } from 'ethers';

import {
  EMPTY_CONSUMPTION_ROOT,
  MAX_CONSUMPTION_RELATIONSHIPS_PER_ENTITY,
  MAX_CONSUMPTION_PROOF_NODES,
  applyConsumptionOutput,
  createConsumptionProof,
  createEmptyConsumptionAccumulator,
  getConsumptionKey,
  getConsumptionTreeByteLength,
  hashConsumptionNode,
  verifyConsumptionProof,
  type ConsumptionNode,
  type ConsumptionNodeEntry,
  type ConsumptionNodeStore,
  type ConsumptionOutputIdentity,
  type ConsumptionProof,
} from '../entity/consumption-accumulator';

const bytes32 = (hexByte: string): string => `0x${hexByte.repeat(32)}`;
const entity = (value: number): string => ethers.toBeHex(BigInt(value), 32).toLowerCase();
const output = (
  sequence: number,
  overrides: Partial<ConsumptionOutputIdentity> = {},
): ConsumptionOutputIdentity => ({
  targetEntityId: entity(1),
  sourceEntityId: entity(2),
  lane: 'generic',
  sequence,
  semanticHash: ethers.keccak256(ethers.toUtf8Bytes(`semantic:${sequence}`)),
  outputHash: ethers.keccak256(ethers.toUtf8Bytes(`certificate:${sequence}`)),
  outputHanko: `0x${sequence.toString(16).padStart(2, '0')}`,
  ...overrides,
});

const cache = (store: Map<string, ConsumptionNode>, entries: readonly ConsumptionNodeEntry[]): void => {
  for (const { hash, node } of entries) store.set(hash, node);
};

const commitNodes = (
  store: Map<string, ConsumptionNode>,
  result: ReturnType<typeof applyConsumptionOutput>,
): void => {
  cache(store, result.newNodes);
  for (const hash of result.replacedNodeHashes) store.delete(hash);
};

test('pinned v2 relationship key and empty root stay byte-for-byte stable', () => {
  const identity = output(1);
  expect(EMPTY_CONSUMPTION_ROOT).toBe('0x382c422942079a41b66ed7182ed01d99f073b1ef8dd13e2c060b611fffe15532');
  expect(getConsumptionKey(identity)).toBe('0x4a9039ecf78ce1c1cc8df5b2fc1b78c9dfa09516e46994a736a47034764c8271');
  const inserted = applyConsumptionOutput(
    createEmptyConsumptionAccumulator(), identity, { version: 2, nodes: [] },
  );
  expect(inserted.state.root).toBe('0x27ed68d6e09dd8512a270698727474829d67ad7275f34a4d2ad180ec0fc4d577');
});

test('sequential outputs for one source-target relationship retain one authenticated frontier leaf', () => {
  const store = new Map<string, ConsumptionNode>();
  let state = createEmptyConsumptionAccumulator();
  for (let sequence = 1; sequence <= 100; sequence += 1) {
    const identity = output(sequence);
    const proof = createConsumptionProof(store, state.root, getConsumptionKey(identity));
    const applied = applyConsumptionOutput(state, identity, proof);
    expect(applied.status).toBe(sequence === 1 ? 'inserted' : 'advanced');
    commitNodes(store, applied);
    state = applied.state;
  }

  expect(state.count).toBe(1n);
  expect(store.size).toBe(1);
  expect(verifyConsumptionProof(
    state.root,
    getConsumptionKey(output(100)),
    createConsumptionProof(store, state.root, getConsumptionKey(output(100))),
  )).toEqual({
    status: 'member',
    value: expect.objectContaining({ lastContiguousSeq: 100n, count: 100n }),
  });
});

test('relationship storage depends on counterparties, never lifetime output count', () => {
  const millionOutputs = 1_000_000n;
  const oneRelationshipBytes = getConsumptionTreeByteLength(1n);
  expect(oneRelationshipBytes).toBe(148n);
  expect(getConsumptionTreeByteLength(1n)).toBe(oneRelationshipBytes);
  expect(millionOutputs * 0n + oneRelationshipBytes).toBe(148n);
});

test('relationship cardinality has an atomic finite protocol boundary', () => {
  const store = new Map<string, ConsumptionNode>();
  let state = createEmptyConsumptionAccumulator();
  const limit = Number(MAX_CONSUMPTION_RELATIONSHIPS_PER_ENTITY);
  const relationshipOutput = output(1);
  for (let index = 0; index < limit; index += 1) {
    const identity = { ...relationshipOutput, sourceEntityId: entity(index + 10) };
    const applied = applyConsumptionOutput(
      state,
      identity,
      createConsumptionProof(store, state.root, getConsumptionKey(identity)),
    );
    commitNodes(store, applied);
    state = applied.state;
  }
  expect(state.count).toBe(MAX_CONSUMPTION_RELATIONSHIPS_PER_ENTITY);
  expect(store.size).toBe(limit * 2 - 1);

  const rootBeforeReject = state.root;
  const nodesBeforeReject = store.size;
  const overflow = { ...relationshipOutput, sourceEntityId: entity(limit + 10) };
  const proof = createConsumptionProof(store, state.root, getConsumptionKey(overflow));
  expect(() => applyConsumptionOutput(state, overflow, proof))
    .toThrow(`CONSUMPTION_RELATIONSHIP_LIMIT_EXCEEDED:${limit}:${limit}`);
  expect(state.root).toBe(rootBeforeReject);
  expect(store.size).toBe(nodesBeforeReject);
  // This intentionally executes every authenticated insertion up to the hard
  // protocol limit. The explicit ceiling keeps it exhaustive and performance-bounded.
}, 15_000);

test('exact retry and board-recertified retry are no-ops; stale and gap never mutate state', () => {
  const store = new Map<string, ConsumptionNode>();
  const first = output(1);
  const inserted = applyConsumptionOutput(createEmptyConsumptionAccumulator(), first, { version: 2, nodes: [] });
  commitNodes(store, inserted);
  const proof = createConsumptionProof(store, inserted.state.root, getConsumptionKey(first));

  expect(applyConsumptionOutput(inserted.state, first, proof).status).toBe('idempotent');
  expect(applyConsumptionOutput(inserted.state, {
    ...first,
    outputHash: bytes32('ab'),
    outputHanko: '0xab',
  }, proof).status).toBe('idempotent');
  expect(applyConsumptionOutput(inserted.state, output(3), proof).status).toBe('gap');

  const second = applyConsumptionOutput(inserted.state, output(2), proof);
  commitNodes(store, second);
  const secondProof = createConsumptionProof(store, second.state.root, getConsumptionKey(first));
  expect(applyConsumptionOutput(second.state, {
    ...output(1),
    semanticHash: bytes32('ee'),
  }, secondProof).status).toBe('stale');
});

test('native Account lanes reuse imported bases and sparse proof nonces without parallel counters', () => {
  const cases = [
    output(7, { lane: 'account-frame' }),
    output(1, { lane: 'account-dispute' }),
    output(2, { lane: 'account-settlement' }),
  ];
  for (const identity of cases) {
    const inserted = applyConsumptionOutput(
      createEmptyConsumptionAccumulator(),
      identity,
      { version: 2, nodes: [] },
    );
    expect(inserted.status).toBe('inserted');
    expect(inserted.state.count).toBe(1n);
  }

  const store = new Map<string, ConsumptionNode>();
  const firstDispute = output(1, { lane: 'account-dispute' });
  const inserted = applyConsumptionOutput(
    createEmptyConsumptionAccumulator(),
    firstDispute,
    { version: 2, nodes: [] },
  );
  commitNodes(store, inserted);
  const laterDispute = output(3, { lane: 'account-dispute' });
  const advanced = applyConsumptionOutput(
    inserted.state,
    laterDispute,
    createConsumptionProof(store, inserted.state.root, getConsumptionKey(laterDispute)),
  );
  expect(advanced.status).toBe('advanced');
  expect(advanced.state.count).toBe(1n);

  const frameStore = new Map<string, ConsumptionNode>();
  const firstFrame = output(1, { lane: 'account-frame' });
  const insertedFrame = applyConsumptionOutput(
    createEmptyConsumptionAccumulator(),
    firstFrame,
    { version: 2, nodes: [] },
  );
  commitNodes(frameStore, insertedFrame);
  const nextOutputFromSameSide = output(3, { lane: 'account-frame' });
  const advancedFrame = applyConsumptionOutput(
    insertedFrame.state,
    nextOutputFromSameSide,
    createConsumptionProof(frameStore, insertedFrame.state.root, getConsumptionKey(nextOutputFromSameSide)),
  );
  expect(advancedFrame.status).toBe('advanced');
  expect(advancedFrame.state.count).toBe(1n);

  const firstGeneric = output(2);
  expect(applyConsumptionOutput(
    createEmptyConsumptionAccumulator(),
    firstGeneric,
    { version: 2, nodes: [] },
  ).status).toBe('gap');
});

test('same-height Account frame and ACK use independent frontiers while ACK heights stay sparse', () => {
  const store = new Map<string, ConsumptionNode>();
  const frame = output(10, { lane: 'account-frame' });
  const ack = output(10, { lane: 'account-ack' });
  const insertedFrame = applyConsumptionOutput(
    createEmptyConsumptionAccumulator(),
    frame,
    { version: 2, nodes: [] },
  );
  commitNodes(store, insertedFrame);
  const insertedAck = applyConsumptionOutput(
    insertedFrame.state,
    ack,
    createConsumptionProof(store, insertedFrame.state.root, getConsumptionKey(ack)),
  );
  commitNodes(store, insertedAck);

  expect(insertedFrame.status).toBe('inserted');
  expect(insertedAck.status).toBe('inserted');
  expect(insertedAck.state.count).toBe(2n);
  expect(getConsumptionKey(frame)).not.toBe(getConsumptionKey(ack));

  const sparseStore = new Map<string, ConsumptionNode>();
  const ackAtTwo = output(2, { lane: 'account-ack' });
  const insertedSparseAck = applyConsumptionOutput(
    createEmptyConsumptionAccumulator(),
    ackAtTwo,
    { version: 2, nodes: [] },
  );
  commitNodes(sparseStore, insertedSparseAck);
  const ackAtFour = output(4, { lane: 'account-ack' });
  const advancedSparseAck = applyConsumptionOutput(
    insertedSparseAck.state,
    ackAtFour,
    createConsumptionProof(sparseStore, insertedSparseAck.state.root, getConsumptionKey(ackAtFour)),
  );

  expect(insertedSparseAck.status).toBe('inserted');
  expect(advancedSparseAck.status).toBe('advanced');
  expect(advancedSparseAck.state.count).toBe(1n);
});

test('current-sequence equivocation quarantines only the relationship and retains both certificates', () => {
  const store = new Map<string, ConsumptionNode>();
  const accepted = output(1);
  const inserted = applyConsumptionOutput(createEmptyConsumptionAccumulator(), accepted, { version: 2, nodes: [] });
  commitNodes(store, inserted);
  const conflict = {
    ...accepted,
    semanticHash: bytes32('ee'),
    outputHash: bytes32('ff'),
    outputHanko: '0xffff',
  };
  const quarantined = applyConsumptionOutput(
    inserted.state,
    conflict,
    createConsumptionProof(store, inserted.state.root, getConsumptionKey(accepted)),
  );
  expect(quarantined.status).toBe('quarantined');
  commitNodes(store, quarantined);
  const proof = createConsumptionProof(store, quarantined.state.root, getConsumptionKey(accepted));
  expect(verifyConsumptionProof(quarantined.state.root, getConsumptionKey(accepted), proof)).toEqual({
    status: 'member',
    value: {
      version: 1,
      lastContiguousSeq: 1n,
      lastSemanticHash: accepted.semanticHash,
      count: 1n,
      lastOutputHash: accepted.outputHash,
      lastOutputHanko: accepted.outputHanko,
      quarantine: {
        sequence: 1n,
        conflictingSemanticHash: conflict.semanticHash,
        conflictingOutputHash: conflict.outputHash,
        conflictingOutputHanko: conflict.outputHanko,
      },
    },
  });
  expect(applyConsumptionOutput(quarantined.state, output(2), proof).status).toBe('quarantined');

  const independent = output(1, { sourceEntityId: entity(9) });
  const independentProof = createConsumptionProof(
    store,
    quarantined.state.root,
    getConsumptionKey(independent),
  );
  const independentlyApplied = applyConsumptionOutput(quarantined.state, independent, independentProof);
  expect(independentlyApplied.status).toBe('inserted');
  expect(independentlyApplied.state.count).toBe(2n);
});

test('two validators independently compute the same root and Patricia insertion is order-independent', () => {
  const identities = [
    output(1, { sourceEntityId: entity(3) }),
    output(1, { sourceEntityId: entity(4) }),
    output(1, { sourceEntityId: entity(5) }),
  ];
  const build = (ordered: ConsumptionOutputIdentity[]) => {
    const store = new Map<string, ConsumptionNode>();
    let state = createEmptyConsumptionAccumulator();
    for (const identity of ordered) {
      const applied = applyConsumptionOutput(
        state,
        identity,
        createConsumptionProof(store, state.root, getConsumptionKey(identity)),
      );
      commitNodes(store, applied);
      state = applied.state;
    }
    return { state, store };
  };
  const left = build(identities);
  const right = build([...identities].reverse());
  expect(left.state).toEqual(right.state);
  expect(left.state.count).toBe(3n);
  expect(left.store.size).toBe(5);
  expect(right.store.size).toBe(5);
});

test('missing, corrupt, wrongly linked, and oversized witnesses fail closed', () => {
  const identity = output(1);
  const inserted = applyConsumptionOutput(createEmptyConsumptionAccumulator(), identity, { version: 2, nodes: [] });
  const key = getConsumptionKey(identity);
  const leaf = inserted.newNodes[0]!.node;
  const proof: ConsumptionProof = { version: 2, nodes: [leaf] };

  expect(() => verifyConsumptionProof(inserted.state.root, key, undefined)).toThrow('CONSUMPTION_PROOF_REQUIRED');
  expect(() => verifyConsumptionProof(bytes32('cc'), key, proof)).toThrow('CONSUMPTION_PROOF_LINK_INVALID');
  const corruptNode = leaf.type === 'leaf'
    ? { ...leaf, value: { ...leaf.value, lastSemanticHash: bytes32('dd') } }
    : leaf;
  expect(() => createConsumptionProof(new Map([[inserted.state.root, corruptNode]]), inserted.state.root, key))
    .toThrow('CONSUMPTION_NODE_CORRUPT');
  expect(() => applyConsumptionOutput(inserted.state, { ...identity, sequence: '1' as unknown as number }, proof))
    .toThrow('CONSUMPTION_SEQUENCE_INVALID');
  expect(() => verifyConsumptionProof(inserted.state.root, key, {
    version: 2,
    nodes: Array.from({ length: MAX_CONSUMPTION_PROOF_NODES + 1 }, () => leaf),
  })).toThrow('CONSUMPTION_PROOF_LENGTH_INVALID');
});

test('a malformed Patricia path cannot authenticate a misplaced relationship leaf', () => {
  const value = {
    version: 1 as const,
    lastContiguousSeq: 1n,
    lastSemanticHash: bytes32('11'),
    count: 1n,
    lastOutputHash: bytes32('22'),
    lastOutputHanko: '0x01',
  };
  const misplacedLeaf: ConsumptionNode = { version: 2, type: 'leaf', key: bytes32('80'), value };
  const misplacedLeafHash = hashConsumptionNode(misplacedLeaf);
  const malformedRoot: ConsumptionNode = {
    version: 2,
    type: 'branch',
    bit: 0,
    left: misplacedLeafHash,
    right: bytes32('ff'),
  };
  expect(() => verifyConsumptionProof(hashConsumptionNode(malformedRoot), bytes32('00'), {
    version: 2,
    nodes: [malformedRoot, misplacedLeaf],
  })).toThrow('CONSUMPTION_PROOF_NON_CANONICAL_PATH');
});

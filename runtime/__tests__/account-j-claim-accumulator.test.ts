import { describe, expect, test } from 'bun:test';

import {
  applyAccountJClaimDelete,
  applyAccountJClaimInsert,
  collectReachableAccountJClaimNodes,
  createAccountJClaimProof,
  createAccountJClaimRecord,
  createEmptyAccountJClaimAccumulator,
  hashAccountJClaimNode,
  pruneAccountJClaimsThroughHeight,
  type AccountJClaimAccumulatorState,
  type AccountJClaimNode,
  type AccountJClaimRecord,
} from '../account/j-claim-accumulator';
import { accountJClaimKeyBit, getAccountJClaimKey } from '../account/j-claim-codec';

const LEFT = `0x${'11'.repeat(32)}`;
const RIGHT = `0x${'22'.repeat(32)}`;
const DEPOSITORY = `0x${'33'.repeat(20)}`;
const domain = {
  chainId: 31337,
  depositoryAddress: DEPOSITORY,
  leftEntity: LEFT,
  rightEntity: RIGHT,
};

const record = (
  side: 'left' | 'right',
  jHeight: number,
  marker: string,
): AccountJClaimRecord => createAccountJClaimRecord(domain, side, {
  jHeight,
  jBlockHash: `0x${marker.repeat(64)}`,
  eventsHash: `0x${marker.toUpperCase().repeat(64)}`,
});

const publish = (
  store: Map<string, AccountJClaimNode>,
  result: { newNodes: readonly { hash: string; node: AccountJClaimNode }[] },
): void => {
  for (const { hash, node } of result.newNodes) store.set(hash, node);
};

const insert = (
  store: Map<string, AccountJClaimNode>,
  state: AccountJClaimAccumulatorState,
  entry: AccountJClaimRecord,
) => {
  const proof = createAccountJClaimProof(store, state.root, entry);
  const result = applyAccountJClaimInsert(state, entry, proof);
  publish(store, result);
  return result;
};

describe('account J-claim authenticated retention', () => {
  test('inserts once, retries idempotently, and rejects same-height equivocation atomically', () => {
    const store = new Map<string, AccountJClaimNode>();
    const first = record('left', 7, 'a');
    const inserted = insert(store, createEmptyAccountJClaimAccumulator(), first);
    expect(inserted.status).toBe('inserted');
    expect(inserted.state.count).toBe(1n);

    const retryProof = createAccountJClaimProof(store, inserted.state.root, first);
    const retry = applyAccountJClaimInsert(inserted.state, first, retryProof);
    expect(retry.status).toBe('idempotent');
    expect(retry.state).toEqual(inserted.state);
    expect(retry.newNodes).toHaveLength(0);

    const before = structuredClone(inserted.state);
    const conflicting = record('left', 7, 'b');
    expect(() => applyAccountJClaimInsert(inserted.state, conflicting, retryProof))
      .toThrow('ACCOUNT_J_CLAIM_EQUIVOCATION');
    expect(inserted.state).toEqual(before);
  });

  test('independent validators compute the same root and reject a proof from another root', () => {
    const entries = [record('left', 9, 'c'), record('left', 2, 'd'), record('left', 5, 'e')];
    const run = (ordered: AccountJClaimRecord[]) => {
      const store = new Map<string, AccountJClaimNode>();
      let state = createEmptyAccountJClaimAccumulator();
      for (const entry of ordered) state = insert(store, state, entry).state;
      return { state, store };
    };
    const first = run(entries);
    const second = run([...entries].reverse());
    expect(first.state).toEqual(second.state);

    const foreignProof = createAccountJClaimProof(first.store, first.state.root, entries[0]!);
    expect(() => applyAccountJClaimInsert(
      createEmptyAccountJClaimAccumulator(),
      entries[0]!,
      foreignProof,
    )).toThrow('ACCOUNT_J_CLAIM_PROOF_TRAILING_NODES');
  });

  test('matching delete removes the leaf and stale cleanup retains only heights above the head', () => {
    const store = new Map<string, AccountJClaimNode>();
    let state = createEmptyAccountJClaimAccumulator();
    for (const entry of [record('right', 3, '1'), record('right', 7, '2'), record('right', 11, '3')]) {
      state = insert(store, state, entry).state;
    }

    const exact = record('right', 7, '2');
    const deletion = applyAccountJClaimDelete(
      state,
      exact,
      createAccountJClaimProof(store, state.root, exact),
    );
    publish(store, deletion);
    expect(deletion.status).toBe('deleted');
    expect(deletion.state.count).toBe(2n);

    const pruned = pruneAccountJClaimsThroughHeight(deletion.state, store, exact.accountKey, 'right', 7);
    publish(store, pruned);
    expect(pruned.state.count).toBe(1n);
    expect(pruned.removed.map((entry) => entry.jHeight)).toEqual([3]);
    expect(pruned.retained.map((entry) => entry.jHeight)).toEqual([11]);
  });

  test('snapshot reachable set restores exactly and missing/corrupt CAS nodes fail loud', () => {
    const live = new Map<string, AccountJClaimNode>();
    let state = createEmptyAccountJClaimAccumulator();
    for (const entry of [record('left', 1, '4'), record('left', 4, '5')]) {
      state = insert(live, state, entry).state;
    }
    const snapshot = collectReachableAccountJClaimNodes(live, [state]);
    const restored = new Map(snapshot);
    expect(collectReachableAccountJClaimNodes(restored, [state]).size).toBe(snapshot.size);

    const next = record('left', 8, '6');
    const continued = insert(restored, state, next);
    const control = insert(live, state, next);
    expect(continued.state).toEqual(control.state);

    const missing = new Map(snapshot);
    missing.delete(state.root);
    expect(() => createAccountJClaimProof(missing, state.root, next))
      .toThrow('ACCOUNT_J_CLAIM_NODE_MISSING');

    const corrupt = new Map(snapshot);
    const rootNode = corrupt.get(state.root)!;
    const tampered: AccountJClaimNode = rootNode.type === 'branch'
      ? { ...rootNode, bit: (rootNode.bit + 1) % 256 }
      : { ...rootNode, key: `0x${'ff'.repeat(32)}` };
    corrupt.set(state.root, tampered);
    expect(hashAccountJClaimNode(tampered)).not.toBe(state.root);
    expect(() => createAccountJClaimProof(corrupt, state.root, next))
      .toThrow('ACCOUNT_J_CLAIM_NODE_CORRUPT');
  });

  test('restore rejects a hash-valid Patricia tree whose leaf violates its branch path', () => {
    const leftRecord = record('left', 12, '7');
    const rightRecord = record('left', 13, '8');
    const leftLeaf: AccountJClaimNode = {
      version: 1,
      type: 'leaf',
      key: getAccountJClaimKey(leftRecord),
      record: leftRecord,
    };
    const rightLeaf: AccountJClaimNode = {
      version: 1,
      type: 'leaf',
      key: getAccountJClaimKey(rightRecord),
      record: rightRecord,
    };
    const leftHash = hashAccountJClaimNode(leftLeaf);
    const rightHash = hashAccountJClaimNode(rightLeaf);
    const wrongDirection = accountJClaimKeyBit(leftLeaf.key, 0);
    const branch: AccountJClaimNode = {
      version: 1,
      type: 'branch',
      bit: 0,
      left: wrongDirection === 0 ? rightHash : leftHash,
      right: wrongDirection === 0 ? leftHash : rightHash,
    };
    const root = hashAccountJClaimNode(branch);
    const malformed = new Map<string, AccountJClaimNode>([
      [root, branch],
      [leftHash, leftLeaf],
      [rightHash, rightLeaf],
    ]);

    expect(() => collectReachableAccountJClaimNodes(malformed, [{ version: 1, root, count: 2n }]))
      .toThrow('ACCOUNT_J_CLAIM_TREE_NON_CANONICAL_PATH');
  });
});

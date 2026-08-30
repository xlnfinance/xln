import {
  computeRadixMerkleBranchHashFromSlots,
  computeRadixMerkleEdgeHash,
  EMPTY_RADIX_MERKLE_ROOT,
} from '../../protocol/state/radix-merkle';
import type { PersistentRadixNodeCommitment } from '../../protocol/state/persistent-radix-value-map';

export const TS_ACCOUNT_LOGICAL_SHARDS = 4_096;
const TS_ACCOUNT_SHARD_NIBBLES = 3;

const ACCOUNT_ID_PATTERN = /^0x[0-9a-f]{64}$/;
export const normalizeTsWorkerAccountId = (accountId: string): string => {
  const normalized = accountId.trim().toLowerCase();
  if (!ACCOUNT_ID_PATTERN.test(normalized)) {
    throw new Error(`TS_ACCOUNT_WORKER_ACCOUNT_ID_INVALID:${accountId}`);
  }
  return normalized;
};

/** The first three Account-key nibbles select one of 4096 stable logical shards. */
export const tsAccountLogicalShard = (accountId: string): number =>
  Number.parseInt(normalizeTsWorkerAccountId(accountId).slice(2, 2 + TS_ACCOUNT_SHARD_NIBBLES), 16);

export const tsAccountLogicalShardPath = (shardId: number): readonly number[] => {
  if (!Number.isSafeInteger(shardId) || shardId < 0 || shardId >= TS_ACCOUNT_LOGICAL_SHARDS) {
    throw new Error(`TS_ACCOUNT_WORKER_SHARD_INVALID:${shardId}`);
  }
  return [shardId >>> 8, (shardId >>> 4) & 0x0f, shardId & 0x0f];
};

/** Default operational assignment used only when no weighted assignment is supplied. */
export const createBalancedTsAccountShardAssignment = (workerCount: number): readonly number[] => {
  if (!Number.isSafeInteger(workerCount) || workerCount <= 0) {
    throw new Error(`TS_ACCOUNT_WORKER_COUNT_INVALID:${workerCount}`);
  }
  return Object.freeze(Array.from(
    { length: TS_ACCOUNT_LOGICAL_SHARDS },
    (_, shardId) => shardId % workerCount,
  ));
};

/** Validate and detach the complete logical-shard -> physical-worker assignment. */
export const validateTsAccountShardAssignment = (
  input: readonly number[],
  workerCount: number,
): readonly number[] => {
  if (!Number.isSafeInteger(workerCount) || workerCount <= 0) {
    throw new Error(`TS_ACCOUNT_WORKER_COUNT_INVALID:${workerCount}`);
  }
  if (input.length !== TS_ACCOUNT_LOGICAL_SHARDS) {
    throw new Error(`TS_ACCOUNT_WORKER_ASSIGNMENT_LENGTH:${input.length}:${TS_ACCOUNT_LOGICAL_SHARDS}`);
  }
  const ownedCounts = Array.from({ length: workerCount }, () => 0);
  const assignment = input.map((workerIndex, shardId) => {
    if (!Number.isSafeInteger(workerIndex) || workerIndex < 0 || workerIndex >= workerCount) {
      throw new Error(`TS_ACCOUNT_WORKER_ASSIGNMENT_SLOT:${shardId}:${workerIndex}:${workerCount}`);
    }
    const owned = ownedCounts[workerIndex];
    if (owned === undefined) throw new Error(`TS_ACCOUNT_WORKER_ASSIGNMENT_SLOT:${workerIndex}`);
    ownedCounts[workerIndex] = owned + 1;
    return workerIndex;
  });
  const emptyWorker = ownedCounts.findIndex(count => count === 0);
  if (emptyWorker >= 0) throw new Error(`TS_ACCOUNT_WORKER_ASSIGNMENT_EMPTY:${emptyWorker}`);
  return Object.freeze(assignment);
};

/** Resolve ownership without coupling logical shards to worker-count arithmetic. */
export const tsAccountWorkerForShard = (
  shardId: number,
  assignment: readonly number[],
): number => {
  if (!Number.isSafeInteger(shardId) || shardId < 0 || shardId >= TS_ACCOUNT_LOGICAL_SHARDS) {
    throw new Error(`TS_ACCOUNT_WORKER_SHARD_INVALID:${shardId}`);
  }
  const workerIndex = assignment[shardId];
  if (typeof workerIndex !== 'number' || !Number.isSafeInteger(workerIndex) || workerIndex < 0) {
    throw new Error(`TS_ACCOUNT_WORKER_ASSIGNMENT_MISSING:${shardId}`);
  }
  return workerIndex;
};

type CanonicalFoldNode = {
  readonly kind: 'branch' | 'leaf';
  readonly path: readonly number[];
  hash: string;
  parent?: CanonicalFoldNode;
  children?: Map<number, CanonicalFoldNode>;
};

type ShardFoldNode = Readonly<{ shardId: number; node: CanonicalFoldNode }>;

const sharedPathLength = (entries: readonly ShardFoldNode[]): number => {
  const first = entries[0]?.node;
  if (!first) throw new Error('TS_ACCOUNT_WORKER_COMMITMENT_EMPTY');
  let shared = first.path.length;
  for (const { node } of entries) {
    let index = 0;
    while (index < shared && node.path[index] === first.path[index]) index += 1;
    shared = index;
  }
  return shared;
};

const combineCanonicalNodes = (
  entries: readonly ShardFoldNode[],
): CanonicalFoldNode => {
  const first = entries[0];
  if (!first) throw new Error('TS_ACCOUNT_WORKER_COMMITMENT_EMPTY');
  if (entries.length === 1) return first.node;
  const depth = sharedPathLength(entries);
  const buckets = new Map<number, ShardFoldNode[]>();
  for (const entry of entries) {
    const { node } = entry;
    const slot = node.path[depth];
    if (slot === undefined) throw new Error('TS_ACCOUNT_WORKER_COMMITMENT_PREFIX_COLLISION');
    const bucket = buckets.get(slot);
    if (bucket) bucket.push(entry);
    else buckets.set(slot, [entry]);
  }
  const path = first.node.path.slice(0, depth);
  const edgeHashes: Array<string | undefined> = Array(16);
  const children = new Map<number, CanonicalFoldNode>();
  const branch: CanonicalFoldNode = { kind: 'branch', path, hash: '', children };
  for (const [slot, bucket] of buckets) {
    const child = combineCanonicalNodes(bucket);
    child.parent = branch;
    children.set(slot, child);
    edgeHashes[slot] = computeRadixMerkleEdgeHash(16, path, child.kind, child.path, child.hash);
  }
  branch.hash = computeRadixMerkleBranchHashFromSlots(16, edgeHashes);
  return branch;
};

const recomputeCanonicalBranch = (branch: CanonicalFoldNode): void => {
  const children = branch.children;
  if (!children) throw new Error('TS_ACCOUNT_WORKER_COMMITMENT_BRANCH_OPAQUE');
  const edgeHashes: Array<string | undefined> = Array(16);
  for (const [slot, child] of children) {
    edgeHashes[slot] = computeRadixMerkleEdgeHash(16, branch.path, child.kind, child.path, child.hash);
  }
  branch.hash = computeRadixMerkleBranchHashFromSlots(16, edgeHashes);
};

/** RAM-only coordinator fold of the workers' canonical Patricia subtrees. */
export class TsAccountCanonicalRoot {
  readonly #shards = new Map<number, PersistentRadixNodeCommitment>();
  readonly #shardNodes = new Map<number, CanonicalFoldNode>();
  #tree: CanonicalFoldNode | null = null;
  #root = EMPTY_RADIX_MERKLE_ROOT;

  get root(): string {
    return this.#root;
  }

  update(changes: readonly Readonly<{
    shardId: number;
    node: PersistentRadixNodeCommitment | null;
  }>[]): void {
    if (changes.length === 0) return;
    let shapeChanged = this.#tree === null;
    for (const { shardId, node } of changes) {
      const prefix = tsAccountLogicalShardPath(shardId);
      if (node === null) {
        shapeChanged ||= this.#shards.has(shardId);
        this.#shards.delete(shardId);
        continue;
      }
      if (node.path.length < prefix.length || prefix.some((slot, index) => node.path[index] !== slot)) {
        throw new Error(`TS_ACCOUNT_WORKER_COMMITMENT_SHARD_MISMATCH:${shardId}`);
      }
      const previous = this.#shards.get(shardId);
      shapeChanged ||= previous === undefined || previous.kind !== node.kind
        || previous.path.length !== node.path.length
        || previous.path.some((slot, index) => node.path[index] !== slot);
      this.#shards.set(shardId, node);
    }
    if (this.#shards.size === 0) {
      this.#tree = null;
      this.#shardNodes.clear();
      this.#root = EMPTY_RADIX_MERKLE_ROOT;
      return;
    }
    if (shapeChanged) {
      this.#shardNodes.clear();
      const entries = [...this.#shards].map(([shardId, commitment]) => {
        const node: CanonicalFoldNode = { ...commitment };
        this.#shardNodes.set(shardId, node);
        return { shardId, node };
      });
      const combined = combineCanonicalNodes(entries);
      if (combined.kind === 'branch' && combined.path.length === 0) {
        this.#tree = combined;
      } else {
        const slot = combined.path[0];
        if (slot === undefined) throw new Error('TS_ACCOUNT_WORKER_COMMITMENT_ROOT_SLOT');
        const tree: CanonicalFoldNode = {
          kind: 'branch', path: [], hash: '', children: new Map([[slot, combined]]),
        };
        combined.parent = tree;
        recomputeCanonicalBranch(tree);
        this.#tree = tree;
      }
      this.#root = this.#tree.hash;
      return;
    }
    const dirty = new Set<CanonicalFoldNode>();
    for (const { shardId, node } of changes) {
      if (!node) continue;
      const shard = this.#shardNodes.get(shardId);
      if (!shard) throw new Error(`TS_ACCOUNT_WORKER_COMMITMENT_SHARD_MISSING:${shardId}`);
      shard.hash = node.hash;
      for (let parent = shard.parent; parent; parent = parent.parent) dirty.add(parent);
    }
    for (const branch of [...dirty].sort((left, right) => right.path.length - left.path.length)) {
      recomputeCanonicalBranch(branch);
    }
    if (!this.#tree) throw new Error('TS_ACCOUNT_WORKER_COMMITMENT_TREE_MISSING');
    this.#root = this.#tree.hash;
  }
}

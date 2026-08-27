import { computeIntegrityDigest } from '../../support/bytes/integrity-checksum';
import { hexToBytes } from '../../support/bytes/hex-bytes';

export const TS_ACCOUNT_LOGICAL_SHARDS = 4_096;
const TS_ACCOUNT_SHARD_NIBBLES = 3;

const ACCOUNT_ID_PATTERN = /^0x[0-9a-f]{64}$/;
const SHARD_ROOT_DOMAIN = new TextEncoder().encode('xln.ts-account-worker.shard-root:v1');
const TREE_NODE_DOMAIN = new TextEncoder().encode('xln.ts-account-worker.shard-tree:v1');

const u16 = (value: number): Uint8Array => {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, false);
  return bytes;
};

const u32 = (value: number): Uint8Array => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
};

const concatBytes = (parts: readonly Uint8Array[]): Uint8Array => {
  const byteLength = parts.reduce((total, part) => total + part.byteLength, 0);
  const output = new Uint8Array(byteLength);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
};

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

export type TsAccountShardLeaf = Readonly<{
  accountId: string;
  valueHash: string;
}>;

/**
 * Commits one logical shard without serializing Account state. The leaf digest is the
 * canonical Entity Account value hash; sorted Account ids make completion order irrelevant.
 */
export const computeTsAccountLogicalShardRoot = (
  shardId: number,
  leaves: readonly TsAccountShardLeaf[],
): string => {
  if (!Number.isSafeInteger(shardId) || shardId < 0 || shardId >= TS_ACCOUNT_LOGICAL_SHARDS) {
    throw new Error(`TS_ACCOUNT_WORKER_SHARD_INVALID:${shardId}`);
  }
  const ordered = leaves
    .map(leaf => ({
      accountId: normalizeTsWorkerAccountId(leaf.accountId),
      valueHash: leaf.valueHash.toLowerCase(),
    }))
    .sort((left, right) => left.accountId.localeCompare(right.accountId));
  const parts: Uint8Array[] = [SHARD_ROOT_DOMAIN, u16(shardId), u32(ordered.length)];
  let previous = '';
  for (const leaf of ordered) {
    if (leaf.accountId === previous) {
      throw new Error(`TS_ACCOUNT_WORKER_SHARD_DUPLICATE_ACCOUNT:${leaf.accountId}`);
    }
    if (!/^0x[0-9a-f]{64}$/.test(leaf.valueHash)) {
      throw new Error(`TS_ACCOUNT_WORKER_VALUE_HASH_INVALID:${leaf.accountId}`);
    }
    if (tsAccountLogicalShard(leaf.accountId) !== shardId) {
      throw new Error(`TS_ACCOUNT_WORKER_SHARD_ACCOUNT_MISMATCH:${shardId}:${leaf.accountId}`);
    }
    parts.push(hexToBytes(leaf.accountId), hexToBytes(leaf.valueHash));
    previous = leaf.accountId;
  }
  return computeIntegrityDigest(concatBytes(parts));
};

const computeTreeNode = (
  level: number,
  nodeIndex: number,
  children: readonly string[],
): string => {
  if (children.length !== 16) throw new Error(`TS_ACCOUNT_WORKER_TREE_ARITY:${children.length}`);
  return computeIntegrityDigest(concatBytes([
    TREE_NODE_DOMAIN,
    Uint8Array.of(level),
    u16(nodeIndex),
    ...children.map((child, index) => {
      const normalized = child.toLowerCase();
      if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
        throw new Error(`TS_ACCOUNT_WORKER_SUBROOT_INVALID:${level}:${nodeIndex}:${index}`);
      }
      return hexToBytes(normalized);
    }),
  ]));
};

/** Incremental fixed 16-ary tree: 4096 leaves -> 256 -> 16 -> one root. */
export class TsAccountShardRootTree {
  readonly #levels: [string[], string[], string[], string[]];

  constructor() {
    const leaves = Array.from({ length: TS_ACCOUNT_LOGICAL_SHARDS }, (_, shardId) =>
      computeTsAccountLogicalShardRoot(shardId, []));
    const levelOne = Array.from({ length: 256 }, (_, index) =>
      computeTreeNode(1, index, leaves.slice(index * 16, index * 16 + 16)));
    const levelTwo = Array.from({ length: 16 }, (_, index) =>
      computeTreeNode(2, index, levelOne.slice(index * 16, index * 16 + 16)));
    const root = [computeTreeNode(3, 0, levelTwo)];
    this.#levels = [leaves, levelOne, levelTwo, root];
  }

  get root(): string {
    const root = this.#levels[3][0];
    if (root === undefined) throw new Error('TS_ACCOUNT_WORKER_ROOT_MISSING');
    return root;
  }

  subroot(shardId: number): string {
    const root = this.#levels[0][shardId];
    if (root === undefined) throw new Error(`TS_ACCOUNT_WORKER_SHARD_INVALID:${shardId}`);
    return root;
  }

  update(changes: readonly Readonly<{ shardId: number; root: string }>[]): void {
    const last = new Map<number, string>();
    for (const change of changes) {
      if (!Number.isSafeInteger(change.shardId) || change.shardId < 0 || change.shardId >= TS_ACCOUNT_LOGICAL_SHARDS) {
        throw new Error(`TS_ACCOUNT_WORKER_SHARD_INVALID:${change.shardId}`);
      }
      const root = change.root.toLowerCase();
      if (!/^0x[0-9a-f]{64}$/.test(root)) {
        throw new Error(`TS_ACCOUNT_WORKER_SUBROOT_INVALID:${change.shardId}`);
      }
      last.set(change.shardId, root);
    }
    if (last.size === 0) return;
    const dirtyOne = new Set<number>();
    for (const [shardId, root] of last) {
      this.#levels[0][shardId] = root;
      dirtyOne.add(Math.floor(shardId / 16));
    }
    const dirtyTwo = new Set<number>();
    for (const index of [...dirtyOne].sort((left, right) => left - right)) {
      this.#levels[1][index] = computeTreeNode(
        1,
        index,
        this.#levels[0].slice(index * 16, index * 16 + 16),
      );
      dirtyTwo.add(Math.floor(index / 16));
    }
    for (const index of [...dirtyTwo].sort((left, right) => left - right)) {
      this.#levels[2][index] = computeTreeNode(
        2,
        index,
        this.#levels[1].slice(index * 16, index * 16 + 16),
      );
    }
    this.#levels[3][0] = computeTreeNode(3, 0, this.#levels[2]);
  }
}

import { ethers } from 'ethers';

import {
  computeRadixMerkleBranchHash,
  computeRadixMerkleEdgeHash,
  computeRadixMerkleLeafHash,
  computeRadixMerkleRootHash,
  EMPTY_RADIX_MERKLE_ROOT,
} from '../../../protocol/state/radix-merkle';

const ACCOUNT_COMMITMENT_RADIX = 16;

type AccountCommitmentLeaf = {
  kind: 'leaf';
  key: string;
  valueHash: string;
  hash: string;
};

type AccountCommitmentBranch = {
  kind: 'branch';
  path: string;
  children: ReadonlyMap<number, AccountCommitmentNode>;
  hash: string;
};

type AccountCommitmentNode =
  | AccountCommitmentLeaf
  | AccountCommitmentBranch;

export type EntityAccountCommitment = {
  root: AccountCommitmentNode | null;
  leafCount: number;
};

export const EMPTY_ENTITY_ACCOUNT_COMMITMENT: EntityAccountCommitment = {
  root: null,
  leafCount: 0,
};

const normalizeEntityId = (value: string): string => {
  const normalized = value.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`ENTITY_ACCOUNT_COMMITMENT_ID_INVALID:${value}`);
  }
  return normalized;
};

const pathForEntityId = (entityId: string): string => entityId.slice(2);

const nodePath = (node: AccountCommitmentNode): string =>
  node.kind === 'leaf' ? pathForEntityId(node.key) : node.path;

const pathSlots = (path: string): number[] =>
  Array.from(path, nibble => Number.parseInt(nibble, 16));

const commonPrefixLength = (
  left: string,
  right: string,
): number => {
  const limit = Math.min(left.length, right.length);
  let length = 0;
  while (length < limit && left[length] === right[length]) length += 1;
  return length;
};

const hasPrefix = (
  path: string,
  prefix: string,
): boolean => path.startsWith(prefix);

const nodeSlotUnder = (
  parentPath: string,
  childPath: string,
): number => {
  const nibble = childPath[parentPath.length];
  if (nibble === undefined) throw new Error('ENTITY_ACCOUNT_COMMITMENT_CHILD_SLOT_MISSING');
  return Number.parseInt(nibble, 16);
};

const childEdgeHash = (
  parentPath: string,
  child: AccountCommitmentNode,
): string =>
  computeRadixMerkleEdgeHash(
    ACCOUNT_COMMITMENT_RADIX,
    pathSlots(parentPath),
    child.kind,
    pathSlots(nodePath(child)),
    child.hash,
  );

const makeBranch = (
  path: string,
  childNodes: readonly AccountCommitmentNode[],
): AccountCommitmentBranch => {
  const children = new Map<number, AccountCommitmentNode>();
  for (const child of childNodes) {
    const slot = nodeSlotUnder(path, nodePath(child));
    if (children.has(slot)) throw new Error('ENTITY_ACCOUNT_COMMITMENT_BRANCH_SLOT_COLLISION');
    children.set(slot, child);
  }
  const hash = computeRadixMerkleBranchHash(
    ACCOUNT_COMMITMENT_RADIX,
    [...children.entries()].map(([slot, child]) => [
      slot,
      childEdgeHash(path, child),
    ]),
  );
  return { kind: 'branch', path, children, hash };
};

const makeLeaf = (
  rawEntityId: string,
  valueHash: string,
): AccountCommitmentLeaf => {
  const key = normalizeEntityId(rawEntityId);
  if (!/^0x[0-9a-f]{64}$/.test(valueHash)) {
    throw new Error(`ENTITY_ACCOUNT_COMMITMENT_VALUE_HASH_INVALID:${valueHash}`);
  }
  const keyBytes = ethers.getBytes(key);
  return {
    kind: 'leaf',
    key,
    valueHash,
    hash: computeRadixMerkleLeafHash(
      keyBytes,
      ethers.getBytes(valueHash),
    ),
  };
};

const compareLeafPath = (
  left: AccountCommitmentLeaf,
  right: AccountCommitmentLeaf,
): number => {
  if (left.key === right.key) return 0;
  return left.key < right.key ? -1 : 1;
};

const buildSortedLeaves = (
  leaves: readonly AccountCommitmentLeaf[],
  start: number,
  end: number,
  offset: number,
): AccountCommitmentNode => {
  if (end - start === 1) return leaves[start]!;
  const first = leaves[start]!;
  const last = leaves[end - 1]!;
  const firstPath = pathForEntityId(first.key);
  const lastPath = pathForEntityId(last.key);
  const shared = commonPrefixLength(
    firstPath.slice(offset),
    lastPath.slice(offset),
  );
  const branchOffset = offset + shared;
  const children: AccountCommitmentNode[] = [];
  let cursor = start;
  while (cursor < end) {
    const slot = pathForEntityId(leaves[cursor]!.key)[branchOffset];
    if (slot === undefined) {
      throw new Error('ENTITY_ACCOUNT_COMMITMENT_DUPLICATE_PATH');
    }
    let next = cursor + 1;
    while (next < end && pathForEntityId(leaves[next]!.key)[branchOffset] === slot) next += 1;
    children.push(buildSortedLeaves(leaves, cursor, next, branchOffset + 1));
    cursor = next;
  }
  return makeBranch(firstPath.slice(0, branchOffset), children);
};

export const buildEntityAccountCommitment = (
  entries: Iterable<readonly [entityId: string, valueHash: string]>,
): EntityAccountCommitment => {
  const leaves = [...entries]
    .map(([entityId, valueHash]) => makeLeaf(entityId, valueHash))
    .sort(compareLeafPath);
  if (leaves.length === 0) return EMPTY_ENTITY_ACCOUNT_COMMITMENT;
  for (let index = 1; index < leaves.length; index += 1) {
    if (leaves[index - 1]!.key === leaves[index]!.key) {
      throw new Error(`ENTITY_ACCOUNT_COMMITMENT_DUPLICATE_ID:${leaves[index]!.key}`);
    }
  }
  return {
    root: buildSortedLeaves(leaves, 0, leaves.length, 0),
    leafCount: leaves.length,
  };
};

const putNode = (
  node: AccountCommitmentNode | null,
  leaf: AccountCommitmentLeaf,
): { node: AccountCommitmentNode; inserted: boolean } => {
  if (!node) return { node: leaf, inserted: true };
  if (node.kind === 'leaf') {
    if (node.key === leaf.key) {
      return {
        node: node.valueHash === leaf.valueHash ? node : leaf,
        inserted: false,
      };
    }
    const shared = commonPrefixLength(pathForEntityId(node.key), pathForEntityId(leaf.key));
    return {
      node: makeBranch(pathForEntityId(node.key).slice(0, shared), [node, leaf]),
      inserted: true,
    };
  }

  const leafPath = pathForEntityId(leaf.key);
  const shared = commonPrefixLength(node.path, leafPath);
  if (shared < node.path.length) {
    return {
      node: makeBranch(node.path.slice(0, shared), [node, leaf]),
      inserted: true,
    };
  }
  const slot = nodeSlotUnder(node.path, leafPath);
  const previousChild = node.children.get(slot) ?? null;
  const updated = putNode(previousChild, leaf);
  if (updated.node === previousChild) return { node, inserted: updated.inserted };
  const children = new Map(node.children);
  children.set(slot, updated.node);
  return {
    node: makeBranch(node.path, [...children.values()]),
    inserted: updated.inserted,
  };
};

const deleteNode = (
  node: AccountCommitmentNode | null,
  entityId: string,
  path: string,
): { node: AccountCommitmentNode | null; deleted: boolean } => {
  if (!node || !hasPrefix(path, nodePath(node))) return { node, deleted: false };
  if (node.kind === 'leaf') {
    return node.key === entityId
      ? { node: null, deleted: true }
      : { node, deleted: false };
  }
  const slot = nodeSlotUnder(node.path, path);
  const previousChild = node.children.get(slot);
  if (!previousChild) return { node, deleted: false };
  const updated = deleteNode(previousChild, entityId, path);
  if (!updated.deleted) return { node, deleted: false };
  const children = new Map(node.children);
  if (updated.node) children.set(slot, updated.node);
  else children.delete(slot);
  if (children.size === 0) return { node: null, deleted: true };
  if (children.size === 1) {
    return { node: children.values().next().value!, deleted: true };
  }
  return {
    node: makeBranch(node.path, [...children.values()]),
    deleted: true,
  };
};

export const putEntityAccountCommitment = (
  commitment: EntityAccountCommitment,
  entityId: string,
  valueHash: string,
): EntityAccountCommitment => {
  const updated = putNode(commitment.root, makeLeaf(entityId, valueHash));
  if (updated.node === commitment.root) return commitment;
  return {
    root: updated.node,
    leafCount: commitment.leafCount + (updated.inserted ? 1 : 0),
  };
};

export const deleteEntityAccountCommitment = (
  commitment: EntityAccountCommitment,
  rawEntityId: string,
): EntityAccountCommitment => {
  const entityId = normalizeEntityId(rawEntityId);
  const updated = deleteNode(
    commitment.root,
    entityId,
    pathForEntityId(entityId),
  );
  if (!updated.deleted) return commitment;
  return {
    root: updated.node,
    leafCount: commitment.leafCount - 1,
  };
};

export const entityAccountCommitmentRoot = (
  commitment: EntityAccountCommitment,
): string => {
  const { root } = commitment;
  if (!root) return EMPTY_RADIX_MERKLE_ROOT;
  return computeRadixMerkleRootHash(
    ACCOUNT_COMMITMENT_RADIX,
    root.kind,
    pathSlots(nodePath(root)),
    root.hash,
  );
};

export const ENTITY_ACCOUNT_COMMITMENT_RADIX = ACCOUNT_COMMITMENT_RADIX;

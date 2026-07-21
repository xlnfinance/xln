import { ethers } from 'ethers';

import { computeIntegrityDigest } from '../infra/integrity-checksum';
import type { AccountMachine } from '../types';

export type AccountCommittedMap =
  | 'deltas'
  | 'locks'
  | 'pulls'
  | 'swapOffers'
  | 'subcontracts'
  | 'lendingIntents';

export type AccountMapCommitmentTiming = {
  mode: 'cold-oracle' | 'cold-cache' | 'source-replaced' | 'cached' | 'incremental';
  entries: number;
  dirtyKeys: number;
};

type EncodedValue = (value: unknown) => Uint8Array;

type TrieEntry = {
  keyHash: string;
  path: Uint8Array;
  valueHash: string;
};

type BucketNode = {
  kind: 'bucket';
  count: number;
  entries: ReadonlyMap<string, TrieEntry>;
  hash: string;
};

type BranchNode = {
  kind: 'branch';
  count: number;
  children: ReadonlyMap<number, TrieNode>;
  hash: string;
};

type TrieNode = BucketNode | BranchNode;

type CachedMap = {
  source: ReadonlyMap<unknown, unknown>;
  trie: TrieNode | null;
  dirtyKeys: Set<unknown>;
};

type AccountCommitmentCache = Map<AccountCommittedMap, CachedMap>;

const ACCOUNT_CACHE = Symbol('xln.account.commitment-cache');
const STAGED_ACCOUNT_CACHE = Symbol('xln.account.staged-commitment-cache');
type AccountWithCommitmentCache = AccountMachine & {
  [ACCOUNT_CACHE]?: AccountCommitmentCache;
  [STAGED_ACCOUNT_CACHE]?: AccountCommitmentCache;
};

const readAccountCache = (account: AccountMachine): AccountCommitmentCache | undefined =>
  (account as AccountWithCommitmentCache)[ACCOUNT_CACHE];

const readStagedAccountCache = (account: AccountMachine): AccountCommitmentCache | undefined =>
  (account as AccountWithCommitmentCache)[STAGED_ACCOUNT_CACHE];

const writeHiddenCache = (
  account: AccountMachine,
  key: typeof ACCOUNT_CACHE | typeof STAGED_ACCOUNT_CACHE,
  cache: AccountCommitmentCache,
): void => {
  Object.defineProperty(account, key, {
    value: cache,
    configurable: true,
    writable: true,
    enumerable: false,
  });
};

const deleteHiddenCache = (
  account: AccountMachine,
  key: typeof ACCOUNT_CACHE | typeof STAGED_ACCOUNT_CACHE,
): void => {
  delete (account as AccountWithCommitmentCache)[key];
};
const EMPTY_MAP_ROOT = `0x${'00'.repeat(32)}`;
const MAX_BUCKET_ENTRIES = 64;
const MAX_TRIE_DEPTH = 64;
const UTF8 = new TextEncoder();

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
};

const u16 = (value: number): Uint8Array => Uint8Array.of(value >>> 8, value);
// These nodes are internal integrity commitments. The resulting map roots are
// still embedded in the outer Keccak Account root signed by Hanko; using the
// native SHA-256 helper here avoids paying JS Keccak once per hot hub leaf.
const hash = (parts: readonly Uint8Array[]): string => computeIntegrityDigest(concat(parts));
const hashBytes = (value: string): Uint8Array => ethers.getBytes(value);

const encodeMapKey = (key: unknown): Uint8Array => {
  if (typeof key === 'string') return concat([Uint8Array.of(1), UTF8.encode(key)]);
  if (typeof key === 'number' && Number.isSafeInteger(key)) {
    return concat([Uint8Array.of(2), UTF8.encode(String(key))]);
  }
  throw new Error(`ACCOUNT_COMMITMENT_MAP_KEY_INVALID:${typeof key}:${String(key)}`);
};

const makeEntry = (
  namespace: AccountCommittedMap,
  key: unknown,
  value: unknown,
  encodeValue: EncodedValue,
): TrieEntry => {
  const keyHash = computeIntegrityDigest(concat([
    UTF8.encode(`xln.account.map.${namespace}.key`),
    encodeMapKey(key),
  ]));
  const path = hashBytes(keyHash);
  const valueHash = computeIntegrityDigest(encodeValue(value));
  return {
    keyHash,
    path,
    valueHash: hash([
      UTF8.encode(`xln.account.map.${namespace}.leaf`),
      path,
      hashBytes(valueHash),
    ]),
  };
};

const bucketHash = (namespace: AccountCommittedMap, entries: ReadonlyMap<string, TrieEntry>): string => {
  const parts: Uint8Array[] = [
    UTF8.encode(`xln.account.map.${namespace}.bucket`),
    u16(entries.size),
  ];
  for (const entry of Array.from(entries.values()).sort((left, right) =>
    left.keyHash < right.keyHash ? -1 : left.keyHash > right.keyHash ? 1 : 0)) {
    parts.push(hashBytes(entry.keyHash), hashBytes(entry.valueHash));
  }
  return hash(parts);
};

const branchHash = (
  namespace: AccountCommittedMap,
  depth: number,
  children: ReadonlyMap<number, TrieNode>,
): string => {
  const parts: Uint8Array[] = [
    UTF8.encode(`xln.account.map.${namespace}.branch`),
    Uint8Array.of(depth),
    u16(children.size),
  ];
  for (const [slot, child] of Array.from(children.entries()).sort((left, right) => left[0] - right[0])) {
    parts.push(Uint8Array.of(slot), hashBytes(child.hash));
  }
  return hash(parts);
};

const pathNibble = (path: Uint8Array, depth: number): number => {
  const byte = path[Math.floor(depth / 2)];
  if (byte === undefined) throw new Error(`ACCOUNT_COMMITMENT_PATH_EXHAUSTED:${depth}`);
  return depth % 2 === 0 ? byte >>> 4 : byte & 0x0f;
};

const buildTrie = (
  namespace: AccountCommittedMap,
  entries: readonly TrieEntry[],
  depth = 0,
): TrieNode | null => {
  if (entries.length === 0) return null;
  if (entries.length <= MAX_BUCKET_ENTRIES || depth >= MAX_TRIE_DEPTH) {
    const byKey = new Map(entries.map((entry) => [entry.keyHash, entry]));
    return { kind: 'bucket', count: byKey.size, entries: byKey, hash: bucketHash(namespace, byKey) };
  }
  const grouped = new Map<number, TrieEntry[]>();
  for (const entry of entries) {
    const slot = pathNibble(entry.path, depth);
    const group = grouped.get(slot);
    if (group) group.push(entry);
    else grouped.set(slot, [entry]);
  }
  const children = new Map<number, TrieNode>();
  for (const [slot, group] of grouped) {
    const child = buildTrie(namespace, group, depth + 1);
    if (child) children.set(slot, child);
  }
  return {
    kind: 'branch',
    count: entries.length,
    children,
    hash: branchHash(namespace, depth, children),
  };
};

const collectEntries = (node: TrieNode, output: TrieEntry[]): void => {
  if (node.kind === 'bucket') {
    output.push(...node.entries.values());
    return;
  }
  for (const child of node.children.values()) collectEntries(child, output);
};

const updateTrie = (
  namespace: AccountCommittedMap,
  node: TrieNode | null,
  entry: TrieEntry,
  depth = 0,
): TrieNode => {
  if (!node) return buildTrie(namespace, [entry], depth)!;
  if (node.kind === 'bucket') {
    const entries = new Map(node.entries);
    entries.set(entry.keyHash, entry);
    return buildTrie(namespace, Array.from(entries.values()), depth)!;
  }
  const slot = pathNibble(entry.path, depth);
  const children = new Map(node.children);
  const previousChild = children.get(slot) ?? null;
  const nextChild = updateTrie(namespace, previousChild, entry, depth + 1);
  children.set(slot, nextChild);
  return {
    kind: 'branch',
    count: node.count - (previousChild?.count ?? 0) + nextChild.count,
    children,
    hash: branchHash(namespace, depth, children),
  };
};

const deleteFromTrie = (
  namespace: AccountCommittedMap,
  node: TrieNode | null,
  keyHash: string,
  path: Uint8Array,
  depth = 0,
): TrieNode | null => {
  if (!node) return null;
  if (node.kind === 'bucket') {
    if (!node.entries.has(keyHash)) return node;
    const entries = new Map(node.entries);
    entries.delete(keyHash);
    return buildTrie(namespace, Array.from(entries.values()), depth);
  }
  const slot = pathNibble(path, depth);
  const previousChild = node.children.get(slot);
  if (!previousChild) return node;
  const children = new Map(node.children);
  const nextChild = deleteFromTrie(namespace, previousChild, keyHash, path, depth + 1);
  if (nextChild) children.set(slot, nextChild);
  else children.delete(slot);
  const count = node.count - previousChild.count + (nextChild?.count ?? 0);
  if (count === 0) return null;
  if (count <= MAX_BUCKET_ENTRIES) {
    const entries: TrieEntry[] = [];
    for (const child of children.values()) collectEntries(child, entries);
    return buildTrie(namespace, entries, depth);
  }
  return { kind: 'branch', count, children, hash: branchHash(namespace, depth, children) };
};

const accountMap = (
  account: AccountMachine,
  namespace: AccountCommittedMap,
): ReadonlyMap<unknown, unknown> => account[namespace] ?? new Map();

const buildCachedMap = (
  account: AccountMachine,
  namespace: AccountCommittedMap,
  encodeValue: EncodedValue,
): CachedMap => {
  const source = accountMap(account, namespace);
  const entries = Array.from(source, ([key, value]) => makeEntry(namespace, key, value, encodeValue));
  return { source, trie: buildTrie(namespace, entries), dirtyKeys: new Set() };
};

export const computeAccountMapCommitment = (
  account: AccountMachine,
  namespace: AccountCommittedMap,
  encodeValue: EncodedValue,
  cold = false,
  timing?: AccountMapCommitmentTiming,
): string => {
  const source = accountMap(account, namespace);
  if (cold) {
    if (timing) Object.assign(timing, { mode: 'cold-oracle', entries: source.size, dirtyKeys: source.size });
    return buildCachedMap(account, namespace, encodeValue).trie?.hash ?? EMPTY_MAP_ROOT;
  }
  let accountCache = readAccountCache(account);
  const accountCacheMissing = !accountCache;
  if (!accountCache) {
    accountCache = new Map();
    writeHiddenCache(account, ACCOUNT_CACHE, accountCache);
  }
  const previousCached = accountCache.get(namespace);
  const cacheMissing = !previousCached;
  const sourceReplaced = Boolean(previousCached && previousCached.source !== source);
  const cached = previousCached && previousCached.source === source
    ? previousCached
    : buildCachedMap(account, namespace, encodeValue);
  if (cacheMissing || sourceReplaced) {
    accountCache.set(namespace, cached);
  }
  const dirtyKeys = cached.dirtyKeys.size;
  if (timing) {
    Object.assign(timing, {
      mode: sourceReplaced
        ? 'source-replaced'
        : accountCacheMissing || cacheMissing
          ? 'cold-cache'
          : dirtyKeys > 0
            ? 'incremental'
            : 'cached',
      entries: source.size,
      dirtyKeys,
    });
  }
  for (const key of cached.dirtyKeys) {
    const keyHash = computeIntegrityDigest(concat([
      UTF8.encode(`xln.account.map.${namespace}.key`),
      encodeMapKey(key),
    ]));
    if (source.has(key)) {
      cached.trie = updateTrie(namespace, cached.trie, makeEntry(namespace, key, source.get(key), encodeValue));
    } else {
      cached.trie = deleteFromTrie(namespace, cached.trie, keyHash, hashBytes(keyHash));
    }
  }
  cached.dirtyKeys.clear();
  return cached.trie?.hash ?? EMPTY_MAP_ROOT;
};

export const invalidateAccountMapCommitment = (
  account: AccountMachine,
  namespace: AccountCommittedMap,
  key?: unknown,
): void => {
  const accountCache = readAccountCache(account);
  const cached = accountCache?.get(namespace);
  if (!cached) return;
  if (key === undefined) accountCache?.delete(namespace);
  else cached.dirtyKeys.add(key);
};

export const clearAccountCommitmentCache = (account: AccountMachine): void => {
  deleteHiddenCache(account, ACCOUNT_CACHE);
  deleteHiddenCache(account, STAGED_ACCOUNT_CACHE);
};

export const forkAccountCommitmentCache = (source: AccountMachine, target: AccountMachine): void => {
  const sourceCache = readAccountCache(source);
  if (sourceCache) {
    writeHiddenCache(target, ACCOUNT_CACHE, cloneCacheForTarget(sourceCache, target));
  }
  // A proposed Account frame carries the already-computed future trie in a
  // staged cache until its peer ACK commits that exact frame. Entity/Runtime
  // working-state clones happen between proposal and ACK, so dropping this
  // hidden property forced the committed account back to a full cold rebuild.
  const stagedSourceCache = readStagedAccountCache(source);
  if (stagedSourceCache) {
    writeHiddenCache(target, STAGED_ACCOUNT_CACHE, cloneCacheForTarget(stagedSourceCache, target));
  }
};

const cloneCacheForTarget = (
  sourceCache: AccountCommitmentCache,
  target: AccountMachine,
): AccountCommitmentCache => new Map(Array.from(sourceCache, ([namespace, cached]) => [
  namespace,
  {
    source: accountMap(target, namespace),
    trie: cached.trie,
    dirtyKeys: new Set(cached.dirtyKeys),
  },
]));

export const stageAccountCommitmentCache = (account: AccountMachine, future: AccountMachine): void => {
  const futureCache = readAccountCache(future);
  if (futureCache) writeHiddenCache(account, STAGED_ACCOUNT_CACHE, futureCache);
};

export const commitStagedAccountCommitmentCache = (account: AccountMachine): void => {
  const staged = readStagedAccountCache(account);
  if (!staged) return;
  writeHiddenCache(account, ACCOUNT_CACHE, cloneCacheForTarget(staged, account));
  deleteHiddenCache(account, STAGED_ACCOUNT_CACHE);
};

export const discardStagedAccountCommitmentCache = (account: AccountMachine): void => {
  deleteHiddenCache(account, STAGED_ACCOUNT_CACHE);
};

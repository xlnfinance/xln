import { ethers } from 'ethers';

import type { EntityState, Env, JurisdictionConfig, JurisdictionEvent } from '../types';
import type {
  CertifiedBoardAuthorityBinding,
  CertifiedBoardNodeStore,
  CertifiedBoardPatriciaNode,
  CertifiedBoardProof,
  CertifiedBoardRecord,
  CertifiedBoardRegistryState,
  CertifiedBoardSource,
} from '../types/entity-board-registry';

const ABI = ethers.AbiCoder.defaultAbiCoder();
const domain = (label: string): string => ethers.keccak256(ethers.toUtf8Bytes(label));
const STACK_DOMAIN = domain('xln.certified-board.stack.v1');
const KEY_DOMAIN = domain('xln.certified-board.key.v1');
const RECORD_DOMAIN = domain('xln.certified-board.record.v2');
const LEAF_DOMAIN = domain('xln.certified-board.leaf.v1');
const BRANCH_DOMAIN = domain('xln.certified-board.branch.v1');
export const EMPTY_CERTIFIED_BOARD_ROOT = domain('xln.certified-board.empty.v1');
const FOUNDATION_ENTITY_ID = ethers.toBeHex(1n, 32).toLowerCase();
const SOURCE_CODE: Record<CertifiedBoardSource, number> = {
  FoundationBootstrapped: 1,
  EntityRegistered: 2,
  BoardActivated: 3,
};
const normalizedText = (value: unknown): string => String(value ?? '').trim().toLowerCase();

const normalizeChainId = (value: unknown): number => {
  const chainId = Number(value);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error(`CERTIFIED_BOARD_STACK_CHAIN_INVALID:${String(value)}`);
  }
  return chainId;
};

const normalizeAddress = (value: unknown, label: string): string => {
  try {
    return ethers.getAddress(String(value ?? '')).toLowerCase();
  } catch {
    throw new Error(`CERTIFIED_BOARD_STACK_${label}_INVALID:${String(value ?? '')}`);
  }
};

const normalizeBytes32 = (value: unknown, label: string): string => {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`CERTIFIED_BOARD_${label}_INVALID:${normalized || 'missing'}`);
  }
  return normalized;
};

const normalizeJHeight = (value: unknown): number => {
  const height = Number(value);
  if (!Number.isSafeInteger(height) || height < 1) {
    throw new Error(`CERTIFIED_BOARD_J_HEIGHT_INVALID:${String(value)}`);
  }
  return height;
};

const normalizeUnixSeconds = (value: unknown, label: string): number => {
  let seconds: bigint;
  try {
    seconds = BigInt(String(value));
  } catch {
    throw new Error(`CERTIFIED_BOARD_${label}_INVALID:${String(value)}`);
  }
  if (seconds < 0n || seconds > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`CERTIFIED_BOARD_${label}_INVALID:${String(value)}`);
  }
  return Number(seconds);
};

export const getCertifiedBoardStackKey = (
  jurisdiction: Pick<JurisdictionConfig, 'chainId' | 'depositoryAddress' | 'entityProviderAddress'>,
): string => {
  const encoded = ABI.encode(
    ['bytes32', 'uint256', 'address', 'address'],
    [
      STACK_DOMAIN,
      normalizeChainId(jurisdiction.chainId),
      normalizeAddress(jurisdiction.depositoryAddress, 'DEPOSITORY'),
      normalizeAddress(jurisdiction.entityProviderAddress, 'ENTITY_PROVIDER'),
    ],
  );
  return ethers.keccak256(encoded).toLowerCase();
};

export const getCertifiedBoardEntityKey = (stackKey: string, entityId: string): string =>
  ethers.keccak256(ABI.encode(
    ['bytes32', 'bytes32', 'bytes32'],
    [KEY_DOMAIN, normalizeBytes32(stackKey, 'STACK_KEY'), normalizeBytes32(entityId, 'ENTITY_ID')],
  )).toLowerCase();

export const createEmptyCertifiedBoardRegistryState = (
  jurisdiction: Pick<JurisdictionConfig, 'chainId' | 'depositoryAddress' | 'entityProviderAddress'>,
): CertifiedBoardRegistryState => ({
  stackKey: getCertifiedBoardStackKey(jurisdiction),
  boardRegistryRoot: EMPTY_CERTIFIED_BOARD_ROOT,
  finalizedJHeight: 0,
  finalizedJBlockHash: ethers.ZeroHash,
  eventHistoryRoot: ethers.ZeroHash,
});

const sameRecord = (left: CertifiedBoardRecord, right: CertifiedBoardRecord): boolean =>
  left.stackKey === right.stackKey &&
  left.entityId === right.entityId &&
  left.boardHash === right.boardHash &&
  left.boardEpoch === right.boardEpoch &&
  left.previousBoardHash === right.previousBoardHash &&
  left.previousBoardValidUntil === right.previousBoardValidUntil &&
  left.activatedAtJHeight === right.activatedAtJHeight &&
  left.logIndex === right.logIndex &&
  left.blockHash === right.blockHash &&
  left.transactionHash === right.transactionHash &&
  left.source === right.source;

export const hashCertifiedBoardRecord = (record: CertifiedBoardRecord): string =>
  ethers.keccak256(ABI.encode(
    ['bytes32', 'bytes32', 'bytes32', 'bytes32', 'uint64', 'bytes32', 'uint64', 'uint64', 'uint32', 'bytes32', 'bytes32', 'uint8'],
    [
      RECORD_DOMAIN,
      normalizeBytes32(record.stackKey, 'STACK_KEY'),
      normalizeBytes32(record.entityId, 'ENTITY_ID'),
      normalizeBytes32(record.boardHash, 'HASH'),
      record.boardEpoch,
      normalizeBytes32(record.previousBoardHash, 'PREVIOUS_HASH'),
      normalizeUnixSeconds(record.previousBoardValidUntil, 'PREVIOUS_VALID_UNTIL'),
      normalizeJHeight(record.activatedAtJHeight),
      record.logIndex,
      normalizeBytes32(record.blockHash, 'BLOCK_HASH'),
      normalizeBytes32(record.transactionHash, 'TRANSACTION_HASH'),
      SOURCE_CODE[record.source],
    ],
  )).toLowerCase();

export const hashCertifiedBoardNode = (node: CertifiedBoardPatriciaNode): string => {
  if (node.version !== 1) throw new Error(`CERTIFIED_BOARD_NODE_VERSION_INVALID:${String(node.version)}`);
  if (node.type === 'leaf') {
    const key = normalizeBytes32(node.key, 'NODE_KEY');
    const expectedKey = getCertifiedBoardEntityKey(node.record.stackKey, node.record.entityId);
    if (key !== expectedKey) throw new Error(`CERTIFIED_BOARD_NODE_KEY_MISMATCH:${key}:${expectedKey}`);
    return ethers.keccak256(ABI.encode(
      ['bytes32', 'uint8', 'bytes32', 'bytes32'],
      [LEAF_DOMAIN, 1, key, hashCertifiedBoardRecord(node.record)],
    )).toLowerCase();
  }
  if (!Number.isInteger(node.bit) || node.bit < 0 || node.bit > 255) {
    throw new Error(`CERTIFIED_BOARD_BRANCH_BIT_INVALID:${String(node.bit)}`);
  }
  const left = normalizeBytes32(node.left, 'BRANCH_LEFT');
  const right = normalizeBytes32(node.right, 'BRANCH_RIGHT');
  if (left === right) throw new Error(`CERTIFIED_BOARD_BRANCH_UNARY:${left}`);
  return ethers.keccak256(ABI.encode(
    ['bytes32', 'uint8', 'uint16', 'bytes32', 'bytes32'],
    [BRANCH_DOMAIN, 1, node.bit, left, right],
  )).toLowerCase();
};

const readNode = (store: ReadonlyMap<string, CertifiedBoardPatriciaNode>, hash: string): CertifiedBoardPatriciaNode => {
  const normalized = normalizeBytes32(hash, 'NODE_HASH');
  const node = store.get(normalized);
  if (!node) throw new Error(`CERTIFIED_BOARD_NODE_MISSING:${normalized}`);
  if (Object.isFrozen(node) && (node.type === 'branch' || Object.isFrozen(node.record))) return node;
  const actual = hashCertifiedBoardNode(node);
  if (actual !== normalized) throw new Error(`CERTIFIED_BOARD_NODE_CORRUPT:${normalized}:${actual}`);
  if (node.type === 'leaf') Object.freeze(node.record);
  Object.freeze(node);
  return node;
};

const keyBit = (key: string, bit: number): 0 | 1 => {
  const byte = Number.parseInt(key.slice(2 + Math.floor(bit / 8) * 2, 4 + Math.floor(bit / 8) * 2), 16);
  return ((byte >> (7 - (bit % 8))) & 1) as 0 | 1;
};

const firstDifferentBit = (left: string, right: string): number => {
  for (let bit = 0; bit < 256; bit += 1) if (keyBit(left, bit) !== keyBit(right, bit)) return bit;
  return -1;
};

type PatriciaPath = Array<{ hash: string; node: Extract<CertifiedBoardPatriciaNode, { type: 'branch' }>; direction: 0 | 1 }>;

const walkToLeaf = (
  store: ReadonlyMap<string, CertifiedBoardPatriciaNode>,
  root: string,
  key: string,
): { path: PatriciaPath; hash: string; leaf: Extract<CertifiedBoardPatriciaNode, { type: 'leaf' }> } => {
  let hash = normalizeBytes32(root, 'ROOT');
  const path: PatriciaPath = [];
  const seen = new Set<string>();
  let previousBit = -1;
  while (true) {
    if (seen.has(hash)) throw new Error(`CERTIFIED_BOARD_NODE_CYCLE:${hash}`);
    if (seen.size > 256) throw new Error('CERTIFIED_BOARD_PROOF_OVERSIZED');
    seen.add(hash);
    const node = readNode(store, hash);
    if (node.type === 'leaf') return { path, hash, leaf: node };
    if (node.bit <= previousBit) throw new Error(`CERTIFIED_BOARD_BRANCH_ORDER_INVALID:${previousBit}:${node.bit}`);
    previousBit = node.bit;
    const direction = keyBit(key, node.bit);
    path.push({ hash, node, direction });
    hash = direction === 0 ? node.left : node.right;
  }
};

export const lookupCertifiedBoardRecord = (
  store: ReadonlyMap<string, CertifiedBoardPatriciaNode>,
  root: string,
  stackKey: string,
  entityId: string,
): CertifiedBoardRecord | null => {
  const normalizedRoot = normalizeBytes32(root, 'ROOT');
  if (normalizedRoot === EMPTY_CERTIFIED_BOARD_ROOT) return null;
  const key = getCertifiedBoardEntityKey(stackKey, entityId);
  const { leaf } = walkToLeaf(store, normalizedRoot, key);
  return leaf.key === key ? { ...leaf.record } : null;
};

const putNode = (
  nodes: Map<string, CertifiedBoardPatriciaNode>,
  node: CertifiedBoardPatriciaNode,
): string => {
  const hash = hashCertifiedBoardNode(node);
  const existing = nodes.get(hash);
  if (existing && hashCertifiedBoardNode(existing) !== hash) {
    throw new Error(`CERTIFIED_BOARD_NODE_HASH_COLLISION:${hash}`);
  }
  if (node.type === 'leaf') Object.freeze(node.record);
  Object.freeze(node);
  nodes.set(hash, node);
  return hash;
};

const rebuildAncestors = (
  nodes: Map<string, CertifiedBoardPatriciaNode>,
  path: PatriciaPath,
  childHash: string,
): string => {
  let hash = childHash;
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const entry = path[index]!;
    hash = putNode(nodes, {
      ...entry.node,
      left: entry.direction === 0 ? hash : entry.node.left,
      right: entry.direction === 1 ? hash : entry.node.right,
    });
  }
  return hash;
};

export const putCertifiedBoardRecord = (
  store: ReadonlyMap<string, CertifiedBoardPatriciaNode>,
  root: string,
  record: CertifiedBoardRecord,
): { root: string; newNodes: CertifiedBoardNodeStore } => {
  const key = getCertifiedBoardEntityKey(record.stackKey, record.entityId);
  const leaf: CertifiedBoardPatriciaNode = { version: 1, type: 'leaf', key, record: { ...record } };
  const newNodes: CertifiedBoardNodeStore = new Map();
  const leafHash = putNode(newNodes, leaf);
  if (root === EMPTY_CERTIFIED_BOARD_ROOT) return { root: leafHash, newNodes };

  const walked = walkToLeaf(store, root, key);
  if (walked.leaf.key === key) {
    if (sameRecord(walked.leaf.record, record)) return { root, newNodes: new Map() };
    return { root: rebuildAncestors(newNodes, walked.path, leafHash), newNodes };
  }

  const differingBit = firstDifferentBit(key, walked.leaf.key);
  if (differingBit < 0) throw new Error(`CERTIFIED_BOARD_KEY_COLLISION:${key}`);
  const insertionIndex = walked.path.findIndex((entry) => entry.node.bit >= differingBit);
  const prefixLength = insertionIndex < 0 ? walked.path.length : insertionIndex;
  const prefix = walked.path.slice(0, prefixLength);
  const subtreeHash = prefixLength < walked.path.length ? walked.path[prefixLength]!.hash : walked.hash;
  const branchHash = putNode(newNodes, {
    version: 1,
    type: 'branch',
    bit: differingBit,
    left: keyBit(key, differingBit) === 0 ? leafHash : subtreeHash,
    right: keyBit(key, differingBit) === 1 ? leafHash : subtreeHash,
  });
  return { root: rebuildAncestors(newNodes, prefix, branchHash), newNodes };
};

const makeRecord = (params: {
  stackKey: string;
  entityId: unknown;
  boardHash: unknown;
  boardEpoch?: unknown;
  previousBoardHash?: unknown;
  previousBoardValidUntil?: unknown;
  jHeight: unknown;
  blockHash: unknown;
  transactionHash: unknown;
  logIndex: unknown;
  source: CertifiedBoardSource;
}): CertifiedBoardRecord => ({
  stackKey: normalizeBytes32(params.stackKey, 'STACK_KEY'),
  entityId: normalizeBytes32(params.entityId, 'ENTITY_ID'),
  boardHash: normalizeBytes32(params.boardHash, 'HASH'),
  boardEpoch: (() => {
    const epoch = Number(params.boardEpoch ?? 0);
    if (!Number.isSafeInteger(epoch) || epoch < 0) {
      throw new Error(`CERTIFIED_BOARD_EPOCH_INVALID:${String(params.boardEpoch)}`);
    }
    return epoch;
  })(),
  previousBoardHash: normalizeBytes32(params.previousBoardHash ?? ethers.ZeroHash, 'PREVIOUS_HASH'),
  previousBoardValidUntil: normalizeUnixSeconds(params.previousBoardValidUntil ?? 0, 'PREVIOUS_VALID_UNTIL'),
  activatedAtJHeight: normalizeJHeight(params.jHeight),
  logIndex: (() => {
    const index = Number(params.logIndex);
    if (!Number.isSafeInteger(index) || index < 0 || index > 0xffff_ffff) {
      throw new Error(`CERTIFIED_BOARD_LOG_INDEX_INVALID:${String(params.logIndex)}`);
    }
    return index;
  })(),
  blockHash: normalizeBytes32(params.blockHash, 'BLOCK_HASH'),
  transactionHash: normalizeBytes32(params.transactionHash, 'TRANSACTION_HASH'),
  source: params.source,
});

export const applyCertifiedBoardRegistryEvent = (
  current: CertifiedBoardRegistryState | undefined,
  store: ReadonlyMap<string, CertifiedBoardPatriciaNode>,
  jurisdiction: JurisdictionConfig,
  event: JurisdictionEvent,
): { state: CertifiedBoardRegistryState; newNodes: CertifiedBoardNodeStore } => {
  const stackKey = getCertifiedBoardStackKey(jurisdiction);
  const state = current ? { ...current } : createEmptyCertifiedBoardRegistryState(jurisdiction);
  if (state.stackKey !== stackKey) throw new Error(`CERTIFIED_BOARD_STACK_MISMATCH:${state.stackKey}:${stackKey}`);
  if (event.type !== 'FoundationBootstrapped' && event.type !== 'EntityRegistered' && event.type !== 'BoardActivated') {
    return { state, newNodes: new Map() };
  }
  const jHeight = normalizeJHeight(event.blockNumber);
  const blockHash = normalizeBytes32(event.blockHash, 'BLOCK_HASH');
  const transactionHash = normalizeBytes32(event.transactionHash, 'TRANSACTION_HASH');
  const logIndex = Number(event.logIndex);
  const existingStore = store;

  let record: CertifiedBoardRecord;
  if (event.type === 'FoundationBootstrapped') {
    const deployment = jurisdiction.entityProviderDeploymentBlock;
    if (deployment !== undefined && Number(deployment) !== jHeight) {
      throw new Error(`CERTIFIED_BOARD_BOOTSTRAP_HEIGHT_MISMATCH:expected=${String(deployment)}:actual=${jHeight}`);
    }
    record = makeRecord({
      stackKey,
      entityId: FOUNDATION_ENTITY_ID,
      boardHash: event.data.boardHash,
      jHeight,
      blockHash,
      transactionHash,
      logIndex,
      source: 'FoundationBootstrapped',
    });
  } else {
    const foundation = lookupCertifiedBoardRecord(existingStore, state.boardRegistryRoot, stackKey, FOUNDATION_ENTITY_ID);
    if (!foundation) throw new Error(`CERTIFIED_BOARD_STACK_NOT_BOOTSTRAPPED:${stackKey}`);
    if (event.type === 'EntityRegistered') {
      const entityId = normalizeBytes32(event.data.entityId, 'ENTITY_ID');
      let entityNumber: bigint;
      try { entityNumber = BigInt(String(event.data.entityNumber)); } catch {
        throw new Error(`CERTIFIED_BOARD_ENTITY_NUMBER_INVALID:${String(event.data.entityNumber)}`);
      }
      if (entityNumber <= 0n || entityNumber > ethers.MaxUint256 || BigInt(entityId) !== entityNumber) {
        throw new Error(`CERTIFIED_BOARD_ENTITY_NUMBER_MISMATCH:${entityId}:${entityNumber.toString()}`);
      }
      record = makeRecord({ stackKey, entityId, boardHash: event.data.boardHash, jHeight, blockHash, transactionHash, logIndex, source: 'EntityRegistered' });
    } else {
      const entityId = normalizeBytes32(event.data.entityId, 'ENTITY_ID');
      const previous = lookupCertifiedBoardRecord(existingStore, state.boardRegistryRoot, stackKey, entityId);
      if (!previous) throw new Error(`CERTIFIED_BOARD_ACTIVATION_BEFORE_REGISTRATION:${entityId}`);
      record = makeRecord({
        stackKey,
        entityId,
        boardHash: event.data.newBoardHash,
        boardEpoch: previous.activatedAtJHeight === jHeight && previous.logIndex === logIndex
          ? previous.boardEpoch
          : previous.boardEpoch + 1,
        previousBoardHash: event.data.previousBoardHash,
        previousBoardValidUntil: event.data.previousBoardValidUntil,
        jHeight,
        blockHash,
        transactionHash,
        logIndex,
        source: 'BoardActivated',
      });
    }
  }

  const existing = lookupCertifiedBoardRecord(existingStore, state.boardRegistryRoot, stackKey, record.entityId);
  if (record.source === 'BoardActivated') {
    if (!existing) throw new Error(`CERTIFIED_BOARD_ACTIVATION_BEFORE_REGISTRATION:${record.entityId}`);
    const order = existing.activatedAtJHeight === record.activatedAtJHeight
      ? existing.logIndex - record.logIndex
      : existing.activatedAtJHeight - record.activatedAtJHeight;
    if (order > 0) {
      throw new Error(`CERTIFIED_BOARD_ACTIVATION_STALE:${record.entityId}:${record.activatedAtJHeight}`);
    }
    if (order === 0) {
      if (!sameRecord(existing, record)) throw new Error(`CERTIFIED_BOARD_ACTIVE_CONFLICT:${record.entityId}:${record.activatedAtJHeight}`);
      return { state, newNodes: new Map() };
    }
    if (record.previousBoardHash !== existing.boardHash) {
      throw new Error(
        `CERTIFIED_BOARD_PREVIOUS_HASH_MISMATCH:${record.entityId}:` +
        `expected=${existing.boardHash}:received=${record.previousBoardHash}`,
      );
    }
    if (record.previousBoardValidUntil <= 0) {
      throw new Error(`CERTIFIED_BOARD_PREVIOUS_EXPIRY_INVALID:${record.entityId}`);
    }
  } else if (existing) {
    if (!sameRecord(existing, record)) throw new Error(`CERTIFIED_BOARD_REGISTRATION_CONFLICT:${record.entityId}`);
    return { state, newNodes: new Map() };
  }

  const updated = putCertifiedBoardRecord(existingStore, state.boardRegistryRoot, record);
  return { state: { ...state, boardRegistryRoot: updated.root }, newNodes: updated.newNodes };
};

export const advanceCertifiedBoardFinality = (
  current: CertifiedBoardRegistryState | undefined,
  jurisdiction: JurisdictionConfig,
  finalizedJHeight: number,
  finalizedJBlockHash: string,
  eventHistoryRoot: string,
): CertifiedBoardRegistryState => {
  const state = current ? { ...current } : createEmptyCertifiedBoardRegistryState(jurisdiction);
  const stackKey = getCertifiedBoardStackKey(jurisdiction);
  if (state.stackKey !== stackKey) throw new Error(`CERTIFIED_BOARD_STACK_MISMATCH:${state.stackKey}:${stackKey}`);
  if (!Number.isSafeInteger(finalizedJHeight) || finalizedJHeight < state.finalizedJHeight) {
    throw new Error(`CERTIFIED_BOARD_FINALITY_REWIND:${state.finalizedJHeight}:${String(finalizedJHeight)}`);
  }
  return {
    ...state,
    finalizedJHeight,
    finalizedJBlockHash: normalizeBytes32(finalizedJBlockHash, 'FINALIZED_BLOCK_HASH'),
    eventHistoryRoot: normalizeBytes32(eventHistoryRoot, 'EVENT_HISTORY_ROOT'),
  };
};

export const getCertifiedBoardNodeStore = (env: Env): CertifiedBoardNodeStore => {
  env.runtimeState ??= {};
  env.runtimeState.certifiedBoardNodes ??= new Map();
  return env.runtimeState.certifiedBoardNodes;
};

export const cacheCertifiedBoardNodes = (env: Env, nodes: ReadonlyMap<string, CertifiedBoardPatriciaNode>): void => {
  const store = getCertifiedBoardNodeStore(env);
  env.runtimeState ??= {};
  env.runtimeState.pendingCertifiedBoardNodes ??= new Map();
  for (const [hash, node] of nodes) {
    if (hashCertifiedBoardNode(node) !== hash) throw new Error(`CERTIFIED_BOARD_NODE_CORRUPT:${hash}`);
    if (node.type === 'leaf') Object.freeze(node.record);
    Object.freeze(node);
    store.set(hash, node);
    env.runtimeState.pendingCertifiedBoardNodes.set(hash, node);
  }
};

export const resolveObserverCertifiedBoardRecord = (
  observerState: EntityState,
  store: ReadonlyMap<string, CertifiedBoardPatriciaNode>,
  entityId: string,
): CertifiedBoardRecord | null => {
  const jurisdiction = observerState.config.jurisdiction;
  const registry = observerState.certifiedBoardState;
  if (!jurisdiction || !registry) return null;
  const stackKey = getCertifiedBoardStackKey(jurisdiction);
  if (registry.stackKey !== stackKey) throw new Error(`CERTIFIED_BOARD_STACK_MISMATCH:${registry.stackKey}:${stackKey}`);
  return lookupCertifiedBoardRecord(store, registry.boardRegistryRoot, stackKey, entityId);
};

export const resolveObserverCertifiedBoardHash = (
  observerState: EntityState,
  store: ReadonlyMap<string, CertifiedBoardPatriciaNode>,
  entityId: string,
): string | null => resolveObserverCertifiedBoardRecord(observerState, store, entityId)?.boardHash ?? null;

export const resolveSigningCertifiedBoardHash = (
  env: Env,
  entityId: string,
  requestedJurisdiction?: Pick<JurisdictionConfig, 'chainId' | 'depositoryAddress' | 'entityProviderAddress'>,
  candidateState?: EntityState,
): string | null => {
  const normalizedEntityId = normalizeBytes32(entityId, 'ENTITY_ID');
  const states = candidateState
    ? [candidateState]
    : [...env.eReplicas.values()]
        .filter((replica) => normalizeBytes32(replica.state.entityId, 'ENTITY_ID') === normalizedEntityId)
        .map((replica) => replica.state);
  if (states.length === 0) return null;
  const store = getCertifiedBoardNodeStore(env);
  const bindings = states.map((state) => {
    const jurisdiction = state.config.jurisdiction;
    if (!jurisdiction) throw new Error(`CERTIFIED_BOARD_SIGNING_STACK_MISSING:${normalizedEntityId}`);
    const stackKey = getCertifiedBoardStackKey(jurisdiction);
    if (requestedJurisdiction && getCertifiedBoardStackKey(requestedJurisdiction) !== stackKey) {
      throw new Error(`CERTIFIED_BOARD_SIGNING_STACK_MISMATCH:${normalizedEntityId}`);
    }
    const registry = state.certifiedBoardState;
    if (!registry) throw new Error(`CERTIFIED_BOARD_SIGNING_ROOT_MISSING:${normalizedEntityId}:${stackKey}`);
    const record = lookupCertifiedBoardRecord(store, registry.boardRegistryRoot, stackKey, normalizedEntityId);
    if (!record) throw new Error(`CERTIFIED_BOARD_SIGNING_MEMBERSHIP_MISSING:${normalizedEntityId}:${stackKey}`);
    return `${stackKey}:${record.activatedAtJHeight}:${record.logIndex}:${record.boardEpoch}:${record.boardHash}`;
  });
  const unique = new Set(bindings);
  if (unique.size !== 1) throw new Error(`CERTIFIED_BOARD_SIGNING_REPLICA_DIVERGENCE:${normalizedEntityId}:${[...unique].sort().join(',')}`);
  return bindings[0]!.slice(bindings[0]!.lastIndexOf(':') + 1);
};

/**
 * Read-only discovery for gossip/profile validation. Profile metadata is not an
 * authority selector: the locally Entity-certified universe must contain the id
 * in exactly one stack. Consensus mutation paths must use observer-root lookup.
 */
export const resolveUniqueCertifiedRegisteredBoardRecord = (
  env: Env,
  entityId: string,
): CertifiedBoardRecord | null => {
  const normalizedEntityId = normalizeBytes32(entityId, 'ENTITY_ID');
  const store = getCertifiedBoardNodeStore(env);
  const perStack = new Map<string, CertifiedBoardRecord[]>();
  const seenRoots = new Set<string>();
  for (const replica of env.eReplicas.values()) {
    const registry = replica.state.certifiedBoardState;
    if (!registry) continue;
    const rootIdentity = `${registry.stackKey}:${registry.boardRegistryRoot}`;
    if (seenRoots.has(rootIdentity)) continue;
    seenRoots.add(rootIdentity);
    const record = lookupCertifiedBoardRecord(store, registry.boardRegistryRoot, registry.stackKey, normalizedEntityId);
    if (!record) continue;
    const records = perStack.get(record.stackKey) ?? [];
    records.push(record);
    perStack.set(record.stackKey, records);
  }
  if (perStack.size === 0) return null;
  if (perStack.size > 1) {
    throw new Error(
      `CERTIFIED_BOARD_AUTHORITY_MULTI_STACK_AMBIGUOUS:${normalizedEntityId}:${[...perStack.keys()].sort().join(',')}`,
    );
  }
  const records = [...perStack.values()][0]!;
  const latest = records.reduce((selected, record) =>
    record.activatedAtJHeight > selected.activatedAtJHeight ||
    (
      record.activatedAtJHeight === selected.activatedAtJHeight &&
      record.logIndex > selected.logIndex
    )
      ? record
      : selected);
  const current = records.filter((record) =>
    record.activatedAtJHeight === latest.activatedAtJHeight &&
    record.logIndex === latest.logIndex);
  const recordHashes = new Set(current.map(hashCertifiedBoardRecord));
  if (recordHashes.size !== 1) {
    throw new Error(
      `CERTIFIED_BOARD_AUTHORITY_AMBIGUOUS:${normalizedEntityId}:` +
      `height=${latest.activatedAtJHeight}:logIndex=${latest.logIndex}`,
    );
  }
  return current[0]!;
};

export const resolveCertifiedRegisteredBoardHash = (
  env: Env,
  entityId: string,
  claimedJurisdiction: Pick<JurisdictionConfig, 'chainId' | 'depositoryAddress' | 'entityProviderAddress'>,
): string | null => {
  const record = resolveUniqueCertifiedRegisteredBoardRecord(env, entityId);
  if (!record) return null;
  const claimedStack = getCertifiedBoardStackKey(claimedJurisdiction);
  if (record.stackKey !== claimedStack) {
    throw new Error(`CERTIFIED_BOARD_AUTHORITY_STACK_CLAIM_MISMATCH:${record.stackKey}:${claimedStack}`);
  }
  return record.boardHash;
};

export const createCertifiedBoardProof = (
  store: ReadonlyMap<string, CertifiedBoardPatriciaNode>,
  state: CertifiedBoardRegistryState,
  entityId: string,
): CertifiedBoardProof => {
  if (state.boardRegistryRoot === EMPTY_CERTIFIED_BOARD_ROOT) {
    return { version: 1, stackKey: state.stackKey, entityId: normalizeBytes32(entityId, 'ENTITY_ID'), nodes: [] };
  }
  const key = getCertifiedBoardEntityKey(state.stackKey, entityId);
  const walked = walkToLeaf(store, state.boardRegistryRoot, key);
  return {
    version: 1,
    stackKey: state.stackKey,
    entityId: normalizeBytes32(entityId, 'ENTITY_ID'),
    nodes: [...walked.path.map((entry) => ({ ...entry.node })), { ...walked.leaf, record: { ...walked.leaf.record } }],
  };
};

/**
 * Bind a registered source output to the exact Entity-certified jurisdiction
 * prefix used by its validators. Lazy entities have no registry membership and
 * therefore return null; their board remains self-authenticating via entityId.
 */
export const createCertifiedBoardAuthorityBinding = (
  state: EntityState,
  store: ReadonlyMap<string, CertifiedBoardPatriciaNode>,
): CertifiedBoardAuthorityBinding | null => {
  const registry = state.certifiedBoardState;
  const jurisdiction = state.config.jurisdiction;
  if (!registry || !jurisdiction) return null;
  const stackKey = getCertifiedBoardStackKey(jurisdiction);
  if (registry.stackKey !== stackKey) {
    throw new Error(`CERTIFIED_BOARD_STACK_MISMATCH:${registry.stackKey}:${stackKey}`);
  }
  const record = lookupCertifiedBoardRecord(
    store,
    registry.boardRegistryRoot,
    stackKey,
    state.entityId,
  );
  if (!record) return null;
  const finality = state.jHistoryFinality;
  if (
    registry.finalizedJHeight !== state.lastFinalizedJHeight ||
    !finality ||
    finality.finalizedThroughHeight !== registry.finalizedJHeight ||
    normalizedText(finality.eventHistoryRoot) !== registry.eventHistoryRoot ||
    normalizedText(finality.tipBlockHash) !== registry.finalizedJBlockHash
  ) {
    throw new Error(`CERTIFIED_BOARD_OUTPUT_FINALITY_DIVERGENCE:${state.entityId}`);
  }
  return {
    version: 4,
    stackKey,
    record,
  };
};

export const verifyCertifiedBoardProof = (
  root: string,
  proof: CertifiedBoardProof,
): CertifiedBoardRecord | null => {
  if (proof.version !== 1) throw new Error(`CERTIFIED_BOARD_PROOF_VERSION_INVALID:${String(proof.version)}`);
  const normalizedRoot = normalizeBytes32(root, 'ROOT');
  const key = getCertifiedBoardEntityKey(proof.stackKey, proof.entityId);
  if (normalizedRoot === EMPTY_CERTIFIED_BOARD_ROOT) {
    if (proof.nodes.length !== 0) throw new Error('CERTIFIED_BOARD_PROOF_TRAILING_NODES');
    return null;
  }
  if (proof.nodes.length < 1 || proof.nodes.length > 257) throw new Error('CERTIFIED_BOARD_PROOF_LENGTH_INVALID');
  let expectedHash = normalizedRoot;
  let previousBit = -1;
  for (let index = 0; index < proof.nodes.length; index += 1) {
    const node = proof.nodes[index]!;
    const actualHash = hashCertifiedBoardNode(node);
    if (actualHash !== expectedHash) throw new Error(`CERTIFIED_BOARD_PROOF_LINK_INVALID:${index}`);
    if (node.type === 'leaf') {
      if (index !== proof.nodes.length - 1) throw new Error('CERTIFIED_BOARD_PROOF_TRAILING_NODES');
      return node.key === key ? { ...node.record } : null;
    }
    if (node.bit <= previousBit) throw new Error(`CERTIFIED_BOARD_BRANCH_ORDER_INVALID:${previousBit}:${node.bit}`);
    previousBit = node.bit;
    expectedHash = keyBit(key, node.bit) === 0 ? node.left : node.right;
  }
  throw new Error('CERTIFIED_BOARD_PROOF_TERMINAL_LEAF_MISSING');
};

export const collectReachableCertifiedBoardNodes = (
  store: ReadonlyMap<string, CertifiedBoardPatriciaNode>,
  roots: Iterable<string>,
): CertifiedBoardNodeStore => {
  const reachable: CertifiedBoardNodeStore = new Map();
  const pending = [...new Set([...roots].map((root) => normalizeBytes32(root, 'ROOT')))].filter(
    (root) => root !== EMPTY_CERTIFIED_BOARD_ROOT,
  );
  while (pending.length > 0) {
    const hash = pending.pop()!;
    if (reachable.has(hash)) continue;
    const node = readNode(store, hash);
    reachable.set(hash, node);
    if (node.type === 'branch') pending.push(node.left, node.right);
  }
  return reachable;
};

export const assertCertifiedBoardRootsAvailable = (env: Env): void => {
  const roots = [...env.eReplicas.values()]
    .map((replica) => replica.state.certifiedBoardState?.boardRegistryRoot)
    .filter((root): root is string => Boolean(root));
  collectReachableCertifiedBoardNodes(getCertifiedBoardNodeStore(env), roots);
};

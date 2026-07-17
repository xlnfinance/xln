import { ethers } from 'ethers';

import { LIMITS } from '../constants';
import type {
  ConsumptionAccumulatorState,
  ConsumptionApplyResult,
  ConsumptionBranchNode,
  ConsumptionFrontierValue,
  ConsumptionLeafNode,
  ConsumptionNode,
  ConsumptionNodeEntry,
  ConsumptionNodeStore,
  ConsumptionOutputIdentity,
  ConsumptionProof,
  ConsumptionProofResult,
  ConsumptionQuarantineEvidence,
} from './consumption-accumulator-types';

export type {
  ConsumptionAccumulatorState,
  ConsumptionApplyResult,
  ConsumptionBranchNode,
  ConsumptionFrontierValue,
  ConsumptionLeafNode,
  ConsumptionNode,
  ConsumptionNodeEntry,
  ConsumptionNodeStore,
  ConsumptionOutputIdentity,
  ConsumptionProof,
  ConsumptionProofResult,
  ConsumptionQuarantineEvidence,
} from './consumption-accumulator-types';

const ABI = ethers.AbiCoder.defaultAbiCoder();
const domain = (label: string): string => ethers.keccak256(ethers.toUtf8Bytes(label)).toLowerCase();
const KEY_DOMAIN = domain('xln.consumption-frontier.key.v2');
const FRONTIER_DOMAIN = domain('xln.consumption-frontier.value.v2');
const LEAF_DOMAIN = domain('xln.consumption-frontier.leaf.v2');
const BRANCH_DOMAIN = domain('xln.consumption-frontier.branch.v2');
export const EMPTY_CONSUMPTION_ROOT = domain('xln.consumption-frontier.empty.v2');
export const MAX_CONSUMPTION_PROOF_NODES = 257;
export const MAX_CONSUMPTION_PROOF_BYTES = LIMITS.MAX_FRAME_SIZE_BYTES;
export const MAX_CONSUMPTION_HANKO_BYTES = 1_000_000;
export const MAX_CONSUMPTION_RELATIONSHIPS_PER_ENTITY = BigInt(
  LIMITS.MAX_ACCOUNTS_PER_ENTITY * 5,
);
const UINT64_MAX = (1n << 64n) - 1n;
const CONSUMPTION_LANES = new Set<ConsumptionOutputIdentity['lane']>([
  'generic',
  'account-frame',
  'account-ack',
  'account-dispute',
  'account-settlement',
]);

const record = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}_INVALID`);
  return value as Record<string, unknown>;
};

const exactKeys = (value: Record<string, unknown>, expected: readonly string[], label: string): void => {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    throw new Error(`${label}_FIELDS_INVALID:${actual.join(',')}`);
  }
};

const bytes32 = (value: unknown, label: string): string => {
  if (typeof value !== 'string') throw new Error(`${label}_INVALID:${String(value)}`);
  const normalized = value.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) throw new Error(`${label}_INVALID:${normalized || 'missing'}`);
  return normalized;
};

const boundedUint = (value: unknown, max: bigint, label: string): bigint => {
  if (typeof value !== 'bigint' && (typeof value !== 'number' || !Number.isSafeInteger(value))) {
    throw new Error(`${label}_INVALID:${String(value)}`);
  }
  const normalized = typeof value === 'bigint' ? value : BigInt(value);
  if (normalized < 0n || normalized > max) throw new Error(`${label}_INVALID:${String(value)}`);
  return normalized;
};

const hanko = (value: unknown, label: string): string => {
  if (typeof value !== 'string') throw new Error(`${label}_INVALID`);
  const normalized = value.toLowerCase();
  if (!/^0x(?:[0-9a-f]{2})+$/.test(normalized)) throw new Error(`${label}_INVALID`);
  if ((normalized.length - 2) / 2 > MAX_CONSUMPTION_HANKO_BYTES) throw new Error(`${label}_OVERSIZED`);
  return normalized;
};

const parseQuarantine = (value: unknown): ConsumptionQuarantineEvidence => {
  const source = record(value, 'CONSUMPTION_QUARANTINE');
  exactKeys(source, [
    'sequence',
    'conflictingSemanticHash',
    'conflictingOutputHash',
    'conflictingOutputHanko',
  ], 'CONSUMPTION_QUARANTINE');
  return Object.freeze({
    sequence: boundedUint(source['sequence'], UINT64_MAX, 'CONSUMPTION_QUARANTINE_SEQUENCE'),
    conflictingSemanticHash: bytes32(
      source['conflictingSemanticHash'],
      'CONSUMPTION_QUARANTINE_SEMANTIC_HASH',
    ),
    conflictingOutputHash: bytes32(source['conflictingOutputHash'], 'CONSUMPTION_QUARANTINE_OUTPUT_HASH'),
    conflictingOutputHanko: hanko(source['conflictingOutputHanko'], 'CONSUMPTION_QUARANTINE_OUTPUT_HANKO'),
  });
};

const parseFrontier = (value: unknown): ConsumptionFrontierValue => {
  const source = record(value, 'CONSUMPTION_FRONTIER');
  const expected = [
    'version',
    'lastContiguousSeq',
    'lastSemanticHash',
    'count',
    'lastOutputHash',
    'lastOutputHanko',
    ...(source['quarantine'] === undefined ? [] : ['quarantine']),
  ];
  exactKeys(source, expected, 'CONSUMPTION_FRONTIER');
  if (source['version'] !== 1) throw new Error(`CONSUMPTION_FRONTIER_VERSION_INVALID:${String(source['version'])}`);
  const lastContiguousSeq = boundedUint(
    source['lastContiguousSeq'],
    UINT64_MAX,
    'CONSUMPTION_FRONTIER_SEQUENCE',
  );
  const count = boundedUint(source['count'], UINT64_MAX, 'CONSUMPTION_FRONTIER_COUNT');
  if (count < 1n) {
    throw new Error(`CONSUMPTION_FRONTIER_SEQUENCE_COUNT_MISMATCH:${lastContiguousSeq}:${count}`);
  }
  const quarantine = source['quarantine'] === undefined ? undefined : parseQuarantine(source['quarantine']);
  if (quarantine && quarantine.sequence !== lastContiguousSeq) {
    throw new Error('CONSUMPTION_QUARANTINE_SEQUENCE_MISMATCH');
  }
  return Object.freeze({
    version: 1,
    lastContiguousSeq,
    lastSemanticHash: bytes32(source['lastSemanticHash'], 'CONSUMPTION_FRONTIER_SEMANTIC_HASH'),
    count,
    lastOutputHash: bytes32(source['lastOutputHash'], 'CONSUMPTION_FRONTIER_OUTPUT_HASH'),
    lastOutputHanko: hanko(source['lastOutputHanko'], 'CONSUMPTION_FRONTIER_OUTPUT_HANKO'),
    ...(quarantine ? { quarantine } : {}),
  });
};

const normalizeIdentity = (value: ConsumptionOutputIdentity): ConsumptionOutputIdentity => {
  const source = record(value, 'CONSUMPTION_IDENTITY');
  exactKeys(source, [
    'targetEntityId',
    'sourceEntityId',
    'lane',
    'sequence',
    'semanticHash',
    'outputHash',
    'outputHanko',
  ], 'CONSUMPTION_IDENTITY');
  const sequence = boundedUint(source['sequence'], UINT64_MAX, 'CONSUMPTION_SEQUENCE');
  const lane = source['lane'];
  if (typeof lane !== 'string' || !CONSUMPTION_LANES.has(lane as ConsumptionOutputIdentity['lane'])) {
    throw new Error(`CONSUMPTION_LANE_INVALID:${String(lane)}`);
  }
  if ((lane === 'generic' || lane === 'account-frame' || lane === 'account-ack') && sequence < 1n) {
    throw new Error(`CONSUMPTION_SEQUENCE_INVALID:${sequence}`);
  }
  return Object.freeze({
    targetEntityId: bytes32(source['targetEntityId'], 'CONSUMPTION_TARGET_ENTITY'),
    sourceEntityId: bytes32(source['sourceEntityId'], 'CONSUMPTION_SOURCE_ENTITY'),
    lane: lane as ConsumptionOutputIdentity['lane'],
    sequence,
    semanticHash: bytes32(source['semanticHash'], 'CONSUMPTION_SEMANTIC_HASH'),
    outputHash: bytes32(source['outputHash'], 'CONSUMPTION_OUTPUT_HASH'),
    outputHanko: hanko(source['outputHanko'], 'CONSUMPTION_OUTPUT_HANKO'),
  });
};

export const getConsumptionKey = (
  identity: Pick<ConsumptionOutputIdentity, 'targetEntityId' | 'sourceEntityId' | 'lane'>,
): string => ethers.keccak256(ABI.encode(
  ['bytes32', 'bytes32', 'bytes32', 'bytes32'],
  [
    KEY_DOMAIN,
    domain(`xln.consumption-frontier.lane.${identity.lane}.v2`),
    bytes32(identity.sourceEntityId, 'CONSUMPTION_SOURCE_ENTITY'),
    bytes32(identity.targetEntityId, 'CONSUMPTION_TARGET_ENTITY'),
  ],
)).toLowerCase();

const frontierFromIdentity = (
  identity: ConsumptionOutputIdentity,
  count: bigint,
): ConsumptionFrontierValue => {
  const value = normalizeIdentity(identity);
  return Object.freeze({
    version: 1,
    lastContiguousSeq: value.sequence as bigint,
    lastSemanticHash: value.semanticHash,
    count,
    lastOutputHash: value.outputHash,
    lastOutputHanko: value.outputHanko,
  });
};

export const getConsumptionValue = (identity: ConsumptionOutputIdentity): ConsumptionFrontierValue =>
  frontierFromIdentity(identity, 1n);

const hashFrontier = (valueInput: ConsumptionFrontierValue): string => {
  const value = parseFrontier(valueInput);
  const quarantine = value.quarantine;
  return ethers.keccak256(ABI.encode(
    [
      'bytes32', 'uint8', 'uint64', 'bytes32', 'uint64', 'bytes32', 'bytes32',
      'bool', 'bytes32', 'bytes32', 'bytes32',
    ],
    [
      FRONTIER_DOMAIN,
      value.version,
      value.lastContiguousSeq,
      value.lastSemanticHash,
      value.count,
      value.lastOutputHash,
      ethers.keccak256(value.lastOutputHanko),
      Boolean(quarantine),
      quarantine?.conflictingSemanticHash ?? ethers.ZeroHash,
      quarantine?.conflictingOutputHash ?? ethers.ZeroHash,
      quarantine ? ethers.keccak256(quarantine.conflictingOutputHanko) : ethers.ZeroHash,
    ],
  )).toLowerCase();
};

const parseNode = (value: unknown): ConsumptionNode => {
  const source = record(value, 'CONSUMPTION_NODE');
  if (source['version'] !== 2) throw new Error(`CONSUMPTION_NODE_VERSION_INVALID:${String(source['version'])}`);
  if (source['type'] === 'leaf') {
    exactKeys(source, ['version', 'type', 'key', 'value'], 'CONSUMPTION_LEAF');
    return Object.freeze({
      version: 2,
      type: 'leaf',
      key: bytes32(source['key'], 'CONSUMPTION_LEAF_KEY'),
      value: parseFrontier(source['value']),
    });
  }
  if (source['type'] !== 'branch') throw new Error(`CONSUMPTION_NODE_TYPE_INVALID:${String(source['type'])}`);
  exactKeys(source, ['version', 'type', 'bit', 'left', 'right'], 'CONSUMPTION_BRANCH');
  const bit = source['bit'];
  if (typeof bit !== 'number' || !Number.isInteger(bit) || bit < 0 || bit > 255) {
    throw new Error(`CONSUMPTION_BRANCH_BIT_INVALID:${String(bit)}`);
  }
  const left = bytes32(source['left'], 'CONSUMPTION_BRANCH_LEFT');
  const right = bytes32(source['right'], 'CONSUMPTION_BRANCH_RIGHT');
  if (left === right) throw new Error(`CONSUMPTION_BRANCH_UNARY:${left}`);
  return Object.freeze({ version: 2, type: 'branch', bit, left, right });
};

const hashParsedNode = (node: ConsumptionNode): string => node.type === 'leaf'
  ? ethers.keccak256(ABI.encode(
      ['bytes32', 'uint8', 'bytes32', 'bytes32'],
      [LEAF_DOMAIN, 2, node.key, hashFrontier(node.value)],
    )).toLowerCase()
  : ethers.keccak256(ABI.encode(
      ['bytes32', 'uint8', 'uint16', 'bytes32', 'bytes32'],
      [BRANCH_DOMAIN, 2, node.bit, node.left, node.right],
    )).toLowerCase();

export const hashConsumptionNode = (node: ConsumptionNode): string => hashParsedNode(parseNode(node));

const frontierByteLength = (value: ConsumptionFrontierValue): number => {
  const quarantine = value.quarantine;
  return 1 + 8 + 32 + 8 + 32 + (value.lastOutputHanko.length - 2) / 2 +
    (quarantine ? 8 + 32 + 32 + (quarantine.conflictingOutputHanko.length - 2) / 2 : 0);
};

export const getConsumptionProofByteLength = (proof: ConsumptionProof): number =>
  3 + proof.nodes.reduce(
    (total, node) => total + (node.type === 'branch' ? 68 : 35 + frontierByteLength(node.value)),
    0,
  );

const parseProof = (proof: unknown): ConsumptionProof => {
  if (proof === undefined || proof === null) throw new Error('CONSUMPTION_PROOF_REQUIRED');
  const source = record(proof, 'CONSUMPTION_PROOF');
  exactKeys(source, ['version', 'nodes'], 'CONSUMPTION_PROOF');
  if (source['version'] !== 2) throw new Error(`CONSUMPTION_PROOF_VERSION_INVALID:${String(source['version'])}`);
  if (!Array.isArray(source['nodes'])) throw new Error('CONSUMPTION_PROOF_NODES_INVALID');
  if (source['nodes'].length > MAX_CONSUMPTION_PROOF_NODES) throw new Error('CONSUMPTION_PROOF_LENGTH_INVALID');
  const nodes = Object.freeze(source['nodes'].map(parseNode));
  const parsed = Object.freeze({ version: 2 as const, nodes });
  if (getConsumptionProofByteLength(parsed) > MAX_CONSUMPTION_PROOF_BYTES) {
    throw new Error('CONSUMPTION_PROOF_BYTES_INVALID');
  }
  return parsed;
};

/** Minimum persisted Patricia bytes for N relationships, excluding variable Hanko evidence. */
export const getConsumptionTreeByteLength = (count: bigint): bigint => {
  if (count < 0n || count > UINT64_MAX) throw new Error(`CONSUMPTION_COUNT_INVALID:${count.toString()}`);
  return count === 0n ? 0n : count * 148n + (count - 1n) * 68n;
};

const keyBit = (key: string, bit: number): 0 | 1 => {
  const offset = 2 + Math.floor(bit / 8) * 2;
  const byte = Number.parseInt(key.slice(offset, offset + 2), 16);
  return ((byte >> (7 - (bit % 8))) & 1) as 0 | 1;
};

const firstDifferentBit = (left: string, right: string): number => {
  for (let bit = 0; bit < 256; bit += 1) if (keyBit(left, bit) !== keyBit(right, bit)) return bit;
  return -1;
};

type ProofPath = Array<Readonly<{ hash: string; node: ConsumptionBranchNode; direction: 0 | 1 }>>;
type Inspection = Readonly<{
  result: ConsumptionProofResult;
  path: ProofPath;
  terminal?: ConsumptionLeafNode;
  terminalHash?: string;
}>;

const inspectProof = (root: string, key: string, proof: unknown): Inspection => {
  const normalizedRoot = bytes32(root, 'CONSUMPTION_ROOT');
  const normalizedKey = bytes32(key, 'CONSUMPTION_KEY');
  const parsed = parseProof(proof);
  if (normalizedRoot === EMPTY_CONSUMPTION_ROOT) {
    if (parsed.nodes.length !== 0) throw new Error('CONSUMPTION_PROOF_TRAILING_NODES');
    return { result: { status: 'absent' }, path: [] };
  }
  if (parsed.nodes.length < 1) throw new Error('CONSUMPTION_PROOF_LENGTH_INVALID');

  let expectedHash = normalizedRoot;
  let previousBit = -1;
  const path: ProofPath = [];
  for (let index = 0; index < parsed.nodes.length; index += 1) {
    const node = parsed.nodes[index]!;
    const actualHash = hashParsedNode(node);
    if (actualHash !== expectedHash) throw new Error(`CONSUMPTION_PROOF_LINK_INVALID:${index}`);
    if (node.type === 'leaf') {
      if (index !== parsed.nodes.length - 1) throw new Error('CONSUMPTION_PROOF_TRAILING_NODES');
      for (const entry of path) {
        if (keyBit(node.key, entry.node.bit) !== entry.direction) {
          throw new Error(`CONSUMPTION_PROOF_NON_CANONICAL_PATH:${entry.node.bit}`);
        }
      }
      const result: ConsumptionProofResult = node.key === normalizedKey
        ? { status: 'member', value: node.value }
        : { status: 'absent', terminalKey: node.key };
      return { result, path, terminal: node, terminalHash: actualHash };
    }
    if (node.bit <= previousBit) throw new Error(`CONSUMPTION_BRANCH_ORDER_INVALID:${previousBit}:${node.bit}`);
    previousBit = node.bit;
    const direction = keyBit(normalizedKey, node.bit);
    path.push({ hash: actualHash, node, direction });
    expectedHash = direction === 0 ? node.left : node.right;
  }
  throw new Error('CONSUMPTION_PROOF_TERMINAL_LEAF_MISSING');
};

export const verifyConsumptionProof = (root: string, key: string, proof: unknown): ConsumptionProofResult =>
  inspectProof(root, key, proof).result;

export const createEmptyConsumptionAccumulator = (): ConsumptionAccumulatorState =>
  Object.freeze({ version: 2, root: EMPTY_CONSUMPTION_ROOT, count: 0n });

const parseState = (state: ConsumptionAccumulatorState): ConsumptionAccumulatorState => {
  const source = record(state, 'CONSUMPTION_STATE');
  exactKeys(source, ['version', 'root', 'count'], 'CONSUMPTION_STATE');
  if (source['version'] !== 2) throw new Error(`CONSUMPTION_STATE_VERSION_INVALID:${String(source['version'])}`);
  if (typeof source['count'] !== 'bigint') throw new Error(`CONSUMPTION_COUNT_INVALID:${String(source['count'])}`);
  const count = boundedUint(source['count'], UINT64_MAX, 'CONSUMPTION_COUNT');
  if (count > MAX_CONSUMPTION_RELATIONSHIPS_PER_ENTITY) {
    throw new Error(
      `CONSUMPTION_RELATIONSHIP_LIMIT_EXCEEDED:${count}:${MAX_CONSUMPTION_RELATIONSHIPS_PER_ENTITY}`,
    );
  }
  const root = bytes32(source['root'], 'CONSUMPTION_ROOT');
  if ((root === EMPTY_CONSUMPTION_ROOT) !== (count === 0n)) throw new Error('CONSUMPTION_STATE_ROOT_COUNT_MISMATCH');
  return Object.freeze({ version: 2, root, count });
};

export const assertConsumptionAccumulatorState = (
  state: ConsumptionAccumulatorState,
): ConsumptionAccumulatorState => parseState(state);

const immutableEntries = (nodes: ReadonlyMap<string, ConsumptionNode>): readonly ConsumptionNodeEntry[] =>
  Object.freeze([...nodes].map(([hash, node]) => Object.freeze({ hash, node })));

const unchanged = (
  status: 'idempotent' | 'stale' | 'gap' | 'quarantined',
  state: ConsumptionAccumulatorState,
): ConsumptionApplyResult => Object.freeze({
  status,
  state,
  newNodes: Object.freeze([]),
  replacedNodeHashes: Object.freeze([]),
});

// Account nonces belong to their native bilateral/proof state machines, not to
// one source→target output stream. Account frame heights alternate between the
// two sides, so one source can legitimately emit 1 then 3 while the peer emits
// 2. Requiring +1 here invents a missing output and wedges the account; the
// nested Account verifier still enforces exact height + prevFrameHash before
// this accumulator transition can commit.
const isSparseNativeLane = (lane: ConsumptionOutputIdentity['lane']): boolean =>
  lane === 'account-frame' ||
  lane === 'account-ack' ||
  lane === 'account-dispute' ||
  lane === 'account-settlement';

const isValidInitialSequence = (identity: ConsumptionOutputIdentity, sequence: bigint): boolean => {
  if (identity.lane === 'generic') return sequence === 1n;
  // A restored/imported Account can already be above genesis. Its own state
  // machine validates the exact native frame/proof/settlement nonce; this
  // accumulator must not invent a second base counter.
  if (identity.lane === 'account-frame' || identity.lane === 'account-ack') return sequence >= 1n;
  return sequence >= 0n;
};

export const applyConsumptionOutput = (
  stateInput: ConsumptionAccumulatorState,
  identityInput: ConsumptionOutputIdentity,
  proof: unknown,
): ConsumptionApplyResult => {
  const state = parseState(stateInput);
  const identity = normalizeIdentity(identityInput);
  const key = getConsumptionKey(identity);
  const inspected = inspectProof(state.root, key, proof);
  if (inspected.result.status === 'absent' && state.count >= MAX_CONSUMPTION_RELATIONSHIPS_PER_ENTITY) {
    throw new Error(
      `CONSUMPTION_RELATIONSHIP_LIMIT_EXCEEDED:${state.count}:${MAX_CONSUMPTION_RELATIONSHIPS_PER_ENTITY}`,
    );
  }
  const sequence = identity.sequence as bigint;
  if (inspected.result.status === 'member') {
    const frontier = inspected.result.value;
    if (frontier.quarantine) return unchanged('quarantined', state);
    if (sequence < frontier.lastContiguousSeq) return unchanged('stale', state);
    if (sequence > frontier.lastContiguousSeq + 1n && !isSparseNativeLane(identity.lane)) {
      return unchanged('gap', state);
    }
    if (sequence === frontier.lastContiguousSeq && identity.semanticHash === frontier.lastSemanticHash) {
      return unchanged('idempotent', state);
    }
  } else if (!isValidInitialSequence(identity, sequence)) {
    return unchanged('gap', state);
  }

  const nodes = new Map<string, ConsumptionNode>();
  const put = (nodeInput: ConsumptionNode): string => {
    const node = parseNode(nodeInput);
    const hash = hashParsedNode(node);
    nodes.set(hash, node);
    return hash;
  };

  let status: ConsumptionApplyResult['status'];
  let nextValue: ConsumptionFrontierValue;
  if (inspected.result.status === 'member') {
    const frontier = inspected.result.value;
    if (sequence === frontier.lastContiguousSeq) {
      status = 'quarantined';
      nextValue = Object.freeze({
        ...frontier,
        quarantine: Object.freeze({
          sequence,
          conflictingSemanticHash: identity.semanticHash,
          conflictingOutputHash: identity.outputHash,
          conflictingOutputHanko: identity.outputHanko,
        }),
      });
    } else {
      status = 'advanced';
      nextValue = frontierFromIdentity(identity, frontier.count + 1n);
    }
  } else {
    status = 'inserted';
    nextValue = getConsumptionValue(identity);
  }

  const leaf: ConsumptionLeafNode = { version: 2, type: 'leaf', key, value: nextValue };
  let childHash = put(leaf);
  let replacedNodeHashes: readonly string[] = Object.freeze([]);
  if (inspected.result.status === 'member') {
    replacedNodeHashes = Object.freeze([
      ...inspected.path.map((entry) => entry.hash),
      inspected.terminalHash!,
    ]);
    for (let index = inspected.path.length - 1; index >= 0; index -= 1) {
      const entry = inspected.path[index]!;
      childHash = put({
        ...entry.node,
        left: entry.direction === 0 ? childHash : entry.node.left,
        right: entry.direction === 1 ? childHash : entry.node.right,
      });
    }
  } else if (inspected.terminal) {
    const differingBit = firstDifferentBit(key, inspected.terminal.key);
    if (differingBit < 0) throw new Error(`CONSUMPTION_KEY_COLLISION:${key}`);
    const insertionIndex = inspected.path.findIndex((entry) => entry.node.bit >= differingBit);
    const prefixLength = insertionIndex < 0 ? inspected.path.length : insertionIndex;
    replacedNodeHashes = Object.freeze(inspected.path.slice(0, prefixLength).map((entry) => entry.hash));
    const subtreeHash = prefixLength < inspected.path.length
      ? inspected.path[prefixLength]!.hash
      : inspected.terminalHash!;
    childHash = put({
      version: 2,
      type: 'branch',
      bit: differingBit,
      left: keyBit(key, differingBit) === 0 ? childHash : subtreeHash,
      right: keyBit(key, differingBit) === 1 ? childHash : subtreeHash,
    });
    for (let index = prefixLength - 1; index >= 0; index -= 1) {
      const entry = inspected.path[index]!;
      childHash = put({
        ...entry.node,
        left: entry.direction === 0 ? childHash : entry.node.left,
        right: entry.direction === 1 ? childHash : entry.node.right,
      });
    }
  }

  return Object.freeze({
    status,
    state: Object.freeze({
      version: 2,
      root: childHash,
      count: state.count + (status === 'inserted' ? 1n : 0n),
    }),
    newNodes: immutableEntries(nodes),
    replacedNodeHashes,
  });
};

/** CAS supplies witnesses only. Verification above trusts solely root + proof. */
export const createConsumptionProof = (
  store: ConsumptionNodeStore,
  root: string,
  key: string,
): ConsumptionProof => {
  let expectedHash = bytes32(root, 'CONSUMPTION_ROOT');
  const normalizedKey = bytes32(key, 'CONSUMPTION_KEY');
  if (expectedHash === EMPTY_CONSUMPTION_ROOT) return Object.freeze({ version: 2, nodes: Object.freeze([]) });
  const nodes: ConsumptionNode[] = [];
  const seen = new Set<string>();
  let previousBit = -1;
  while (true) {
    if (seen.has(expectedHash)) throw new Error(`CONSUMPTION_NODE_CYCLE:${expectedHash}`);
    if (nodes.length >= MAX_CONSUMPTION_PROOF_NODES) throw new Error('CONSUMPTION_PROOF_LENGTH_INVALID');
    seen.add(expectedHash);
    const raw = store.get(expectedHash);
    if (!raw) throw new Error(`CONSUMPTION_NODE_MISSING:${expectedHash}`);
    const node = parseNode(raw);
    const actualHash = hashParsedNode(node);
    if (actualHash !== expectedHash) throw new Error(`CONSUMPTION_NODE_CORRUPT:${expectedHash}:${actualHash}`);
    nodes.push(node);
    if (node.type === 'leaf') {
      const proof = Object.freeze({ version: 2 as const, nodes: Object.freeze(nodes) });
      if (getConsumptionProofByteLength(proof) > MAX_CONSUMPTION_PROOF_BYTES) {
        throw new Error('CONSUMPTION_PROOF_BYTES_INVALID');
      }
      return proof;
    }
    if (node.bit <= previousBit) throw new Error(`CONSUMPTION_BRANCH_ORDER_INVALID:${previousBit}:${node.bit}`);
    previousBit = node.bit;
    expectedHash = keyBit(normalizedKey, node.bit) === 0 ? node.left : node.right;
  }
};

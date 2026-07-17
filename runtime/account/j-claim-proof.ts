import type {
  AccountJClaimLeafNode,
  AccountJClaimNode,
  AccountJClaimNodeStore,
  AccountJClaimProof,
  AccountJClaimProofResult,
  AccountJClaimRecord,
} from '../types/account-j-claims';
import {
  EMPTY_ACCOUNT_J_CLAIM_ROOT,
  accountJClaimKeyBit,
  getAccountJClaimKey,
  hashAccountJClaimNode,
  normalizeAccountJBytes32,
  parseAccountJClaimNode,
  type AccountJClaimProofPath,
} from './j-claim-codec';

export const MAX_ACCOUNT_J_CLAIM_PROOF_NODES = 257;
export const MAX_ACCOUNT_J_CLAIM_PROOF_BYTES = 3 + 256 * 68 + 140;

const proofObject = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ACCOUNT_J_CLAIM_PROOF_INVALID');
  return value as Record<string, unknown>;
};

const parseProof = (value: unknown): AccountJClaimProof => {
  if (value === undefined || value === null) throw new Error('ACCOUNT_J_CLAIM_PROOF_REQUIRED');
  const source = proofObject(value);
  const keys = Object.keys(source).sort();
  if (keys.length !== 2 || keys[0] !== 'nodes' || keys[1] !== 'version') {
    throw new Error(`ACCOUNT_J_CLAIM_PROOF_FIELDS_INVALID:${keys.join(',')}`);
  }
  if (source['version'] !== 1) throw new Error(`ACCOUNT_J_CLAIM_PROOF_VERSION_INVALID:${String(source['version'])}`);
  if (!Array.isArray(source['nodes'])) throw new Error('ACCOUNT_J_CLAIM_PROOF_NODES_INVALID');
  if (source['nodes'].length > MAX_ACCOUNT_J_CLAIM_PROOF_NODES) throw new Error('ACCOUNT_J_CLAIM_PROOF_LENGTH_INVALID');
  const nodes = Object.freeze(source['nodes'].map(parseAccountJClaimNode));
  const proof = Object.freeze({ version: 1 as const, nodes });
  if (getAccountJClaimProofByteLength(proof) > MAX_ACCOUNT_J_CLAIM_PROOF_BYTES) {
    throw new Error('ACCOUNT_J_CLAIM_PROOF_BYTES_INVALID');
  }
  return proof;
};

export const getAccountJClaimProofByteLength = (proof: AccountJClaimProof): number =>
  3 + proof.nodes.reduce((total, node) => total + (node.type === 'branch' ? 68 : 140), 0);

export type AccountJClaimInspection = Readonly<{
  result: AccountJClaimProofResult;
  path: AccountJClaimProofPath;
  terminal?: AccountJClaimLeafNode;
  terminalHash?: string;
}>;

export const inspectAccountJClaimProof = (
  root: string,
  record: AccountJClaimRecord,
  proofValue: unknown,
): AccountJClaimInspection => {
  const normalizedRoot = normalizeAccountJBytes32(root, 'ROOT');
  const key = getAccountJClaimKey(record);
  const proof = parseProof(proofValue);
  if (normalizedRoot === EMPTY_ACCOUNT_J_CLAIM_ROOT) {
    if (proof.nodes.length !== 0) throw new Error('ACCOUNT_J_CLAIM_PROOF_TRAILING_NODES');
    return { result: { status: 'absent' }, path: [] };
  }
  if (proof.nodes.length < 1) throw new Error('ACCOUNT_J_CLAIM_PROOF_LENGTH_INVALID');

  let expectedHash = normalizedRoot;
  let previousBit = -1;
  const path: AccountJClaimProofPath = [];
  for (let index = 0; index < proof.nodes.length; index += 1) {
    const node = proof.nodes[index]!;
    const actualHash = hashAccountJClaimNode(node);
    if (actualHash !== expectedHash) throw new Error(`ACCOUNT_J_CLAIM_PROOF_LINK_INVALID:${index}`);
    if (node.type === 'leaf') {
      if (index !== proof.nodes.length - 1) throw new Error('ACCOUNT_J_CLAIM_PROOF_TRAILING_NODES');
      for (const entry of path) {
        if (accountJClaimKeyBit(node.key, entry.node.bit) !== entry.direction) {
          throw new Error(`ACCOUNT_J_CLAIM_PROOF_NON_CANONICAL_PATH:${entry.node.bit}`);
        }
      }
      const result: AccountJClaimProofResult = node.key === key
        ? { status: 'member', record: node.record }
        : { status: 'absent', terminalKey: node.key };
      return { result, path, terminal: node, terminalHash: actualHash };
    }
    if (node.bit <= previousBit) throw new Error(`ACCOUNT_J_CLAIM_BRANCH_ORDER_INVALID:${previousBit}:${node.bit}`);
    previousBit = node.bit;
    const direction = accountJClaimKeyBit(key, node.bit);
    path.push({ hash: actualHash, node, direction });
    expectedHash = direction === 0 ? node.left : node.right;
  }
  throw new Error('ACCOUNT_J_CLAIM_PROOF_TERMINAL_LEAF_MISSING');
};

export const verifyAccountJClaimProof = (
  root: string,
  record: AccountJClaimRecord,
  proof: unknown,
): AccountJClaimProofResult => inspectAccountJClaimProof(root, record, proof).result;

export const createAccountJClaimProof = (
  store: AccountJClaimNodeStore,
  root: string,
  record: AccountJClaimRecord,
): AccountJClaimProof => {
  let hash = normalizeAccountJBytes32(root, 'ROOT');
  const key = getAccountJClaimKey(record);
  if (hash === EMPTY_ACCOUNT_J_CLAIM_ROOT) return Object.freeze({ version: 1, nodes: Object.freeze([]) });
  const nodes: AccountJClaimNode[] = [];
  const seen = new Set<string>();
  let previousBit = -1;
  while (true) {
    if (seen.has(hash)) throw new Error(`ACCOUNT_J_CLAIM_NODE_CYCLE:${hash}`);
    if (nodes.length >= MAX_ACCOUNT_J_CLAIM_PROOF_NODES) throw new Error('ACCOUNT_J_CLAIM_PROOF_LENGTH_INVALID');
    seen.add(hash);
    const raw = store.get(hash);
    if (!raw) throw new Error(`ACCOUNT_J_CLAIM_NODE_MISSING:${hash}`);
    const node = parseAccountJClaimNode(raw);
    const actual = hashAccountJClaimNode(node);
    if (actual !== hash) throw new Error(`ACCOUNT_J_CLAIM_NODE_CORRUPT:${hash}:${actual}`);
    nodes.push(node);
    if (node.type === 'leaf') return Object.freeze({ version: 1, nodes: Object.freeze(nodes) });
    if (node.bit <= previousBit) throw new Error(`ACCOUNT_J_CLAIM_BRANCH_ORDER_INVALID:${previousBit}:${node.bit}`);
    previousBit = node.bit;
    hash = accountJClaimKeyBit(key, node.bit) === 0 ? node.left : node.right;
  }
};

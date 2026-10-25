import { ethers } from 'ethers';

// Verifies eth_getProof responses against an already authenticated header
// stateRoot. Every returned value is read from the hash-bound trie path, never
// from the RPC's own summary fields; those must merely agree.

type RlpNode = string | RlpNode[];

export const EMPTY_TRIE_ROOT = '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421';

export type VerifiedAccountState = {
  nonce: bigint;
  balance: bigint;
  storageRoot: string;
  codeHash: string;
};

export type GetProofResponse = {
  address?: unknown;
  nonce?: unknown;
  balance?: unknown;
  storageHash?: unknown;
  codeHash?: unknown;
  accountProof?: unknown;
  storageProof?: unknown;
};

export type VerifiedStateProof = {
  account: VerifiedAccountState | null;
  storage: Map<bigint, bigint>;
};

const fail = (code: string): never => {
  throw new Error(`STATE_PROOF_${code}`);
};

const normalizeHash = (value: unknown, code: string): string => {
  const hash = String(value ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hash)) fail(code);
  return hash;
};

const toNibbles = (bytes: Uint8Array): number[] => {
  const nibbles: number[] = [];
  for (const byte of bytes) nibbles.push(byte >> 4, byte & 0x0f);
  return nibbles;
};

const decodeHexPrefix = (encoded: RlpNode): { nibbles: number[]; leaf: boolean } => {
  if (typeof encoded !== 'string') return fail('PATH_NOT_BYTES');
  const bytes = ethers.getBytes(encoded);
  const first = bytes[0];
  if (first === undefined) return fail('PATH_EMPTY');
  const flag = first >> 4;
  if (flag > 3) fail('PATH_FLAG');
  const odd = (flag & 1) === 1;
  if (!odd && (first & 0x0f) !== 0) fail('PATH_PADDING');
  const nibbles = odd ? [first & 0x0f] : [];
  nibbles.push(...toNibbles(bytes.subarray(1)));
  return { nibbles, leaf: flag >= 2 };
};

const decodeCanonicalUint = (value: RlpNode | undefined, code: string): bigint => {
  if (typeof value !== 'string') return fail(code);
  const bytes = ethers.getBytes(value);
  if (bytes.length > 32 || (bytes.length > 0 && bytes[0] === 0)) fail(code);
  return bytes.length === 0 ? 0n : BigInt(value);
};

/**
 * Walks a secure-trie proof for keccak256(key) from root. Returns the stored
 * value bytes, or null only when the proof itself demonstrates absence.
 * Unused trailing nodes, wrong hashes and malformed nodes are rejected.
 */
const verifyTrieProof = (
  root: string,
  key: Uint8Array,
  proof: readonly string[],
): Uint8Array | null => {
  const path = toNibbles(ethers.getBytes(ethers.keccak256(key)));
  let wantHash: string | null = normalizeHash(root, 'ROOT_INVALID');
  let inline: RlpNode | null = null;
  let index = 0;
  let pos = 0;
  const absent = (): null => {
    if (index !== proof.length) fail('TRAILING_NODES');
    return null;
  };
  if (wantHash === EMPTY_TRIE_ROOT && proof.length === 0) return null;

  for (;;) {
    let node: RlpNode;
    if (inline !== null) {
      node = inline;
      inline = null;
    } else {
      const encoded = proof[index++];
      if (encoded === undefined) return fail('MISSING_NODE');
      if (ethers.keccak256(encoded).toLowerCase() !== wantHash) fail('NODE_HASH_MISMATCH');
      node = ethers.decodeRlp(encoded) as RlpNode;
      // An empty trie may be proven by its single RLP-empty root node.
      if (node === '0x' && index === 1) return absent();
    }
    if (!Array.isArray(node)) return fail('NODE_NOT_LIST');

    let next: RlpNode;
    if (node.length === 17) {
      // Secure-trie keys are fixed 32 bytes, so a branch never terminates a path.
      const nibble = path[pos++];
      if (nibble === undefined) return fail('BRANCH_AT_PATH_END');
      next = node[nibble] ?? fail('NODE_ARITY');
      if (next === '0x') return absent();
    } else if (node.length === 2) {
      const encodedPath: RlpNode | undefined = node[0];
      const value: RlpNode | undefined = node[1];
      const { nibbles, leaf } = decodeHexPrefix(encodedPath ?? fail('NODE_ARITY'));
      const matches =
        pos + nibbles.length <= path.length && nibbles.every((nibble, offset) => path[pos + offset] === nibble);
      if (!matches) return absent();
      pos += nibbles.length;
      if (leaf) {
        if (pos !== path.length) fail('LEAF_BEFORE_PATH_END');
        if (typeof value !== 'string') return fail('LEAF_VALUE_NOT_BYTES');
        if (index !== proof.length) fail('TRAILING_NODES');
        return ethers.getBytes(value);
      }
      next = value ?? fail('NODE_ARITY');
    } else {
      return fail('NODE_ARITY');
    }

    if (typeof next === 'string') {
      wantHash = normalizeHash(next, 'CHILD_REFERENCE');
    } else {
      // Children whose RLP is shorter than 32 bytes are embedded, not hashed.
      if (ethers.getBytes(ethers.encodeRlp(next)).length >= 32) fail('EMBEDDED_CHILD_TOO_LARGE');
      inline = next;
    }
  }
};

export const verifyAccountProof = (
  stateRoot: string,
  address: string,
  accountProof: readonly string[],
): VerifiedAccountState | null => {
  const value = verifyTrieProof(stateRoot, ethers.getBytes(ethers.getAddress(address)), accountProof);
  if (value === null) return null;
  const fields = ethers.decodeRlp(value) as RlpNode;
  if (!Array.isArray(fields) || fields.length !== 4) return fail('ACCOUNT_SHAPE');
  return {
    nonce: decodeCanonicalUint(fields[0], 'ACCOUNT_NONCE'),
    balance: decodeCanonicalUint(fields[1], 'ACCOUNT_BALANCE'),
    storageRoot: normalizeHash(fields[2], 'ACCOUNT_STORAGE_ROOT'),
    codeHash: normalizeHash(fields[3], 'ACCOUNT_CODE_HASH'),
  };
};

export const verifyStorageProof = (storageRoot: string, slot: bigint, proof: readonly string[]): bigint => {
  if (slot < 0n || slot >= 1n << 256n) fail('SLOT_RANGE');
  const key = ethers.getBytes(ethers.zeroPadValue(ethers.toBeHex(slot), 32));
  const value = verifyTrieProof(storageRoot, key, proof);
  if (value === null) return 0n;
  // Ethereum clients delete zeroed slots, but Anvil keeps a slot explicitly
  // written to zero as an RLP-empty leaf under its real stateRoot. The leaf is
  // still hash-bound to the root, so it proves the value 0, not absence of proof.
  return decodeCanonicalUint(ethers.decodeRlp(value) as RlpNode, 'STORAGE_VALUE');
};

const proofList = (value: unknown, code: string): string[] => {
  if (!Array.isArray(value) || value.some(node => typeof node !== 'string' || !ethers.isHexString(node))) {
    return fail(code);
  }
  return value as string[];
};

const quantity = (value: unknown, code: string): bigint => {
  try {
    return BigInt(String(value ?? ''));
  } catch {
    return fail(code);
  }
};

/**
 * Binds one eth_getProof response to stateRoot. The response must cover exactly
 * the requested slots in order, and its summary fields must equal the proven
 * account; disagreement means the endpoint is inconsistent and is rejected.
 */
export const verifyGetProofResponse = (
  stateRoot: string,
  address: string,
  slots: readonly bigint[],
  response: GetProofResponse,
): VerifiedStateProof => {
  if (ethers.getAddress(String(response.address ?? '')) !== ethers.getAddress(address)) fail('ADDRESS_MISMATCH');
  const account = verifyAccountProof(stateRoot, address, proofList(response.accountProof, 'ACCOUNT_PROOF_SHAPE'));
  const proven = account ?? { nonce: 0n, balance: 0n, storageRoot: EMPTY_TRIE_ROOT, codeHash: ethers.keccak256('0x') };
  if (quantity(response.nonce, 'NONCE_SHAPE') !== proven.nonce) fail('NONCE_MISMATCH');
  if (quantity(response.balance, 'BALANCE_SHAPE') !== proven.balance) fail('BALANCE_MISMATCH');
  if (normalizeHash(response.storageHash, 'STORAGE_HASH_SHAPE') !== proven.storageRoot) fail('STORAGE_HASH_MISMATCH');
  if (normalizeHash(response.codeHash, 'CODE_HASH_SHAPE') !== proven.codeHash.toLowerCase()) fail('CODE_HASH_MISMATCH');

  const entries = response.storageProof;
  if (!Array.isArray(entries) || entries.length !== slots.length) return fail('STORAGE_PROOF_COUNT');
  const storage = new Map<bigint, bigint>();
  slots.forEach((slot, position) => {
    const entry = entries[position] as { key?: unknown; value?: unknown; proof?: unknown } | undefined;
    if (!entry || quantity(entry.key, 'STORAGE_KEY_SHAPE') !== slot) return fail('STORAGE_KEY_MISMATCH');
    const value = verifyStorageProof(proven.storageRoot, slot, proofList(entry.proof, 'STORAGE_PROOF_SHAPE'));
    if (quantity(entry.value, 'STORAGE_VALUE_SHAPE') !== value) fail('STORAGE_VALUE_MISMATCH');
    storage.set(slot, value);
  });
  return { account, storage };
};

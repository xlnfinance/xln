import { performance } from 'node:perf_hooks';
import { keccak_256 } from '@noble/hashes/sha3.js';
import secp256k1 from 'secp256k1';
import type {
  PaymentWorkRequest,
  PaymentWorkResult,
  PrimitiveRate,
} from './types';

const ACCOUNT_MUTATIONS_PER_PAYMENT = 4;
const ACCOUNT_TREE_LEAVES = 1_024;
const ACCOUNT_TREE_DEPTH = 10;
const ACCOUNT_PREIMAGE_BYTES = 320;
const PRIVATE_KEY = Uint8Array.from({ length: 32 }, (_, index) => index === 31 ? 1 : 0);
const ZERO_HASH = new Uint8Array(32);

const writeU32 = (target: Uint8Array, offset: number, value: number): void => {
  new DataView(target.buffer, target.byteOffset, target.byteLength).setUint32(offset, value, false);
};

const initializeTree = (): Uint8Array[] =>
  Array.from({ length: ACCOUNT_TREE_LEAVES * 2 }, () => ZERO_HASH);

const updateMerklePath = (
  tree: Uint8Array[],
  leafIndex: number,
  leafHash: Uint8Array,
  pair: Uint8Array,
): Uint8Array => {
  let node = ACCOUNT_TREE_LEAVES + leafIndex;
  tree[node] = leafHash;
  while (node > 1) {
    const left = node % 2 === 0 ? tree[node]! : tree[node - 1]!;
    const right = node % 2 === 0 ? tree[node + 1]! : tree[node]!;
    pair.set(left, 0);
    pair.set(right, 32);
    node = Math.floor(node / 2);
    tree[node] = keccak_256(pair);
  }
  return tree[1]!;
};

const runPayment = (
  paymentId: number,
  request: PaymentWorkRequest,
  tree: Uint8Array[],
  preimage: Uint8Array,
  pair: Uint8Array,
): Uint8Array => {
  let root = tree[1]!;
  for (let mutation = 0; mutation < ACCOUNT_MUTATIONS_PER_PAYMENT; mutation += 1) {
    preimage.fill(0);
    writeU32(preimage, 0, paymentId);
    writeU32(preimage, 4, mutation);
    preimage.set(root, 8);
    const leafHash = keccak_256(preimage);
    const leafIndex = (paymentId * ACCOUNT_MUTATIONS_PER_PAYMENT + mutation) % ACCOUNT_TREE_LEAVES;
    root = updateMerklePath(tree, leafIndex, leafHash, pair);
  }
  for (let hashIndex = 0; hashIndex < request.profile.extraHashesPerPayment; hashIndex += 1) {
    pair.set(root, 0);
    writeU32(pair, 32, paymentId);
    writeU32(pair, 36, hashIndex);
    root = keccak_256(pair);
  }
  let signature = secp256k1.ecdsaSign(root, PRIVATE_KEY);
  for (let index = 1; index < request.profile.signaturesPerPayment; index += 1) {
    pair.set(root, 0);
    writeU32(pair, 32, index);
    root = keccak_256(pair);
    signature = secp256k1.ecdsaSign(root, PRIVATE_KEY);
  }
  for (let index = 0; index < request.profile.recoversPerPayment; index += 1) {
    const publicKey = secp256k1.ecdsaRecover(signature.signature, signature.recid, root, false);
    root[0] = root[0]! ^ publicKey[index % publicKey.length]!;
  }
  return root;
};

export const runPaymentWork = (request: PaymentWorkRequest): PaymentWorkResult => {
  const tree = initializeTree();
  const preimage = new Uint8Array(ACCOUNT_PREIMAGE_BYTES);
  const pair = new Uint8Array(64);
  const output = new Uint8Array(request.payments * 32);
  const startedAt = performance.now();
  for (let offset = 0; offset < request.payments; offset += 1) {
    const paymentId = request.startPayment + offset;
    output.set(runPayment(paymentId, request, tree, preimage, pair), offset * 32);
  }
  return {
    startPayment: request.startPayment,
    payments: request.payments,
    elapsedMs: performance.now() - startedAt,
    signatures: request.payments * request.profile.signaturesPerPayment,
    recovers: request.payments * request.profile.recoversPerPayment,
    keccaks: request.payments * (
      ACCOUNT_MUTATIONS_PER_PAYMENT * (ACCOUNT_TREE_DEPTH + 1)
      + request.profile.extraHashesPerPayment
      + Math.max(0, request.profile.signaturesPerPayment - 1)
    ),
    binaryPreimageBytes: request.payments * ACCOUNT_MUTATIONS_PER_PAYMENT * ACCOUNT_PREIMAGE_BYTES,
    output,
  };
};

const measureRate = (
  primitive: PrimitiveRate['primitive'],
  operations: number,
  operation: (index: number) => void,
): PrimitiveRate => {
  const startedAt = performance.now();
  for (let index = 0; index < operations; index += 1) operation(index);
  const wallMs = performance.now() - startedAt;
  return {
    primitive,
    operations,
    wallMs,
    operationsPerSecond: operations * 1_000 / wallMs,
    microsecondsPerOperation: wallMs * 1_000 / operations,
  };
};

export const measurePrimitiveRates = (): PrimitiveRate[] => {
  const bytes = new Uint8Array(64);
  const digest = keccak_256(bytes);
  const signed = secp256k1.ecdsaSign(digest, PRIVATE_KEY);
  return [
    measureRate('keccak256-64b', 100_000, index => {
      writeU32(bytes, 0, index);
      keccak_256(bytes);
    }),
    measureRate('secp256k1-sign', 20_000, index => {
      writeU32(digest, 0, index);
      secp256k1.ecdsaSign(digest, PRIVATE_KEY);
    }),
    measureRate('secp256k1-recover', 20_000, index => {
      void index;
      secp256k1.ecdsaRecover(signed.signature, signed.recid, digest, false);
    }),
  ];
};

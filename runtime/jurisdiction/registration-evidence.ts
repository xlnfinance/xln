import { ethers } from 'ethers';

import { signAccountFrame, verifyAccountSignature } from '../account/crypto';
import { EntityProvider__factory } from '../../jurisdictions/typechain-types';
import {
  verifyCanonicalReceiptProof,
  type AuthenticatedRpcLog,
} from '../jadapter/receipt-codec';
import { encodeCanonicalEntityConsensusValue } from '../entity/consensus/state-root';
import type { CertifiedRegistrationEvidence, Env, JReplica, RuntimeTx } from '../types';
import { getCertifiedBoardStackKey } from './board-registry';

const FOUNDATION_ENTITY_ID = ethers.toBeHex(1n, 32).toLowerCase();
const ZERO_BYTES32 = `0x${'00'.repeat(32)}`;
const LOCAL_J_AUTHORITY_RUNTIME_TX = Symbol('xln.runtime.j-authority.local');
const entityProviderInterface = EntityProvider__factory.createInterface();
const MAX_RECEIPT_BYTES = 1_048_576;
const MAX_RECEIPT_DATA_BYTES = 65_536;
const MAX_PROOF_NODES = 128;
const MAX_PROOF_NODE_BYTES = 1_048_576;
const MAX_TOTAL_PROOF_BYTES = 2_097_152;

const bytes32 = (value: unknown, label: string): string => {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`J_AUTHORITY_${label}_INVALID:${normalized || 'missing'}`);
  }
  return normalized;
};

const address = (value: unknown, label: string): string => {
  try {
    return ethers.getAddress(String(value ?? '')).toLowerCase();
  } catch {
    throw new Error(`J_AUTHORITY_${label}_INVALID:${String(value ?? '')}`);
  }
};

const safeInt = (value: unknown, label: string): number => {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error(`J_AUTHORITY_${label}_INVALID:${String(value)}`);
  }
  return result;
};

const canonicalHex = (value: unknown, label: string, maxBytes: number): string => {
  const candidate = String(value ?? '');
  if (!/^0x(?:[0-9a-f]{2})*$/.test(candidate)) {
    throw new Error(`J_AUTHORITY_${label}_INVALID`);
  }
  const byteLength = (candidate.length - 2) / 2;
  if (byteLength > maxBytes) {
    throw new Error(`J_AUTHORITY_${label}_OVERSIZED:${byteLength}:${maxBytes}`);
  }
  return candidate;
};

const evidenceBody = (evidence: CertifiedRegistrationEvidence): Omit<
  CertifiedRegistrationEvidence,
  'witnessSignature'
> => {
  const { witnessSignature: _witnessSignature, ...body } = evidence;
  return body;
};

export const registrationEvidenceKey = (stackKey: string, entityId: string): string =>
  `${bytes32(stackKey, 'STACK_KEY')}:${bytes32(entityId, 'ENTITY_ID')}`;

export const buildRegistrationEvidenceRawLogDigest = (value: Pick<
  CertifiedRegistrationEvidence,
  'emitter' | 'topics' | 'data' | 'activationHeight' | 'blockHash' |
  'transactionHash' | 'transactionIndex' | 'logIndex'
>): string => ethers.keccak256(ethers.toUtf8Bytes(encodeCanonicalEntityConsensusValue({
  domain: 'xln.j-authority.raw-log.v1',
  emitter: address(value.emitter, 'EMITTER'),
  topics: value.topics.map((topic, index) => bytes32(topic, `TOPIC_${index}`)),
  data: ethers.hexlify(ethers.getBytes(value.data)).toLowerCase(),
  activationHeight: safeInt(value.activationHeight, 'ACTIVATION_HEIGHT'),
  blockHash: bytes32(value.blockHash, 'BLOCK_HASH'),
  transactionHash: bytes32(value.transactionHash, 'TRANSACTION_HASH'),
  transactionIndex: safeInt(value.transactionIndex, 'TRANSACTION_INDEX'),
  logIndex: safeInt(value.logIndex, 'LOG_INDEX'),
})));

export const buildRegistrationEvidenceDigest = (evidence: CertifiedRegistrationEvidence): string =>
  ethers.keccak256(ethers.toUtf8Bytes(encodeCanonicalEntityConsensusValue({
    domain: 'xln.j-authority.witness.v1',
    evidence: evidenceBody(evidence),
  })));

export const computeRegistrationEvidenceHash = (evidence: CertifiedRegistrationEvidence): string =>
  ethers.keccak256(ethers.toUtf8Bytes(encodeCanonicalEntityConsensusValue({
    domain: 'xln.j-authority.evidence.v1',
    evidence,
  })));

export const computeRegistrationEvidenceClaimHash = (
  evidence: CertifiedRegistrationEvidence,
): string => ethers.keccak256(ethers.toUtf8Bytes(encodeCanonicalEntityConsensusValue({
  domain: 'xln.j-authority.receipt-claim.v1',
  version: evidence.version,
  source: evidence.source,
  stackKey: evidence.stackKey,
  entityId: evidence.entityId,
  boardHash: evidence.boardHash,
  activationHeight: evidence.activationHeight,
  blockHash: evidence.blockHash,
  transactionHash: evidence.transactionHash,
  transactionIndex: evidence.transactionIndex,
  logIndex: evidence.logIndex,
  emitter: evidence.emitter,
  topics: evidence.topics,
  data: evidence.data,
  rawLogDigest: evidence.rawLogDigest,
  receiptsRoot: evidence.receiptsRoot,
  encodedReceipt: evidence.encodedReceipt,
  receiptProofNodes: evidence.receiptProofNodes,
  receiptLogIndex: evidence.receiptLogIndex,
})));

const jReplicaStackKey = (replica: JReplica): string | null => {
  const chainId = replica.chainId ?? replica.jadapter?.chainId;
  const depositoryAddress = replica.depositoryAddress ?? replica.contracts?.depository;
  const entityProviderAddress = replica.entityProviderAddress ?? replica.contracts?.entityProvider;
  if (!chainId || !depositoryAddress || !entityProviderAddress) return null;
  return getCertifiedBoardStackKey({ chainId, depositoryAddress, entityProviderAddress });
};

export const buildCertifiedRegistrationEvidence = (
  env: Env,
  replica: JReplica,
  source: CertifiedRegistrationEvidence['source'],
  log: AuthenticatedRpcLog,
  finality: {
    observedThroughHeight: number;
    observedTipBlockHash: string;
    observedHeadHeight: number;
    confirmationDepth: number;
  },
): CertifiedRegistrationEvidence => {
  const stackKey = jReplicaStackKey(replica);
  if (!stackKey) throw new Error('J_AUTHORITY_LOCAL_STACK_INCOMPLETE');
  if (!log.receiptProof) {
    throw new Error(`J_AUTHORITY_RECEIPT_MPT_PROOF_MISSING:${source}:${log.blockNumber}:${log.index}`);
  }
  if (!env.runtimeId) throw new Error('J_AUTHORITY_WITNESS_RUNTIME_MISSING');
  const parsed = entityProviderInterface.parseLog({ topics: log.topics, data: log.data });
  if (!parsed || parsed.name !== source) {
    throw new Error(`J_AUTHORITY_EVENT_TYPE_MISMATCH:${source}:${parsed?.name ?? 'unknown'}`);
  }
  const entityId = source === 'EntityRegistered'
    ? bytes32(parsed.args[0], 'EVENT_ENTITY_ID')
    : FOUNDATION_ENTITY_ID;
  const boardHash = source === 'EntityRegistered'
    ? bytes32(parsed.args[2], 'EVENT_BOARD_HASH')
    : bytes32(parsed.args[1], 'EVENT_BOARD_HASH');
  const unsigned: CertifiedRegistrationEvidence = {
    version: 1,
    source,
    stackKey,
    entityId,
    boardHash,
    activationHeight: log.blockNumber,
    blockHash: log.blockHash.toLowerCase(),
    transactionHash: log.transactionHash.toLowerCase(),
    transactionIndex: log.receiptProof.transactionIndex,
    logIndex: log.index,
    emitter: log.address.toLowerCase(),
    topics: log.topics.map(topic => topic.toLowerCase()),
    data: log.data.toLowerCase(),
    rawLogDigest: ZERO_BYTES32,
    receiptsRoot: log.receiptProof.receiptsRoot.toLowerCase(),
    encodedReceipt: log.receiptProof.encodedReceipt.toLowerCase(),
    receiptProofNodes: log.receiptProof.proofNodes.map(node => node.toLowerCase()),
    receiptLogIndex: log.receiptProof.receiptLogIndex,
    observedThroughHeight: finality.observedThroughHeight,
    observedTipBlockHash: finality.observedTipBlockHash.toLowerCase(),
    observedHeadHeight: finality.observedHeadHeight,
    confirmationDepth: finality.confirmationDepth,
    witnessRuntimeId: address(env.runtimeId, 'WITNESS'),
    witnessSignature: '0x',
  };
  unsigned.rawLogDigest = buildRegistrationEvidenceRawLogDigest(unsigned);
  unsigned.witnessSignature = signAccountFrame(
    env,
    unsigned.witnessRuntimeId,
    buildRegistrationEvidenceDigest(unsigned),
  ).toLowerCase();
  assertRegistrationEvidenceEnvelope(env, unsigned);
  return unsigned;
};

const assertExactLocalStack = (env: Env, evidence: CertifiedRegistrationEvidence): JReplica => {
  const matches = Array.from(env.jReplicas.values()).filter(replica => (
    jReplicaStackKey(replica) === evidence.stackKey
  ));
  if (matches.length !== 1) {
    throw new Error(`J_AUTHORITY_STACK_LOCAL_MATCH_INVALID:${evidence.stackKey}:${matches.length}`);
  }
  const replica = matches[0]!;
  const entityProvider = replica.entityProviderAddress ?? replica.contracts?.entityProvider;
  if (address(entityProvider, 'LOCAL_ENTITY_PROVIDER') !== evidence.emitter) {
    throw new Error(`J_AUTHORITY_EMITTER_STACK_MISMATCH:${evidence.emitter}:${String(entityProvider)}`);
  }
  return replica;
};

const assertDecodedRegistrationLog = (evidence: CertifiedRegistrationEvidence): void => {
  const parsed = entityProviderInterface.parseLog({ topics: evidence.topics, data: evidence.data });
  if (!parsed || parsed.name !== evidence.source) {
    throw new Error(`J_AUTHORITY_EVENT_TYPE_MISMATCH:${evidence.source}:${parsed?.name ?? 'unknown'}`);
  }
  const entityId = evidence.source === 'EntityRegistered'
    ? bytes32(parsed.args[0], 'EVENT_ENTITY_ID')
    : FOUNDATION_ENTITY_ID;
  const boardHash = evidence.source === 'EntityRegistered'
    ? bytes32(parsed.args[2], 'EVENT_BOARD_HASH')
    : bytes32(parsed.args[1], 'EVENT_BOARD_HASH');
  if (evidence.source === 'EntityRegistered') {
    const entityNumber = BigInt(parsed.args[1]);
    if (entityNumber <= 0n || entityNumber !== BigInt(entityId)) {
      throw new Error(`J_AUTHORITY_ENTITY_NUMBER_MISMATCH:${entityId}:${entityNumber}`);
    }
  }
  if (entityId !== evidence.entityId || boardHash !== evidence.boardHash) {
    throw new Error(
      `J_AUTHORITY_EVENT_BODY_MISMATCH:entity=${entityId}:${evidence.entityId}:` +
      `board=${boardHash}:${evidence.boardHash}`,
    );
  }
};

export const assertRegistrationEvidenceEnvelope = (
  env: Env,
  evidence: CertifiedRegistrationEvidence,
): void => {
  if (evidence.version !== 1) throw new Error(`J_AUTHORITY_VERSION_INVALID:${String(evidence.version)}`);
  if (evidence.source !== 'EntityRegistered' && evidence.source !== 'FoundationBootstrapped') {
    throw new Error(`J_AUTHORITY_SOURCE_INVALID:${String(evidence.source)}`);
  }
  if (!Array.isArray(evidence.topics) || !Array.isArray(evidence.receiptProofNodes)) {
    throw new Error('J_AUTHORITY_RECEIPT_PROOF_SHAPE_INVALID');
  }
  if (evidence.topics.length === 0 || evidence.topics.length > 4) {
    throw new Error(`J_AUTHORITY_TOPIC_COUNT_INVALID:${evidence.topics.length}`);
  }
  if (evidence.receiptProofNodes.length === 0 || evidence.receiptProofNodes.length > MAX_PROOF_NODES) {
    throw new Error(`J_AUTHORITY_PROOF_NODE_COUNT_INVALID:${evidence.receiptProofNodes.length}`);
  }
  const encodedReceipt = canonicalHex(evidence.encodedReceipt, 'ENCODED_RECEIPT', MAX_RECEIPT_BYTES);
  const data = canonicalHex(evidence.data, 'EVENT_DATA', MAX_RECEIPT_DATA_BYTES);
  const receiptProofNodes = evidence.receiptProofNodes.map((node, index) =>
    canonicalHex(node, `PROOF_NODE_${index}`, MAX_PROOF_NODE_BYTES));
  const totalProofBytes = receiptProofNodes.reduce((total, node) => total + (node.length - 2) / 2, 0);
  if (totalProofBytes > MAX_TOTAL_PROOF_BYTES) {
    throw new Error(`J_AUTHORITY_PROOF_OVERSIZED:${totalProofBytes}:${MAX_TOTAL_PROOF_BYTES}`);
  }
  const witnessSignature = canonicalHex(evidence.witnessSignature, 'WITNESS_SIGNATURE', 65);
  const canonical = {
    stackKey: bytes32(evidence.stackKey, 'STACK_KEY'),
    entityId: bytes32(evidence.entityId, 'ENTITY_ID'),
    boardHash: bytes32(evidence.boardHash, 'BOARD_HASH'),
    blockHash: bytes32(evidence.blockHash, 'BLOCK_HASH'),
    transactionHash: bytes32(evidence.transactionHash, 'TRANSACTION_HASH'),
    receiptsRoot: bytes32(evidence.receiptsRoot, 'RECEIPTS_ROOT'),
    observedTipBlockHash: bytes32(evidence.observedTipBlockHash, 'OBSERVED_TIP_HASH'),
    rawLogDigest: bytes32(evidence.rawLogDigest, 'RAW_LOG_DIGEST'),
    emitter: address(evidence.emitter, 'EMITTER'),
    witnessRuntimeId: address(evidence.witnessRuntimeId, 'WITNESS'),
    activationHeight: safeInt(evidence.activationHeight, 'ACTIVATION_HEIGHT'),
    transactionIndex: safeInt(evidence.transactionIndex, 'TRANSACTION_INDEX'),
    logIndex: safeInt(evidence.logIndex, 'LOG_INDEX'),
    receiptLogIndex: safeInt(evidence.receiptLogIndex, 'RECEIPT_LOG_INDEX'),
    observedThroughHeight: safeInt(evidence.observedThroughHeight, 'OBSERVED_THROUGH_HEIGHT'),
    observedHeadHeight: safeInt(evidence.observedHeadHeight, 'OBSERVED_HEAD_HEIGHT'),
    confirmationDepth: safeInt(evidence.confirmationDepth, 'CONFIRMATION_DEPTH'),
    topics: evidence.topics.map((topic, index) => bytes32(topic, `TOPIC_${index}`)),
    data,
    encodedReceipt,
    receiptProofNodes,
    witnessSignature,
  };
  for (const [field, value] of Object.entries(canonical)) {
    const actual = evidence[field as keyof CertifiedRegistrationEvidence];
    if (encodeCanonicalEntityConsensusValue(actual) !== encodeCanonicalEntityConsensusValue(value)) {
      throw new Error(`J_AUTHORITY_NON_CANONICAL_FIELD:${field}`);
    }
  }
  if (canonical.witnessSignature.length !== 132) {
    throw new Error(`J_AUTHORITY_WITNESS_SIGNATURE_LENGTH_INVALID:${canonical.witnessSignature.length}`);
  }
  if (canonical.activationHeight < 1 || canonical.receiptsRoot === ZERO_BYTES32) {
    throw new Error(`J_AUTHORITY_UNCOMMITTED_RECEIPT:${canonical.activationHeight}:${canonical.receiptsRoot}`);
  }
  if (
    canonical.observedThroughHeight < canonical.activationHeight ||
    canonical.observedHeadHeight - canonical.activationHeight < canonical.confirmationDepth ||
    canonical.observedThroughHeight > canonical.observedHeadHeight - canonical.confirmationDepth
  ) {
    throw new Error(
      `J_AUTHORITY_FINALITY_INSUFFICIENT:${canonical.activationHeight}:` +
      `${canonical.observedThroughHeight}:${canonical.observedHeadHeight}:${canonical.confirmationDepth}`,
    );
  }
  if (!env.runtimeId || canonical.witnessRuntimeId !== address(env.runtimeId, 'RUNTIME_ID')) {
    throw new Error(`J_AUTHORITY_WITNESS_RUNTIME_MISMATCH:${canonical.witnessRuntimeId}:${env.runtimeId ?? 'missing'}`);
  }
  const localReplica = assertExactLocalStack(env, evidence);
  const trustedConfirmationDepth = safeInt(
    localReplica.watcherConfirmationDepth,
    'LOCAL_CONFIRMATION_DEPTH',
  );
  if (canonical.confirmationDepth !== trustedConfirmationDepth) {
    throw new Error(
      `J_AUTHORITY_FINALITY_POLICY_MISMATCH:${canonical.confirmationDepth}:${trustedConfirmationDepth}`,
    );
  }
  if (buildRegistrationEvidenceRawLogDigest(evidence) !== evidence.rawLogDigest) {
    throw new Error(`J_AUTHORITY_RAW_LOG_DIGEST_MISMATCH:${evidence.entityId}`);
  }
  assertDecodedRegistrationLog(evidence);
  if (!verifyAccountSignature(
    env,
    evidence.witnessRuntimeId,
    buildRegistrationEvidenceDigest(evidence),
    evidence.witnessSignature,
  )) {
    throw new Error(`J_AUTHORITY_WITNESS_SIGNATURE_INVALID:${evidence.witnessRuntimeId}`);
  }
};

const assertReceiptContainsRawLog = async (evidence: CertifiedRegistrationEvidence): Promise<void> => {
  const { RLP } = await import('@ethereumjs/rlp');
  const encoded = ethers.getBytes(evidence.encodedReceipt);
  const payload = encoded[0] !== undefined && encoded[0] <= 0x7f ? encoded.slice(1) : encoded;
  const decoded = RLP.decode(payload) as unknown;
  if (!Array.isArray(decoded) || !Array.isArray(decoded[3])) {
    throw new Error('J_AUTHORITY_RECEIPT_LOGS_INVALID');
  }
  const rawLog = decoded[3][evidence.receiptLogIndex] as unknown;
  if (!Array.isArray(rawLog) || rawLog.length !== 3 || !Array.isArray(rawLog[1])) {
    throw new Error(`J_AUTHORITY_RECEIPT_LOG_MISSING:${evidence.receiptLogIndex}`);
  }
  const receiptAddress = address(ethers.hexlify(rawLog[0] as Uint8Array), 'RECEIPT_LOG_EMITTER');
  const receiptTopics = (rawLog[1] as Uint8Array[]).map((topic, index) =>
    bytes32(ethers.hexlify(topic), `RECEIPT_TOPIC_${index}`));
  const receiptData = ethers.hexlify(rawLog[2] as Uint8Array).toLowerCase();
  if (
    receiptAddress !== evidence.emitter ||
    encodeCanonicalEntityConsensusValue(receiptTopics) !== encodeCanonicalEntityConsensusValue(evidence.topics) ||
    receiptData !== evidence.data.toLowerCase()
  ) {
    throw new Error(`J_AUTHORITY_RECEIPT_LOG_MISMATCH:${evidence.transactionHash}:${evidence.logIndex}`);
  }
};

export const assertCertifiedRegistrationEvidence = async (
  env: Env,
  evidence: CertifiedRegistrationEvidence,
): Promise<void> => {
  assertRegistrationEvidenceEnvelope(env, evidence);
  await verifyCanonicalReceiptProof({
    receiptsRoot: evidence.receiptsRoot,
    transactionIndex: evidence.transactionIndex,
    encodedReceipt: evidence.encodedReceipt,
    proofNodes: evidence.receiptProofNodes,
  });
  await assertReceiptContainsRawLog(evidence);
};

export const freezeCertifiedRegistrationEvidence = (
  evidence: CertifiedRegistrationEvidence,
): CertifiedRegistrationEvidence => {
  Object.freeze(evidence.topics);
  Object.freeze(evidence.receiptProofNodes);
  return Object.freeze(evidence);
};

export const assertCertifiedRegistrationEvidenceStore = async (env: Env): Promise<void> => {
  const store = env.runtimeState?.certifiedRegistrationEvidence;
  if (store !== undefined && !(store instanceof Map)) {
    throw new Error('J_AUTHORITY_STORE_TYPE_INVALID');
  }
  for (const [key, evidence] of store ?? []) {
    const expectedKey = registrationEvidenceKey(evidence.stackKey, evidence.entityId);
    if (key !== expectedKey) throw new Error(`J_AUTHORITY_STORE_KEY_MISMATCH:${key}:${expectedKey}`);
    await assertCertifiedRegistrationEvidence(env, evidence);
    freezeCertifiedRegistrationEvidence(evidence);
  }
};

type LocalJAuthorityRuntimeTx = Extract<RuntimeTx, {
  type:
    | 'recordAuthenticatedJAuthority'
    | 'observeJRange'
    | 'advanceJWatcherCursor'
    | 'rewindJHistory';
}>;

export const markLocalJAuthorityRuntimeTx = <T extends LocalJAuthorityRuntimeTx>(tx: T): T => {
  Object.defineProperty(tx, LOCAL_J_AUTHORITY_RUNTIME_TX, { value: true, enumerable: false });
  return tx;
};

export const copyLocalJAuthorityRuntimeTxAuthorization = (
  source: RuntimeTx,
  target: RuntimeTx,
): void => {
  if (
    (source.type === 'recordAuthenticatedJAuthority' ||
      source.type === 'observeJRange' ||
      source.type === 'advanceJWatcherCursor' ||
      source.type === 'rewindJHistory') &&
    source.type === target.type &&
    (source as RuntimeTx & { [LOCAL_J_AUTHORITY_RUNTIME_TX]?: boolean })[LOCAL_J_AUTHORITY_RUNTIME_TX]
  ) {
    markLocalJAuthorityRuntimeTx(target as LocalJAuthorityRuntimeTx);
  }
};

export const markRestoredJAuthorityRuntimeTxs = (runtimeTxs: RuntimeTx[]): void => {
  for (const runtimeTx of runtimeTxs) {
    if (
      runtimeTx.type === 'recordAuthenticatedJAuthority' ||
      runtimeTx.type === 'observeJRange' ||
      runtimeTx.type === 'advanceJWatcherCursor' ||
      runtimeTx.type === 'rewindJHistory'
    ) markLocalJAuthorityRuntimeTx(runtimeTx);
  }
};

export const assertJAuthorityRuntimeTxAuthorized = (runtimeTx: RuntimeTx, replay: boolean): void => {
  if (
    runtimeTx.type !== 'recordAuthenticatedJAuthority' &&
    runtimeTx.type !== 'observeJRange' &&
    runtimeTx.type !== 'advanceJWatcherCursor' &&
    runtimeTx.type !== 'rewindJHistory'
  ) return;
  if (
    replay ||
    (runtimeTx as RuntimeTx & { [LOCAL_J_AUTHORITY_RUNTIME_TX]?: boolean })[LOCAL_J_AUTHORITY_RUNTIME_TX]
  ) return;
  throw new Error(`J_AUTHORITY_RUNTIME_TX_EXTERNAL_INGRESS_REJECTED:${runtimeTx.type}`);
};

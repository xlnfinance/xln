import { ethers } from 'ethers';

import { buildSingleSignerHanko, prepareSignedBatch } from '../../../hanko/batch';
import { computeAccountKey } from '../../../jurisdiction/adapter/events/contract-codec';
import type { JAdapter } from '../../../jurisdiction/adapter/types';
import { createEmptyBatch, type JBatch } from '../../../jurisdiction/machine/batch';
import { encodeInt512 } from '../../../protocol/crypto/abi-money';

// A real on-chain dispute whose committed state leaves the LEFT debtor short:
// Depository pays from collateral, then spendable reserve, and books the rest
// as a FIFO debt to the creditor. No mock, no storage write.
export type DisputeParty = { wallet: { privateKey: string }; entityId: string };

const DISPUTE_PROOF = 1;
const PROOF_BODY_ABI =
  'tuple(bytes32 watchSeed,uint32 leftResponseSeconds,uint32 rightResponseSeconds,tuple(int256 high,uint256 low)[] offdeltas,uint256[] tokenIds,tuple(address transformerAddress,bytes encodedBatch,tuple(uint256 deltaIndex,uint256 rightAllowance,uint256 leftAllowance)[] allowances)[] transformers)';
const ABI = ethers.AbiCoder.defaultAbiCoder();

export type SignedBatch = { encodedBatch: string; hankoData: string; nextNonce: bigint };

// JBatch carries dispute nonces as number; refuse any nonce it cannot hold exactly.
export const batchNonce = (nonce: bigint): number => {
  const value = Number(nonce);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`SHORTFALL_NONCE_RANGE:${nonce}`);
  return value;
};

type StartAndAcceptInput = {
  chainId: number;
  depository: string;
  debtor: DisputeParty;
  creditor: DisputeParty;
  offdelta: bigint;
  seedByte: string;
  tokenId: bigint;
  disputeNonce: bigint;
};

// The creditor (RIGHT) starts the dispute over a debtor-signed state, and the
// debtor (LEFT, the non-starter) immediately accepts the exact started state —
// Account.prepareDisputeFinalization lets the non-starter close before T.
// Unsigned, so several accepts can share one debtor batch.
export const buildStartAndAccept = (input: StartAndAcceptInput): { start: JBatch; accept: JBatch } => {
  const { chainId, depository, debtor, creditor, disputeNonce } = input;
  if (debtor.entityId.toLowerCase() >= creditor.entityId.toLowerCase()) {
    throw new Error(`SHORTFALL_DEBTOR_NOT_LEFT:${debtor.entityId}:${creditor.entityId}`);
  }
  const watchSeed = `0x${input.seedByte.repeat(32)}`;
  const proofbody = { watchSeed, leftResponseSeconds: 15n, rightResponseSeconds: 15n, offdeltas: [encodeInt512(input.offdelta)], tokenIds: [input.tokenId], transformers: [] };
  const proofbodyHash = ethers.keccak256(ABI.encode([PROOF_BODY_ABI], [proofbody]));
  const startHash = ethers.keccak256(ABI.encode(
    ['uint8', 'uint256', 'address', 'bytes', 'uint256', 'bool', 'bytes32', 'bytes32'],
    [DISPUTE_PROOF, chainId, depository, computeAccountKey(debtor.entityId, creditor.entityId), disputeNonce, true, proofbodyHash, watchSeed],
  ));
  const start = createEmptyBatch();
  start.disputeStarts.push({
    counterentity: debtor.entityId,
    nonce: batchNonce(disputeNonce),
    proposerIsLeft: true,
    proofbodyHash,
    initialProofbody: proofbody,
    watchSeed,
    sig: buildSingleSignerHanko(debtor.entityId, startHash, debtor.wallet.privateKey),
    starterInitialArguments: '0x',
    starterCounterArguments: '0x',
    starterCounterProofCommitment: ethers.ZeroHash,
  });
  const accept = createEmptyBatch();
  accept.disputeFinalizations.push({
    counterentity: creditor.entityId,
    initialNonce: batchNonce(disputeNonce),
    finalNonce: batchNonce(disputeNonce),
    proposerIsLeft: true,
    initialProofbodyHash: proofbodyHash,
    finalProofbody: proofbody,
    starterArguments: '0x',
    otherArguments: '0x',
    sig: '0x',
    startedByLeft: false,
    cooperative: false,
  });
  return { start, accept };
};

// The same shortfall as two pre-signed batches at explicit Entity nonces, for
// submission into one block.
export const signShortfallStartAndAccept = (
  input: StartAndAcceptInput & { creditorBatchNonce: bigint; debtorBatchNonce: bigint },
): { start: SignedBatch; accept: SignedBatch } => {
  const { chainId, depository, debtor, creditor } = input;
  const { start, accept } = buildStartAndAccept(input);
  return {
    start: prepareSignedBatch(start, creditor.entityId, creditor.wallet.privateKey, BigInt(chainId), depository, input.creditorBatchNonce),
    accept: prepareSignedBatch(accept, debtor.entityId, debtor.wallet.privateKey, BigInt(chainId), depository, input.debtorBatchNonce),
  };
};

const shortfallProof = (offdelta: bigint, seedByte: string, tokenId: bigint) => {
  const watchSeed = `0x${seedByte.repeat(32)}`;
  const proofbody = { watchSeed, leftResponseSeconds: 15n, rightResponseSeconds: 15n, offdeltas: [encodeInt512(offdelta)], tokenIds: [tokenId], transformers: [] };
  return { watchSeed, proofbody, proofbodyHash: ethers.keccak256(ABI.encode([PROOF_BODY_ABI], [proofbody])) };
};

// The debtor (LEFT, the non-starter) answers a dispute started by
// startShortfallDispute with a newer state the creditor signed. Returns the
// block of the CounterDisputeRegistered it emits.
export const counterShortfallDispute = async (
  jAdapter: JAdapter,
  chainId: number,
  debtor: DisputeParty,
  creditor: DisputeParty,
  started: { offdelta: bigint; seedByte: string },
  counter: { offdelta: bigint; seedByte: string },
  tokenId = 1n,
  initialNonce = 1n,
  counterNonce = 2n,
): Promise<number> => {
  const depository = jAdapter.addresses.depository;
  const initial = shortfallProof(started.offdelta, started.seedByte, tokenId);
  const next = shortfallProof(counter.offdelta, counter.seedByte, tokenId);
  const proposerIsLeft = false;
  const counterHash = ethers.keccak256(ABI.encode(
    ['uint8', 'uint256', 'address', 'bytes', 'uint256', 'bool', 'bytes32', 'bytes32'],
    [DISPUTE_PROOF, chainId, depository, computeAccountKey(debtor.entityId, creditor.entityId), counterNonce, proposerIsLeft, next.proofbodyHash, next.watchSeed],
  ));
  const batch = createEmptyBatch();
  batch.counterDisputes.push({
    counterentity: creditor.entityId,
    initialNonce: batchNonce(initialNonce),
    initialProofbodyHash: initial.proofbodyHash,
    counterNonce: batchNonce(counterNonce),
    proposerIsLeft,
    counterProofbody: next.proofbody,
    sig: buildSingleSignerHanko(creditor.entityId, counterHash, creditor.wallet.privateKey),
  });
  const debtorNonce = BigInt(await jAdapter.depository.entityNonces(debtor.entityId));
  const signed = prepareSignedBatch(batch, debtor.entityId, debtor.wallet.privateKey, BigInt(chainId), depository, debtorNonce);
  return (await jAdapter.processBatch(signed.encodedBatch, signed.hankoData, signed.nextNonce)).blockNumber;
};

// The debtor (LEFT) signs a proof with `offdelta`; the creditor (RIGHT) starts
// the dispute with it. Returns the creditor's unilateral finalize for after the
// response window (15 s each side) has passed. A later dispute on the same
// account needs a nonce above the one the previous finalize stored.
export const startShortfallDispute = async (
  jAdapter: JAdapter,
  chainId: number,
  debtor: DisputeParty,
  creditor: DisputeParty,
  offdelta: bigint,
  seedByte: string,
  tokenId = 1n,
  disputeNonce = 1n,
): Promise<() => Promise<void>> => {
  if (debtor.entityId.toLowerCase() >= creditor.entityId.toLowerCase()) {
    throw new Error(`SHORTFALL_DEBTOR_NOT_LEFT:${debtor.entityId}:${creditor.entityId}`);
  }
  const depository = jAdapter.addresses.depository;
  const watchSeed = `0x${seedByte.repeat(32)}`;
  const proofbody = { watchSeed, leftResponseSeconds: 15n, rightResponseSeconds: 15n, offdeltas: [encodeInt512(offdelta)], tokenIds: [tokenId], transformers: [] };
  const proofbodyHash = ethers.keccak256(ABI.encode([PROOF_BODY_ABI], [proofbody]));
  const startHash = ethers.keccak256(ABI.encode(
    ['uint8', 'uint256', 'address', 'bytes', 'uint256', 'bool', 'bytes32', 'bytes32'],
    [DISPUTE_PROOF, chainId, depository, computeAccountKey(debtor.entityId, creditor.entityId), disputeNonce, true, proofbodyHash, watchSeed],
  ));
  const start = createEmptyBatch();
  start.disputeStarts.push({
    counterentity: debtor.entityId,
    nonce: batchNonce(disputeNonce),
    proposerIsLeft: true,
    proofbodyHash,
    initialProofbody: proofbody,
    watchSeed,
    sig: buildSingleSignerHanko(debtor.entityId, startHash, debtor.wallet.privateKey),
    starterInitialArguments: '0x',
    starterCounterArguments: '0x',
    starterCounterProofCommitment: ethers.ZeroHash,
  });
  const creditorNonce = BigInt(await jAdapter.depository.entityNonces(creditor.entityId));
  const signedStart = prepareSignedBatch(start, creditor.entityId, creditor.wallet.privateKey, BigInt(chainId), depository, creditorNonce);
  await jAdapter.processBatch(signedStart.encodedBatch, signedStart.hankoData, signedStart.nextNonce);
  return async (): Promise<void> => {
    const finalize = createEmptyBatch();
    finalize.disputeFinalizations.push({
      counterentity: debtor.entityId,
      initialNonce: batchNonce(disputeNonce),
      finalNonce: batchNonce(disputeNonce),
      proposerIsLeft: true,
      initialProofbodyHash: proofbodyHash,
      finalProofbody: proofbody,
      starterArguments: '0x',
      otherArguments: '0x',
      sig: '0x',
      startedByLeft: false,
      cooperative: false,
    });
    const signed = prepareSignedBatch(finalize, creditor.entityId, creditor.wallet.privateKey, BigInt(chainId), depository, signedStart.nextNonce);
    await jAdapter.processBatch(signed.encodedBatch, signed.hankoData, signed.nextNonce);
  };
};

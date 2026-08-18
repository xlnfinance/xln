import { haltRuntimeFailure } from "../errors/failure-taxonomy";
import { exclusiveUnixMsBigIntToUnixS } from '../units';

/**
 * ProofBody Builder - Constructs ABI-encoded dispute proofs from AccountReplica state
 *
 * This module bridges runtime AccountReplica state to on-chain dispute proofs.
 * The proofBodyHash is what gets signed for bilateral consensus AND dispute submission.
 *
 * Reference: 2024 Channel.ts lines 434-546, Types.sol, DeltaTransformer.sol
 *
 * CRITICAL: Deterministic ordering is essential for consensus.
 * Both sides must compute identical proofBodyHash from identical state.
 */

import { ethers } from 'ethers';
import type { AccountReplica, AccountState, Delta } from '../../types/account.js';
import type {
  RuntimeProofBody,
  RuntimeTransformerClause,
  RuntimeBatch,
  RuntimePayment,
  RuntimePull,
  RuntimeSwap,
  RuntimeAllowance,
  ProofBodyResult,
} from './proof-body.ts';
import type { ProofBodyStruct, TransformerClauseStruct } from '../../../jurisdictions/typechain-types/Depository.sol/Depository.ts';
import type { DeltaTransformer } from '../../../jurisdictions/typechain-types/DeltaTransformer.sol/DeltaTransformer.ts';
import { PROOF_BODY_ABI, BATCH_ABI } from './proof-body.ts';
import { sortTransformerEntries } from '../transform/transformer-ordering';
import { normalizeAccountWatchSeed } from '../identity/account-watch-seed';
import { HASHLADDER_MAX_FILL_RATIO } from '../htlc/hash-ladder.ts';
import { assertDisputeProofBodyWithinContractLimits } from '../../jurisdiction/machine/batch/index.ts';
import { encodeBuffer } from '../../storage/codec/codec.ts';
import { MAX_ACCOUNT_ENVELOPE_ROW_BYTES } from '../../storage/schema/account-envelope-graph.ts';

/**
 * Bound each scalar ProofBody atom before its hash enters consensus. The
 * Account envelope is a Patricia value graph, so the whole ProofBody is not a
 * LevelDB leaf: arrays/records become branches and their scalar values become
 * leaves. Measuring the whole object here used to reject a perfectly storable
 * proof once unrelated swaps and pulls together crossed 9 KB.
 *
 * `encodedBatch` is the only potentially growing scalar in a transformer
 * clause. Measure its exact canonical storage encoding, not ABI bytes or a
 * heuristic, so consensus never signs a value that the WAL cannot persist.
 */
export const MAX_ACCOUNT_DISPUTE_PROOF_ATOM_BYTES = MAX_ACCOUNT_ENVELOPE_ROW_BYTES;

export class AccountDisputeProofBudgetError extends Error {
  constructor(
    readonly encodedBytes: number,
    readonly transformerIndex: number,
  ) {
    super(
      `ACCOUNT_DISPUTE_PROOF_ATOM_BYTES_EXCEEDED:` +
      `transformer=${transformerIndex}:` +
      `${encodedBytes}/${MAX_ACCOUNT_DISPUTE_PROOF_ATOM_BYTES}`,
    );
    this.name = 'AccountDisputeProofBudgetError';
  }
}
import { compareStableText } from '../serialization';
import { abiSchemaFromFragment, encodeAbi } from '../crypto/abi-encode';
import { deriveSwapOffdeltaChanges } from '../../orderbook/swap-execution.ts';
import { deriveTransferOffdeltaChange } from '../transform/delta-movement';
import {
  hashCooperativeDisputeProofHankoPayload,
  hashCooperativeUpdateHankoPayload,
  hashDisputeProofHankoPayload,
  type DepositoryHankoDomain,
} from '../../hanko/onchain-domain.ts';
import { keccakHexHash } from '../crypto/keccak-text';

export type { DepositoryHankoDomain } from '../../hanko/onchain-domain.ts';

type DisputeHashState = Pick<AccountState, 'leftEntity' | 'rightEntity' | 'watchSeed'>;
type DisputeHashReplica = Pick<AccountReplica, 'state' | 'proofHeader'>;
type SettlementHashState = Pick<AccountState, 'leftEntity' | 'rightEntity'>;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
// Direct encoder (byte-identical to AbiCoder for these fragments; see abi-encode.ts).
const PROOF_BODY_SCHEMA = abiSchemaFromFragment(PROOF_BODY_ABI);
const DELTA_BATCH_SCHEMA = abiSchemaFromFragment(BATCH_ABI);
const INT256_MIN = -(1n << 255n);
const INT256_MAX = (1n << 255n) - 1n;

const encodeProofBodyStruct = (proofBody: ProofBodyStruct): string =>
  encodeAbi(PROOF_BODY_SCHEMA, proofBody);

// A proof body is immutable evidence addressed by its own hash; the same
// struct instance is re-hashed by retention asserts on every Account commit
// and by seal validation. Identity-keyed memo: a rebuilt or reloaded struct
// is a new object and hashes afresh.
const proofBodyHashByStruct = new WeakMap<object, string>();

export const hashProofBodyStruct = (proofBody: ProofBodyStruct): string => {
  const cached = proofBodyHashByStruct.get(proofBody);
  if (cached !== undefined) return cached;
  const hash = keccakHexHash(encodeProofBodyStruct(proofBody));
  proofBodyHashByStruct.set(proofBody, hash);
  return hash;
};

const isUsableContractAddress = (address: string | null | undefined): address is string =>
  typeof address === 'string' && ethers.isAddress(address) && address !== ZERO_ADDRESS;

const requireContractAddress = (label: string, address: string | null | undefined): string => {
  if (!isUsableContractAddress(address)) {
    throw new Error(`MISSING_${label.toUpperCase()}_ADDRESS`);
  }
  return address;
};

const assertFinalDeltaCanFinalize = (
  tokenId: number,
  ondelta: bigint,
  offdelta: bigint,
): void => {
  if (
    ondelta < INT256_MIN || ondelta > INT256_MAX ||
    offdelta < INT256_MIN || offdelta > INT256_MAX
  ) {
    throw haltRuntimeFailure("DISPUTE_PROOFBODY_FINAL_DELTA_OVERFLOW", `DISPUTE_PROOFBODY_FINAL_DELTA_OVERFLOW:token=${tokenId}`);
  }
  const finalDelta = ondelta + offdelta;
  if (finalDelta < INT256_MIN || finalDelta > INT256_MAX) {
    throw haltRuntimeFailure("DISPUTE_PROOFBODY_FINAL_DELTA_OVERFLOW", `DISPUTE_PROOFBODY_FINAL_DELTA_OVERFLOW:token=${tokenId}`);
  }
  // Depository._applyAccountDelta negates negative final deltas. Solidity
  // cannot negate int256.min, so a validator must never sign a ProofBody that
  // is structurally valid yet impossible to finalize on-chain.
  if (finalDelta === INT256_MIN) {
    throw haltRuntimeFailure("DISPUTE_PROOFBODY_FINAL_DELTA_INT256_MIN", `DISPUTE_PROOFBODY_FINAL_DELTA_INT256_MIN:token=${tokenId}`);
  }
};

const addDeltaAllowance = (
  allowances: Map<number, { leftAllowance: bigint; rightAllowance: bigint }>,
  deltaIndex: number,
  signedDiff: bigint,
): void => {
  if (signedDiff === 0n) return;
  const entry = allowances.get(deltaIndex) ?? { leftAllowance: 0n, rightAllowance: 0n };
  if (signedDiff > 0n) entry.leftAllowance += signedDiff;
  else entry.rightAllowance += -signedDiff;
  allowances.set(deltaIndex, entry);
};

function buildTransformerAllowances(batch: RuntimeBatch): RuntimeAllowance[] {
  const allowances = new Map<number, { leftAllowance: bigint; rightAllowance: bigint }>();

  for (const payment of batch.payments) {
    addDeltaAllowance(allowances, payment.deltaIndex, payment.amount);
  }
  for (const swap of batch.swaps) {
    const change = deriveSwapOffdeltaChanges(swap.ownerIsLeft, swap.addAmount, swap.subAmount);
    addDeltaAllowance(allowances, swap.addDeltaIndex, change.give);
    addDeltaAllowance(allowances, swap.subDeltaIndex, change.want);
  }
  for (const pull of batch.pulls) {
    addDeltaAllowance(allowances, pull.deltaIndex, pull.amount);
  }

  return Array.from(allowances.entries())
    .sort(([a], [b]) => a - b)
    .map(([deltaIndex, allowance]) => ({
      deltaIndex,
      rightAllowance: allowance.rightAllowance,
      leftAllowance: allowance.leftAllowance,
    }));
}

type ProofDeltaIndex = {
  tokenIds: number[];
  offdeltas: bigint[];
  byTokenId: Map<number, number>;
};

const buildProofDeltaIndex = (
  account: AccountReplica,
  deltaOverrides?: ReadonlyMap<number, Delta>,
): ProofDeltaIndex => {
  const tokenIds: number[] = [];
  const offdeltas: bigint[] = [];
  const byTokenId = new Map<number, number>();
  const projected = new Map(account.state.deltas.entries());
  for (const [tokenId, delta] of deltaOverrides ?? []) projected.set(tokenId, delta);
  const sorted = Array.from(projected)
    .sort(([left], [right]) => left - right);
  for (const [tokenId, delta] of sorted) {
    assertFinalDeltaCanFinalize(tokenId, delta.ondelta ?? 0n, delta.offdelta);
    byTokenId.set(tokenId, tokenIds.length);
    tokenIds.push(tokenId);
    // The contract combines this off-chain component with stored ondelta.
    offdeltas.push(delta.offdelta);
  }
  return { tokenIds, offdeltas, byTokenId };
};

const requireProofDeltaIndex = (
  index: ReadonlyMap<number, number>,
  tokenId: number,
  error: string,
): number => {
  const deltaIndex = index.get(tokenId);
  if (deltaIndex === undefined) throw new Error(error);
  return deltaIndex;
};

const buildProofPayments = (
  account: AccountReplica,
  deltaIndex: ReadonlyMap<number, number>,
): RuntimePayment[] =>
  sortTransformerEntries(account.state.locks.entries()).map(([lockId, lock]) => {
    const revealedUntilTimestamp = exclusiveUnixMsBigIntToUnixS(
      lock.timelock,
      `HTLC_LOCK_INVALID_TIMELOCK:${lockId}`,
    );
    return {
      deltaIndex: requireProofDeltaIndex(
        deltaIndex,
        lock.tokenId,
        `PROOF_BODY_LOCK_TOKEN_MISSING:${lockId}:${lock.tokenId}`,
      ),
      amount: deriveTransferOffdeltaChange(lock.senderIsLeft, lock.amount),
      revealedUntilTimestamp,
      hash: lock.hashlock,
    };
  });

const buildProofSwaps = (
  account: AccountReplica,
  deltaIndex: ReadonlyMap<number, number>,
): RuntimeSwap[] =>
  sortTransformerEntries(account.state.swapOffers.entries()).flatMap(
    ([offerId, offer]) => {
      if (offer.crossJurisdiction) return [];
      return [{
        ownerIsLeft: offer.makerIsLeft,
        addDeltaIndex: requireProofDeltaIndex(
          deltaIndex,
          offer.giveTokenId,
          `PROOF_BODY_SWAP_TOKEN_MISSING:${offerId}:give=${offer.giveTokenId}:want=${offer.wantTokenId}`,
        ),
        addAmount: offer.giveAmount,
        subDeltaIndex: requireProofDeltaIndex(
          deltaIndex,
          offer.wantTokenId,
          `PROOF_BODY_SWAP_TOKEN_MISSING:${offerId}:give=${offer.giveTokenId}:want=${offer.wantTokenId}`,
        ),
        subAmount: offer.wantAmount,
      }];
    },
  );

const buildProofPulls = (
  account: AccountReplica,
  deltaIndex: ReadonlyMap<number, number>,
): RuntimePull[] =>
  sortTransformerEntries((account.state.pulls ?? new Map()).entries())
    .map(([pullId, pull]) => ({
      deltaIndex: requireProofDeltaIndex(
        deltaIndex,
        pull.tokenId,
        `PROOF_BODY_PULL_TOKEN_MISSING:${pullId}:${pull.tokenId}`,
      ),
      amount: pull.amount,
      claimedRatio: Math.max(
        0,
        Math.min(
          HASHLADDER_MAX_FILL_RATIO,
          Math.floor(Number(pull.claimedRatio ?? 0)),
        ),
      ),
      fullHash: pull.fullHash,
      partialRoot: pull.partialRoot,
      targetRole: pull.crossJurisdiction?.leg === 'target',
    }));

const buildSubcontractTransformers = (
  account: AccountReplica,
): RuntimeTransformerClause[] =>
  Array.from(account.state.subcontracts ?? [])
    .sort(([left], [right]) => compareStableText(left, right))
    .map(([subcontractId, subcontract]) => {
      const transformerAddress = requireContractAddress(
        `subcontract_${subcontractId}`,
        subcontract.transformerAddress,
      );
      if (!ethers.isHexString(subcontract.encodedBatch)) {
        throw new Error(`SUBCONTRACT_ENCODED_BATCH_INVALID:${subcontractId}`);
      }
      const allowances = subcontract.allowances
        .map(allowance => ({ ...allowance }))
        .sort((left, right) => left.deltaIndex - right.deltaIndex);
      return {
        transformerAddress,
        encodedBatch: subcontract.encodedBatch,
        allowances,
      };
    });

const buildProofTransformers = (
  account: AccountReplica,
  deltaIndex: ReadonlyMap<number, number>,
  deltaTransformerAddress: string,
): RuntimeTransformerClause[] => {
  const payments: RuntimeBatch = {
    payments: buildProofPayments(account, deltaIndex),
    swaps: [],
    pulls: [],
  };
  const swaps: RuntimeBatch = {
    payments: [],
    swaps: buildProofSwaps(account, deltaIndex),
    pulls: [],
  };
  const pulls: RuntimeBatch = {
    payments: [],
    swaps: [],
    pulls: buildProofPulls(account, deltaIndex),
  };
  const batches = [payments, swaps, pulls].filter(batch =>
    batch.payments.length > 0 || batch.swaps.length > 0 || batch.pulls.length > 0);
  if (batches.length === 0) return buildSubcontractTransformers(account);
  const transformerAddress = requireContractAddress('delta_transformer', deltaTransformerAddress);
  // DeltaTransformer executes clauses sequentially. The canonical order
  // payment→swap→pull is therefore byte-stable and economically identical to
  // the former combined batch. Separating the three bounded collections keeps
  // every independently persisted encodedBatch below the 10 KB record limit
  // even when all configured collection maxima coexist. Dispute arguments
  // duplicate the same compact tuple across the present payment/swap prefix;
  // pulls consume no caller-supplied arguments and read Depository registry
  // proof only. Never interleave user subcontracts with this canonical prefix.
  const batchTransformers: RuntimeTransformerClause[] = batches.map(batch => ({
    transformerAddress,
    batch,
    allowances: buildTransformerAllowances(batch),
  }));
  return [...batchTransformers, ...buildSubcontractTransformers(account)];
};

/**
 * Build ABI-encoded ProofBody from AccountReplica state
 *
 * This is the core function that transforms runtime state into on-chain proof format.
 * The resulting proofBodyHash is signed during bilateral consensus.
 *
 * @param account - Current bilateral account state
 * @param deltaTransformerAddress - Exact address resolved by the caller from
 *   this Account's trusted (chainId, Depository) jurisdiction replica. Keeping
 *   it explicit prevents one runtime or chain from changing another runtime's
 *   signed ProofBody through process-global configuration.
 * @returns ProofBodyResult with runtime, struct, encoded, and hash forms
 */
export function buildAccountProofBody(
  account: AccountReplica,
  deltaTransformerAddress: string,
  deltaOverrides?: ReadonlyMap<number, Delta>,
): ProofBodyResult {
  const deltaIndex = buildProofDeltaIndex(account, deltaOverrides);
  const runtimeProofBody: RuntimeProofBody = {
    watchSeed: normalizeAccountWatchSeed(account.state.watchSeed, 'PROOF_BODY'),
    leftResponseSeconds: account.state.disputeConfig.leftResponseSeconds,
    rightResponseSeconds: account.state.disputeConfig.rightResponseSeconds,
    offdeltas: deltaIndex.offdeltas,
    tokenIds: deltaIndex.tokenIds,
    transformers: buildProofTransformers(
      account,
      deltaIndex.byTokenId,
      deltaTransformerAddress,
    ),
  };
  const proofBodyStruct = runtimeToProofBodyStruct(runtimeProofBody);
  // This is the final boundary before the hash enters a validator's Hanko.
  // Later J-submit validation cannot repair an already-certified invalid body.
  const encodedProofBody = encodeProofBodyStruct(proofBodyStruct);
  // Contract executability is the outer protocol boundary and retains its
  // canonical failure code even when the same body also exceeds local storage.
  assertDisputeProofBodyWithinContractLimits(proofBodyStruct, 'account.signing', encodedProofBody);
  for (const [transformerIndex, transformer] of proofBodyStruct.transformers.entries()) {
    const atomBytes = encodeBuffer({ kind: 'atom', value: transformer.encodedBatch }).byteLength;
    if (atomBytes >= MAX_ACCOUNT_DISPUTE_PROOF_ATOM_BYTES) {
      throw new AccountDisputeProofBudgetError(atomBytes, transformerIndex);
    }
  }
  const proofBodyHash = keccakHexHash(encodedProofBody);
  proofBodyHashByStruct.set(proofBodyStruct, proofBodyHash);
  return {
    runtimeProofBody,
    proofBodyStruct,
    encodedProofBody,
    proofBodyHash,
  };
}

/**
 * Convert RuntimeProofBody to ABI-compatible ProofBodyStruct
 */
function runtimeToProofBodyStruct(runtime: RuntimeProofBody): ProofBodyStruct {
  const transformers: TransformerClauseStruct[] = runtime.transformers.map(t => {
    const batchStruct: DeltaTransformer.BatchStruct | null = 'batch' in t ? {
      payment: t.batch.payments.map(p => ({
        deltaIndex: BigInt(p.deltaIndex),
        amount: p.amount,
        revealedUntilTimestamp: BigInt(p.revealedUntilTimestamp),
        hash: p.hash,
      })),
      swap: t.batch.swaps.map(s => ({
        ownerIsLeft: s.ownerIsLeft,
        addDeltaIndex: BigInt(s.addDeltaIndex),
        addAmount: s.addAmount,
        subDeltaIndex: BigInt(s.subDeltaIndex),
        subAmount: s.subAmount,
      })),
      pull: t.batch.pulls.map(p => ({
        deltaIndex: BigInt(p.deltaIndex),
        amount: p.amount,
        claimedRatio: p.claimedRatio,
        fullHash: p.fullHash,
        partialRoot: p.partialRoot,
        targetRole: p.targetRole === true,
      })),
    } : null;

    const encodedBatch = 'encodedBatch' in t
      ? t.encodedBatch
      : encodeAbi(DELTA_BATCH_SCHEMA, batchStruct!);

    return {
      transformerAddress: t.transformerAddress,
      encodedBatch,
      allowances: t.allowances.map(a => ({
        deltaIndex: BigInt(a.deltaIndex),
        rightAllowance: a.rightAllowance,
        leftAllowance: a.leftAllowance,
      })),
    };
  });

  return {
    watchSeed: runtime.watchSeed,
    leftResponseSeconds: runtime.leftResponseSeconds,
    rightResponseSeconds: runtime.rightResponseSeconds,
    offdeltas: runtime.offdeltas,
    tokenIds: runtime.tokenIds.map(id => BigInt(id)),
    transformers,
  };
}

function getCanonicalAccountKey(account: DisputeHashState): string {
  const leftEntity = String(account.leftEntity).toLowerCase();
  const rightEntity = String(account.rightEntity).toLowerCase();
  const [first, second] =
    leftEntity < rightEntity
      ? [account.leftEntity, account.rightEntity]
      : [account.rightEntity, account.leftEntity];
  return ethers.solidityPacked(['bytes32', 'bytes32'], [first, second]);
}

/**
 * Create full dispute proof hash for signing
 * This is what both parties sign to authorize a dispute proof
 */
export function createDisputeProofHash(
  account: DisputeHashReplica,
  proofBodyHash: string,
  domain: DepositoryHankoDomain,
  proposerIsLeft: boolean,
): string {
  return hashDisputeProofHankoPayload(
    domain,
    getCanonicalAccountKey(account.state),
    account.proofHeader.nextProofNonce,
    proposerIsLeft,
    proofBodyHash,
    normalizeAccountWatchSeed(account.state.watchSeed, 'DISPUTE_MESSAGE'),
  );
}

/**
 * Create dispute proof hash with explicit nonce.
 * Used for nonce+1 pre-signing during settlement: after a settlement is applied
 * on-chain, nonce is counter. Proofs signed at the old nonce
 * become invalid. Pre-signing at nonce+1 ensures valid dispute proofs exist
 * immediately after settlement.
 *
 * proofBodyHash is UNCHANGED by settlement (settlement modifies ondelta/collateral,
 * but proofBody only includes offdelta). So the same proofBodyHash can be re-signed
 * at the new nonce.
 */
export function createDisputeProofHashWithNonce(
  account: DisputeHashState,
  proofBodyHash: string,
  domain: DepositoryHankoDomain,
  nonce: number,
  proposerIsLeft: boolean,
): string {
  const chKey = getCanonicalAccountKey(account);
  const watchSeed = normalizeAccountWatchSeed(account.watchSeed, 'DISPUTE_MESSAGE');
  return hashDisputeProofHankoPayload(
    domain,
    chKey,
    nonce,
    proposerIsLeft,
    proofBodyHash,
    watchSeed,
  );
}

/** Matches Account.sol MessageType.CooperativeDisputeProof exactly. */
export function createCooperativeDisputeProofHash(
  account: DisputeHashState,
  proofBodyHash: string,
  starterInitialArgumentsHash: string,
  domain: DepositoryHankoDomain,
  nonce: number,
): string {
  return hashCooperativeDisputeProofHankoPayload(
    domain,
    getCanonicalAccountKey(account),
    nonce,
    proofBodyHash,
    starterInitialArgumentsHash,
  );
}

/**
 * Create settlement hash for bilateral signature with explicit nonce
 * Matches Account.sol CooperativeUpdate encoding
 * @param nonce The on-chain nonce for cooperative settlement
 *
 * Both chain ID and Depository address are required. Deterministic deployments
 * can reuse an address across chains, so either value alone is not a domain.
 */
export function createSettlementHashWithNonce(
  account: SettlementHashState,
  diffs: Array<{
    tokenId: number;
    leftDiff: bigint;
    rightDiff: bigint;
    collateralDiff: bigint;
    ondeltaDiff: bigint;
  }>,
  forgiveDebtsInTokenIds: readonly number[],
  domain: DepositoryHankoDomain,
  nonce: number
): string {
  // Account key is canonical (left:right)
  const accountKey = ethers.solidityPacked(
    ['bytes32', 'bytes32'],
    [account.leftEntity, account.rightEntity]
  );

  // Match Account.sol CooperativeUpdate encoding exactly:
  // abi.encode(MessageType.CooperativeUpdate, block.chainid, address(this),
  //   acct_key, s.nonce, s.diffs, s.forgiveDebtsInTokenIds)
  return hashCooperativeUpdateHankoPayload(
    domain,
    accountKey,
    nonce,
    diffs,
    forgiveDebtsInTokenIds,
  );
}

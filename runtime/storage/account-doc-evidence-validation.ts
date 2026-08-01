import { LIMITS, TOKENS } from '../config/constants';
import {
  assertDisputeProofBodyWithinContractLimits,
  J_BATCH_CONTRACT_LIMITS,
} from '../jurisdiction/machine/batch';
import type { DisputeArgumentSnapshot } from '../protocol/dispute/argument-snapshot';
import type { ProofBodyStruct } from '../protocol/dispute/proof-body';
import { hashProofBodyStruct } from '../protocol/dispute/proof-builder';
import {
  boundedArray,
  bytes,
  hex,
  int256,
  shape,
  text,
  uint,
  uint256,
} from './account-doc-validation-primitives';
import { requireBoundaryRecord } from './schema-primitives';

const abiUint = (value: unknown, maximum: bigint, code: string): bigint => {
  const parsed = typeof value === 'bigint'
    ? uint256(value, code)
    : BigInt(uint(value, code));
  if (parsed > maximum) throw new Error(`${code}_MAX`);
  return parsed;
};

const validateProofBody = (value: unknown, code: string): ProofBodyStruct => {
  const body = shape(value, ['watchSeed', 'offdeltas', 'tokenIds', 'transformers'], [], code);
  bytes(body['watchSeed'], 32, `${code}_WATCH_SEED`);
  const tokenIds = boundedArray(
    body['tokenIds'],
    J_BATCH_CONTRACT_LIMITS.maxDisputeProofTokens,
    `${code}_TOKENS`,
  );
  const offdeltas = boundedArray(
    body['offdeltas'],
    J_BATCH_CONTRACT_LIMITS.maxDisputeProofTokens,
    `${code}_DELTAS`,
  );
  if (tokenIds.length !== offdeltas.length) throw new Error(`${code}_LENGTH`);
  tokenIds.forEach((tokenId, index) =>
    abiUint(tokenId, BigInt(TOKENS.MAX_TOKEN_ID), `${code}_TOKEN_${index}`));
  offdeltas.forEach((delta, index) => int256(delta, `${code}_DELTA_${index}`));
  for (const [index, raw] of boundedArray(
    body['transformers'],
    J_BATCH_CONTRACT_LIMITS.maxDisputeTransformers,
    `${code}_TRANSFORMERS`,
  ).entries()) {
    const transformer = shape(
      raw,
      ['transformerAddress', 'encodedBatch', 'allowances'],
      [],
      `${code}_TRANSFORMER_${index}`,
    );
    bytes(transformer['transformerAddress'], 20, `${code}_TRANSFORMER_${index}_ADDRESS`);
    hex(transformer['encodedBatch'], `${code}_TRANSFORMER_${index}_BATCH`);
    for (const [allowanceIndex, allowanceRaw] of boundedArray(
      transformer['allowances'],
      tokenIds.length,
      `${code}_TRANSFORMER_${index}_ALLOWANCES`,
    ).entries()) {
      const allowance = shape(
        allowanceRaw,
        ['deltaIndex', 'rightAllowance', 'leftAllowance'],
        [],
        `${code}_TRANSFORMER_${index}_ALLOWANCE_${allowanceIndex}`,
      );
      if (
        abiUint(allowance['deltaIndex'], BigInt(Number.MAX_SAFE_INTEGER), `${code}_ALLOWANCE_INDEX`)
        >= BigInt(tokenIds.length)
      ) throw new Error(`${code}_ALLOWANCE_RANGE`);
      uint256(allowance['rightAllowance'], `${code}_ALLOWANCE_RIGHT`);
      uint256(allowance['leftAllowance'], `${code}_ALLOWANCE_LEFT`);
    }
  }
  const proofBody = body as ProofBodyStruct;
  assertDisputeProofBodyWithinContractLimits(proofBody, code);
  return proofBody;
};

export const validateStoredDisputeEvidence = (
  account: Record<string, unknown>,
  code: string,
): void => {
  if (account['disputeProofNoncesByHash'] !== undefined) {
    const nonces = requireBoundaryRecord(account['disputeProofNoncesByHash'], `${code}_NONCES`);
    for (const [hash, nonce] of Object.entries(nonces)) {
      bytes(hash, 32, `${code}_NONCE_HASH`);
      uint(nonce, `${code}_NONCE`);
    }
  }
  if (account['disputeProofBodiesByHash'] !== undefined) {
    const bodies = requireBoundaryRecord(account['disputeProofBodiesByHash'], `${code}_BODIES`);
    for (const [hash, raw] of Object.entries(bodies)) {
      const claimed = bytes(hash, 32, `${code}_BODY_HASH`);
      if (hashProofBodyStruct(validateProofBody(raw, `${code}_BODY`)) !== claimed) {
        throw new Error(`${code}_BODY_HASH_MISMATCH`);
      }
    }
  }
  if (account['disputeArgumentSnapshotsByHash'] === undefined) return;
  const snapshots = requireBoundaryRecord(account['disputeArgumentSnapshotsByHash'], `${code}_SNAPSHOTS`);
  for (const [hash, raw] of Object.entries(snapshots)) {
    const snapshot = shape(
      raw,
      ['proofbodyHash', 'nonce', 'side', 'proofBodyStruct', 'plan'],
      [],
      `${code}_SNAPSHOT`,
    );
    const claimed = bytes(hash, 32, `${code}_SNAPSHOT_KEY`);
    if (bytes(snapshot['proofbodyHash'], 32, `${code}_SNAPSHOT_HASH`) !== claimed) {
      throw new Error(`${code}_SNAPSHOT_KEY_MISMATCH`);
    }
    uint(snapshot['nonce'], `${code}_SNAPSHOT_NONCE`);
    if (snapshot['side'] !== 'left' && snapshot['side'] !== 'right') throw new Error(`${code}_SNAPSHOT_SIDE`);
    if (hashProofBodyStruct(validateProofBody(snapshot['proofBodyStruct'], `${code}_SNAPSHOT_BODY`)) !== claimed) {
      throw new Error(`${code}_SNAPSHOT_BODY_MISMATCH`);
    }
    const plan = shape(
      snapshot['plan'],
      ['paymentHashlocks', 'leftSwapOfferIds', 'rightSwapOfferIds', 'leftPullIds', 'rightPullIds'],
      [],
      `${code}_SNAPSHOT_PLAN`,
    );
    const arrays: Array<[keyof DisputeArgumentSnapshot['plan'], number]> = [
      ['paymentHashlocks', LIMITS.MAX_ACCOUNT_HTLC_LOCKS],
      ['leftSwapOfferIds', LIMITS.MAX_ACCOUNT_SWAP_OFFERS],
      ['rightSwapOfferIds', LIMITS.MAX_ACCOUNT_SWAP_OFFERS],
      ['leftPullIds', LIMITS.MAX_ACCOUNT_SWAP_OFFERS],
      ['rightPullIds', LIMITS.MAX_ACCOUNT_SWAP_OFFERS],
    ];
    for (const [field, maximum] of arrays) {
      boundedArray(plan[field], maximum, `${code}_SNAPSHOT_${field}`)
        .forEach((entry, index) => text(entry, `${code}_SNAPSHOT_${field}_${index}`));
    }
  }
};

import { ethers } from 'ethers';
import { keccakHexHash } from '../protocol/crypto/keccak-text';
import { abiSchemaFromType, encodeAbiParams, type AbiSchema } from '../protocol/crypto/abi-encode';

export type DepositoryHankoDomain = Readonly<{
  chainId: number | bigint;
  depositoryAddress: string;
}>;

export type EntityProviderHankoDomain = Readonly<{
  chainId: number | bigint;
  entityProviderAddress: string;
  boardEpoch: number | bigint;
}>;

export type CooperativeUpdateDiff = Readonly<{
  tokenId: number | bigint;
  leftDiff: bigint;
  rightDiff: bigint;
  collateralDiff: bigint;
  ondeltaDiff: bigint;
}>;

export type WatchtowerCounterDisputeAuthorization = Readonly<{
  towerAddress: string;
  entityId: string;
  counterentity: string;
  finalNonce: number | bigint;
  finalProofbodyHash: string;
  lastResortWindowSeconds: number | bigint;
  appointmentSequence: number | bigint;
}>;

export type EntityTransferAuthorization = Readonly<{
  entityNumber: number | bigint;
  to: string;
  tokenId: number | bigint;
  amount: number | bigint;
  actionNonce: number | bigint;
}>;

export type ReleaseControlSharesAuthorization = Readonly<{
  entityNumber: number | bigint;
  recipientAddress: string;
  controlAmount: number | bigint;
  dividendAmount: number | bigint;
  purpose: string;
  actionNonce: number | bigint;
}>;

export type CancelEntityProviderActionAuthorization = Readonly<{
  entityNumber: number | bigint;
  actionNonce: number | bigint;
  cancelledActionHash: string;
  cancelledActionKind: number | bigint;
}>;

export type WatchtowerMinSequenceAuthorization = Readonly<{
  entityNumber: number | bigint;
  newMinimum: number | bigint;
  actionNonce: number | bigint;
}>;

export type BoardProposalAuthorization = Readonly<{
  entityId: string;
  newBoardHash: string;
  authority: number | bigint;
  actionNonce: number | bigint;
}>;

export type BoardProposalCancelAuthorization = Readonly<{
  entityId: string;
  proposedBoardHash: string;
  proposedBy: number | bigint;
  cancelledBy: number | bigint;
  actionNonce: number | bigint;
}>;

const DEPOSITORY_BATCH_HANKO_DOMAIN = ethers.keccak256(
  ethers.toUtf8Bytes('XLN_DEPOSITORY_HANKO_V1'),
);
const WATCHTOWER_COUNTER_DISPUTE_HANKO_DOMAIN = ethers.keccak256(
  ethers.toUtf8Bytes('XLN_WATCHTOWER_COUNTER_DISPUTE_V1'),
);
const ENTITY_TRANSFER_HANKO_LABEL = 'ENTITY_TRANSFER';
const RELEASE_CONTROL_SHARES_HANKO_LABEL = 'RELEASE_CONTROL_SHARES';
const CANCEL_ENTITY_PROVIDER_ACTION_HANKO_LABEL = 'CANCEL_ENTITY_PROVIDER_ACTION';
const WATCHTOWER_MIN_SEQUENCE_HANKO_LABEL = 'WATCHTOWER_MIN_SEQUENCE';
const BOARD_PROPOSAL_HANKO_DOMAIN = ethers.keccak256(
  ethers.toUtf8Bytes('XLN_ENTITY_PROVIDER_BOARD_PROPOSAL_V1'),
);
const BOARD_PROPOSAL_CANCEL_HANKO_DOMAIN = ethers.keccak256(
  ethers.toUtf8Bytes('XLN_ENTITY_PROVIDER_BOARD_PROPOSAL_CANCEL_V1'),
);
export const ENTITY_PROVIDER_ACTION_EXECUTED_EVENT =
  'EntityProviderActionExecuted(bytes32,uint256,bytes32,uint8)';
export const ENTITY_PROVIDER_ACTION_EXECUTED_TOPIC = ethers.id(ENTITY_PROVIDER_ACTION_EXECUTED_EVENT);
export const ENTITY_PROVIDER_ACTION_CANCELLED_EVENT =
  'EntityProviderActionCancelled(bytes32,uint256,bytes32,uint8,bytes32)';
export const ENTITY_PROVIDER_ACTION_CANCELLED_TOPIC = ethers.id(ENTITY_PROVIDER_ACTION_CANCELLED_EVENT);
// EntityProvider.EntityProviderActionKind. All three share one entity action nonce lane.
export const ENTITY_PROVIDER_ACTION_KIND = Object.freeze({
  entityTransfer: 0,
  releaseControlShares: 1,
  watchtowerMinSequence: 2,
} as const);
const MAX_ENTITY_PROVIDER_ACTION_KIND = BigInt(ENTITY_PROVIDER_ACTION_KIND.watchtowerMinSequence);

const ABI_CODER = ethers.AbiCoder.defaultAbiCoder();
// Flat parameter lists go through the direct encoder (byte-identical to
// AbiCoder, differential-tested); inline tuple arrays stay on ethers.
const FAST_ABI_SCHEMAS = new Map<string, AbiSchema[]>();
const encodeParams = (types: readonly string[], values: readonly unknown[]): string => {
  const key = types.join(',');
  let schemas = FAST_ABI_SCHEMAS.get(key);
  if (!schemas) {
    schemas = types.map(abiSchemaFromType);
    FAST_ABI_SCHEMAS.set(key, schemas);
  }
  return encodeAbiParams(schemas, values);
};
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const requireUint = (value: number | bigint, label: string): bigint => {
  const normalized = typeof value === 'bigint'
    ? value
    : Number.isSafeInteger(value)
      ? BigInt(value)
      : -1n;
  if (normalized < 0n) throw new Error(`INVALID_HANKO_${label}:${String(value)}`);
  return normalized;
};

const requireAddress = (value: string, label: string): string => {
  if (!ethers.isAddress(value) || value === ZERO_ADDRESS) {
    throw new Error(`INVALID_HANKO_${label}:${value || 'missing'}`);
  }
  return value;
};

const requireBoardAuthority = (value: number | bigint, label: string): bigint => {
  const authority = requireUint(value, label);
  if (authority > 3n) throw new Error(`INVALID_HANKO_${label}:${authority.toString()}`);
  return authority;
};

const requireDepositoryDomain = (
  domain: DepositoryHankoDomain,
): readonly [chainId: bigint, depositoryAddress: string] => {
  const chainId = requireUint(domain.chainId, 'DOMAIN_CHAIN_ID');
  if (chainId === 0n) throw new Error('INVALID_HANKO_DOMAIN_CHAIN_ID:0');
  return [chainId, requireAddress(domain.depositoryAddress, 'DEPOSITORY_ADDRESS')] as const;
};

const requireEntityProviderDomain = (
  domain: EntityProviderHankoDomain,
): readonly [chainId: bigint, entityProviderAddress: string, boardEpoch: bigint] => {
  const chainId = requireUint(domain.chainId, 'DOMAIN_CHAIN_ID');
  if (chainId === 0n) throw new Error('INVALID_HANKO_DOMAIN_CHAIN_ID:0');
  return [
    chainId,
    requireAddress(domain.entityProviderAddress, 'ENTITY_PROVIDER_ADDRESS'),
    requireUint(domain.boardEpoch, 'BOARD_EPOCH'),
  ] as const;
};

export const encodeCooperativeUpdateHankoPayload = (
  domain: DepositoryHankoDomain,
  accountKey: string,
  nonce: number | bigint,
  diffs: readonly CooperativeUpdateDiff[],
  forgiveDebtsInTokenIds: readonly (number | bigint)[],
): string => {
  const [chainId, depositoryAddress] = requireDepositoryDomain(domain);
  return ABI_CODER.encode(
    ['uint256', 'uint256', 'address', 'bytes', 'uint256', 'tuple(uint256,int256,int256,int256,int256)[]', 'uint256[]'],
    [
      0,
      chainId,
      depositoryAddress,
      accountKey,
      requireUint(nonce, 'NONCE'),
      diffs.map((diff) => [diff.tokenId, diff.leftDiff, diff.rightDiff, diff.collateralDiff, diff.ondeltaDiff]),
      forgiveDebtsInTokenIds,
    ],
  );
};

export const encodeDisputeProofHankoPayload = (
  domain: DepositoryHankoDomain,
  accountKey: string,
  nonce: number | bigint,
  proposerIsLeft: boolean,
  proofbodyHash: string,
  watchSeed: string,
): string => {
  const [chainId, depositoryAddress] = requireDepositoryDomain(domain);
  return encodeParams(
    ['uint256', 'uint256', 'address', 'bytes', 'uint256', 'bool', 'bytes32', 'bytes32'],
    [1, chainId, depositoryAddress, accountKey, requireUint(nonce, 'NONCE'), proposerIsLeft, proofbodyHash, watchSeed],
  );
};

export const encodeFinalDisputeProofHankoPayload = (
  domain: DepositoryHankoDomain,
  accountKey: string,
  finalNonce: number | bigint,
): string => {
  const [chainId, depositoryAddress] = requireDepositoryDomain(domain);
  return encodeParams(
    ['uint256', 'uint256', 'address', 'bytes', 'uint256'],
    [2, chainId, depositoryAddress, accountKey, requireUint(finalNonce, 'FINAL_NONCE')],
  );
};

export const encodeCooperativeDisputeProofHankoPayload = (
  domain: DepositoryHankoDomain,
  accountKey: string,
  nonce: number | bigint,
  proofbodyHash: string,
  starterInitialArgumentsHash: string,
): string => {
  const [chainId, depositoryAddress] = requireDepositoryDomain(domain);
  return encodeParams(
    ['uint256', 'uint256', 'address', 'bytes', 'uint256', 'bytes32', 'bytes32'],
    [
      3,
      chainId,
      depositoryAddress,
      accountKey,
      requireUint(nonce, 'NONCE'),
      proofbodyHash,
      starterInitialArgumentsHash,
    ],
  );
};

export const encodeDepositoryBatchHankoPayload = (
  domain: DepositoryHankoDomain,
  encodedBatch: string,
  nonce: number | bigint,
): string => {
  const [chainId, depositoryAddress] = requireDepositoryDomain(domain);
  return ethers.solidityPacked(
    ['bytes32', 'uint256', 'address', 'bytes', 'uint256'],
    [DEPOSITORY_BATCH_HANKO_DOMAIN, chainId, depositoryAddress, encodedBatch, requireUint(nonce, 'NONCE')],
  );
};

export const encodeWatchtowerCounterDisputeHankoPayload = (
  domain: DepositoryHankoDomain,
  authorization: WatchtowerCounterDisputeAuthorization,
): string => {
  const [chainId, depositoryAddress] = requireDepositoryDomain(domain);
  return encodeParams(
    ['bytes32', 'uint256', 'address', 'address', 'bytes32', 'bytes32', 'uint256', 'bytes32', 'uint256', 'uint256'],
    [
      WATCHTOWER_COUNTER_DISPUTE_HANKO_DOMAIN,
      chainId,
      depositoryAddress,
      requireAddress(authorization.towerAddress, 'TOWER_ADDRESS'),
      authorization.entityId,
      authorization.counterentity,
      requireUint(authorization.finalNonce, 'FINAL_NONCE'),
      authorization.finalProofbodyHash,
      requireUint(authorization.lastResortWindowSeconds, 'LAST_RESORT_WINDOW'),
      requireUint(authorization.appointmentSequence, 'APPOINTMENT_SEQUENCE'),
    ],
  );
};

export const encodeEntityTransferHankoPayload = (
  domain: EntityProviderHankoDomain,
  authorization: EntityTransferAuthorization,
): string => {
  const [chainId, entityProviderAddress, boardEpoch] = requireEntityProviderDomain(domain);
  return ethers.solidityPacked(
    ['string', 'uint256', 'address', 'uint256', 'uint256', 'address', 'uint256', 'uint256', 'uint256'],
    [
      ENTITY_TRANSFER_HANKO_LABEL,
      chainId,
      entityProviderAddress,
      requireUint(authorization.entityNumber, 'ENTITY_NUMBER'),
      boardEpoch,
      requireAddress(authorization.to, 'TRANSFER_RECIPIENT'),
      requireUint(authorization.tokenId, 'TOKEN_ID'),
      requireUint(authorization.amount, 'AMOUNT'),
      requireUint(authorization.actionNonce, 'ACTION_NONCE'),
    ],
  );
};

export const encodeReleaseControlSharesHankoPayload = (
  domain: EntityProviderHankoDomain,
  authorization: ReleaseControlSharesAuthorization,
): string => {
  const [chainId, entityProviderAddress, boardEpoch] = requireEntityProviderDomain(domain);
  return ethers.solidityPacked(
    ['string', 'uint256', 'address', 'uint256', 'uint256', 'address', 'uint256', 'uint256', 'bytes32', 'uint256'],
    [
      RELEASE_CONTROL_SHARES_HANKO_LABEL,
      chainId,
      entityProviderAddress,
      requireUint(authorization.entityNumber, 'ENTITY_NUMBER'),
      boardEpoch,
      requireAddress(authorization.recipientAddress, 'RELEASE_RECIPIENT_ADDRESS'),
      requireUint(authorization.controlAmount, 'CONTROL_AMOUNT'),
      requireUint(authorization.dividendAmount, 'DIVIDEND_AMOUNT'),
      ethers.keccak256(ethers.toUtf8Bytes(authorization.purpose)),
      requireUint(authorization.actionNonce, 'ACTION_NONCE'),
    ],
  );
};

export const encodeCancelEntityProviderActionHankoPayload = (
  domain: EntityProviderHankoDomain,
  authorization: CancelEntityProviderActionAuthorization,
): string => {
  const [chainId, entityProviderAddress, boardEpoch] = requireEntityProviderDomain(domain);
  const cancelledActionKind = requireUint(
    authorization.cancelledActionKind,
    'CANCELLED_ACTION_KIND',
  );
  if (cancelledActionKind > MAX_ENTITY_PROVIDER_ACTION_KIND) {
    throw new Error(`INVALID_HANKO_CANCELLED_ACTION_KIND:${cancelledActionKind.toString()}`);
  }
  if (
    !/^0x[0-9a-fA-F]{64}$/.test(authorization.cancelledActionHash) ||
    authorization.cancelledActionHash.toLowerCase() === `0x${'00'.repeat(32)}`
  ) {
    throw new Error(`INVALID_HANKO_CANCELLED_ACTION_HASH:${authorization.cancelledActionHash}`);
  }
  return ethers.solidityPacked(
    ['string', 'uint256', 'address', 'uint256', 'uint256', 'uint256', 'bytes32', 'uint8'],
    [
      CANCEL_ENTITY_PROVIDER_ACTION_HANKO_LABEL,
      chainId,
      entityProviderAddress,
      requireUint(authorization.entityNumber, 'ENTITY_NUMBER'),
      boardEpoch,
      requireUint(authorization.actionNonce, 'ACTION_NONCE'),
      authorization.cancelledActionHash,
      cancelledActionKind,
    ],
  );
};

/**
 * EntityProvider.setWatchtowerMinSequence: hash =
 * keccak256(abi.encodePacked("WATCHTOWER_MIN_SEQUENCE", chainId, ep, entityNumber,
 * boardEpoch, newMinimum, actionNonce)). Raising the minimum revokes every
 * older tower appointment (Depository rejects appointmentSequence < min, E2).
 */
export const encodeWatchtowerMinSequenceHankoPayload = (
  domain: EntityProviderHankoDomain,
  authorization: WatchtowerMinSequenceAuthorization,
): string => {
  const [chainId, entityProviderAddress, boardEpoch] = requireEntityProviderDomain(domain);
  const newMinimum = requireUint(authorization.newMinimum, 'WATCHTOWER_MIN_SEQUENCE');
  if (newMinimum === 0n) throw new Error('INVALID_HANKO_WATCHTOWER_MIN_SEQUENCE:0');
  return ethers.solidityPacked(
    ['string', 'uint256', 'address', 'uint256', 'uint256', 'uint256', 'uint256'],
    [
      WATCHTOWER_MIN_SEQUENCE_HANKO_LABEL,
      chainId,
      entityProviderAddress,
      requireUint(authorization.entityNumber, 'ENTITY_NUMBER'),
      boardEpoch,
      newMinimum,
      requireUint(authorization.actionNonce, 'ACTION_NONCE'),
    ],
  );
};

export const encodeBoardProposalHankoPayload = (
  domain: EntityProviderHankoDomain,
  authorization: BoardProposalAuthorization,
): string => {
  const [chainId, entityProviderAddress, boardEpoch] = requireEntityProviderDomain(domain);
  return encodeParams(
    ['bytes32', 'uint256', 'address', 'bytes32', 'uint256', 'bytes32', 'uint8', 'uint256'],
    [
      BOARD_PROPOSAL_HANKO_DOMAIN,
      chainId,
      entityProviderAddress,
      authorization.entityId,
      boardEpoch,
      authorization.newBoardHash,
      requireBoardAuthority(authorization.authority, 'BOARD_AUTHORITY'),
      requireUint(authorization.actionNonce, 'ACTION_NONCE'),
    ],
  );
};

export const encodeBoardProposalCancelHankoPayload = (
  domain: EntityProviderHankoDomain,
  authorization: BoardProposalCancelAuthorization,
): string => {
  const [chainId, entityProviderAddress, boardEpoch] = requireEntityProviderDomain(domain);
  return encodeParams(
    ['bytes32', 'uint256', 'address', 'bytes32', 'uint256', 'bytes32', 'uint8', 'uint8', 'uint256'],
    [
      BOARD_PROPOSAL_CANCEL_HANKO_DOMAIN,
      chainId,
      entityProviderAddress,
      authorization.entityId,
      boardEpoch,
      authorization.proposedBoardHash,
      requireBoardAuthority(authorization.proposedBy, 'PROPOSED_BY'),
      requireBoardAuthority(authorization.cancelledBy, 'CANCELLED_BY'),
      requireUint(authorization.actionNonce, 'ACTION_NONCE'),
    ],
  );
};

export const hashCooperativeUpdateHankoPayload = (
  ...args: Parameters<typeof encodeCooperativeUpdateHankoPayload>
): string => keccakHexHash(encodeCooperativeUpdateHankoPayload(...args));

export const hashDisputeProofHankoPayload = (
  ...args: Parameters<typeof encodeDisputeProofHankoPayload>
): string => keccakHexHash(encodeDisputeProofHankoPayload(...args));

export const hashFinalDisputeProofHankoPayload = (
  ...args: Parameters<typeof encodeFinalDisputeProofHankoPayload>
): string => keccakHexHash(encodeFinalDisputeProofHankoPayload(...args));

export const hashCooperativeDisputeProofHankoPayload = (
  ...args: Parameters<typeof encodeCooperativeDisputeProofHankoPayload>
): string => keccakHexHash(encodeCooperativeDisputeProofHankoPayload(...args));

export const hashDepositoryBatchHankoPayload = (
  ...args: Parameters<typeof encodeDepositoryBatchHankoPayload>
): string => keccakHexHash(encodeDepositoryBatchHankoPayload(...args));

export const hashWatchtowerCounterDisputeHankoPayload = (
  ...args: Parameters<typeof encodeWatchtowerCounterDisputeHankoPayload>
): string => keccakHexHash(encodeWatchtowerCounterDisputeHankoPayload(...args));

export const hashEntityTransferHankoPayload = (
  ...args: Parameters<typeof encodeEntityTransferHankoPayload>
): string => keccakHexHash(encodeEntityTransferHankoPayload(...args));

export const hashReleaseControlSharesHankoPayload = (
  ...args: Parameters<typeof encodeReleaseControlSharesHankoPayload>
): string => keccakHexHash(encodeReleaseControlSharesHankoPayload(...args));

export const hashCancelEntityProviderActionHankoPayload = (
  ...args: Parameters<typeof encodeCancelEntityProviderActionHankoPayload>
): string => keccakHexHash(encodeCancelEntityProviderActionHankoPayload(...args));

export const hashWatchtowerMinSequenceHankoPayload = (
  ...args: Parameters<typeof encodeWatchtowerMinSequenceHankoPayload>
): string => keccakHexHash(encodeWatchtowerMinSequenceHankoPayload(...args));

export const hashBoardProposalHankoPayload = (
  ...args: Parameters<typeof encodeBoardProposalHankoPayload>
): string => keccakHexHash(encodeBoardProposalHankoPayload(...args));

export const hashBoardProposalCancelHankoPayload = (
  ...args: Parameters<typeof encodeBoardProposalCancelHankoPayload>
): string => keccakHexHash(encodeBoardProposalCancelHankoPayload(...args));

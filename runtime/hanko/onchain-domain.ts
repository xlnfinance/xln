import { ethers } from 'ethers';

export type DepositoryHankoDomain = Readonly<{
  chainId: number | bigint;
  depositoryAddress: string;
}>;

export type EntityProviderHankoDomain = Readonly<{
  chainId: number | bigint;
  entityProviderAddress: string;
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
  lastResortWindowBlocks: number | bigint;
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
  depositoryAddress: string;
  controlAmount: number | bigint;
  dividendAmount: number | bigint;
  purpose: string;
  actionNonce: number | bigint;
}>;

export const DEPOSITORY_BATCH_HANKO_DOMAIN = ethers.keccak256(
  ethers.toUtf8Bytes('XLN_DEPOSITORY_HANKO_V1'),
);
export const WATCHTOWER_COUNTER_DISPUTE_HANKO_DOMAIN = ethers.keccak256(
  ethers.toUtf8Bytes('XLN_WATCHTOWER_COUNTER_DISPUTE_V1'),
);
export const ENTITY_TRANSFER_HANKO_LABEL = 'ENTITY_TRANSFER';
export const RELEASE_CONTROL_SHARES_HANKO_LABEL = 'RELEASE_CONTROL_SHARES';

const ABI_CODER = ethers.AbiCoder.defaultAbiCoder();
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

const requireDepositoryDomain = (
  domain: DepositoryHankoDomain,
): readonly [chainId: bigint, depositoryAddress: string] => {
  const chainId = requireUint(domain.chainId, 'DOMAIN_CHAIN_ID');
  if (chainId === 0n) throw new Error('INVALID_HANKO_DOMAIN_CHAIN_ID:0');
  return [chainId, requireAddress(domain.depositoryAddress, 'DEPOSITORY_ADDRESS')] as const;
};

const requireEntityProviderDomain = (
  domain: EntityProviderHankoDomain,
): readonly [chainId: bigint, entityProviderAddress: string] => {
  const chainId = requireUint(domain.chainId, 'DOMAIN_CHAIN_ID');
  if (chainId === 0n) throw new Error('INVALID_HANKO_DOMAIN_CHAIN_ID:0');
  return [chainId, requireAddress(domain.entityProviderAddress, 'ENTITY_PROVIDER_ADDRESS')] as const;
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
  proofbodyHash: string,
  watchSeed: string,
): string => {
  const [chainId, depositoryAddress] = requireDepositoryDomain(domain);
  return ABI_CODER.encode(
    ['uint256', 'uint256', 'address', 'bytes', 'uint256', 'bytes32', 'bytes32'],
    [1, chainId, depositoryAddress, accountKey, requireUint(nonce, 'NONCE'), proofbodyHash, watchSeed],
  );
};

export const encodeFinalDisputeProofHankoPayload = (
  domain: DepositoryHankoDomain,
  accountKey: string,
  finalNonce: number | bigint,
): string => {
  const [chainId, depositoryAddress] = requireDepositoryDomain(domain);
  return ABI_CODER.encode(
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
  return ABI_CODER.encode(
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
  return ABI_CODER.encode(
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
      requireUint(authorization.lastResortWindowBlocks, 'LAST_RESORT_WINDOW'),
      requireUint(authorization.appointmentSequence, 'APPOINTMENT_SEQUENCE'),
    ],
  );
};

export const encodeEntityTransferHankoPayload = (
  domain: EntityProviderHankoDomain,
  authorization: EntityTransferAuthorization,
): string => {
  const [chainId, entityProviderAddress] = requireEntityProviderDomain(domain);
  return ethers.solidityPacked(
    ['string', 'uint256', 'address', 'uint256', 'address', 'uint256', 'uint256', 'uint256'],
    [
      ENTITY_TRANSFER_HANKO_LABEL,
      chainId,
      entityProviderAddress,
      requireUint(authorization.entityNumber, 'ENTITY_NUMBER'),
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
  const [chainId, entityProviderAddress] = requireEntityProviderDomain(domain);
  return ethers.solidityPacked(
    ['string', 'uint256', 'address', 'uint256', 'address', 'uint256', 'uint256', 'bytes32', 'uint256'],
    [
      RELEASE_CONTROL_SHARES_HANKO_LABEL,
      chainId,
      entityProviderAddress,
      requireUint(authorization.entityNumber, 'ENTITY_NUMBER'),
      requireAddress(authorization.depositoryAddress, 'RELEASE_DEPOSITORY_ADDRESS'),
      requireUint(authorization.controlAmount, 'CONTROL_AMOUNT'),
      requireUint(authorization.dividendAmount, 'DIVIDEND_AMOUNT'),
      ethers.keccak256(ethers.toUtf8Bytes(authorization.purpose)),
      requireUint(authorization.actionNonce, 'ACTION_NONCE'),
    ],
  );
};

export const hashCooperativeUpdateHankoPayload = (
  ...args: Parameters<typeof encodeCooperativeUpdateHankoPayload>
): string => ethers.keccak256(encodeCooperativeUpdateHankoPayload(...args));

export const hashDisputeProofHankoPayload = (
  ...args: Parameters<typeof encodeDisputeProofHankoPayload>
): string => ethers.keccak256(encodeDisputeProofHankoPayload(...args));

export const hashFinalDisputeProofHankoPayload = (
  ...args: Parameters<typeof encodeFinalDisputeProofHankoPayload>
): string => ethers.keccak256(encodeFinalDisputeProofHankoPayload(...args));

export const hashCooperativeDisputeProofHankoPayload = (
  ...args: Parameters<typeof encodeCooperativeDisputeProofHankoPayload>
): string => ethers.keccak256(encodeCooperativeDisputeProofHankoPayload(...args));

export const hashDepositoryBatchHankoPayload = (
  ...args: Parameters<typeof encodeDepositoryBatchHankoPayload>
): string => ethers.keccak256(encodeDepositoryBatchHankoPayload(...args));

export const hashWatchtowerCounterDisputeHankoPayload = (
  ...args: Parameters<typeof encodeWatchtowerCounterDisputeHankoPayload>
): string => ethers.keccak256(encodeWatchtowerCounterDisputeHankoPayload(...args));

export const hashEntityTransferHankoPayload = (
  ...args: Parameters<typeof encodeEntityTransferHankoPayload>
): string => ethers.keccak256(encodeEntityTransferHankoPayload(...args));

export const hashReleaseControlSharesHankoPayload = (
  ...args: Parameters<typeof encodeReleaseControlSharesHankoPayload>
): string => ethers.keccak256(encodeReleaseControlSharesHankoPayload(...args));

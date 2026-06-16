import hre from "hardhat";

const { ethers } = hre;

export const DEFAULT_HARDHAT_MNEMONIC = "test test test test test test test test test test test junk";

export const BATCH_ABI = [
  'tuple(' +
    'tuple(uint256 tokenId, uint256 amount)[] flashloans,' +
    'tuple(bytes32 receivingEntity, uint256 tokenId, uint256 amount)[] reserveToReserve,' +
    'tuple(uint256 tokenId, bytes32 receivingEntity, tuple(bytes32 entity, uint256 amount)[] pairs)[] reserveToCollateral,' +
    'tuple(bytes32 counterparty, uint256 tokenId, uint256 amount, uint256 nonce, bytes sig)[] collateralToReserve,' +
    'tuple(bytes32 leftEntity, bytes32 rightEntity, tuple(uint256 tokenId, int256 leftDiff, int256 rightDiff, int256 collateralDiff, int256 ondeltaDiff)[] diffs, uint256[] forgiveDebtsInTokenIds, bytes sig, address entityProvider, bytes hankoData, uint256 nonce)[] settlements,' +
    'tuple(bytes32 counterentity, uint256 nonce, bytes32 proofbodyHash, bytes32 watchSeed, bytes sig, bytes starterInitialArguments, bytes starterIncrementedArguments)[] disputeStarts,' +
    'tuple(bytes32 counterentity, uint256 initialNonce, uint256 finalNonce, bytes32 initialProofbodyHash, tuple(bytes32 watchSeed, int256[] offdeltas, uint256[] tokenIds, tuple(address transformerAddress, bytes encodedBatch, tuple(uint256 deltaIndex, uint256 rightAllowance, uint256 leftAllowance)[] allowances)[] transformers) finalProofbody, bytes leftArguments, bytes rightArguments, bytes starterInitialArguments, bytes starterIncrementedArguments, bytes sig, bool startedByLeft, uint256 disputeUntilBlock, bool cooperative)[] disputeFinalizations,' +
    'tuple(bytes32 entity, address contractAddress, uint96 externalTokenId, uint8 tokenType, uint256 internalTokenId, uint256 amount)[] externalTokenToReserve,' +
    'tuple(bytes32 receivingEntity, uint256 tokenId, uint256 amount)[] reserveToExternalToken,' +
    'tuple(address transformer, bytes32 secret)[] revealSecrets,' +
    'uint256 hub_id' +
  ')'
];

const HANKO_ABI = ['tuple(bytes32[],bytes,tuple(bytes32,uint256[],uint256[],uint256)[])'];
const BOARD_ABI = [
  'tuple(uint16 votingThreshold, bytes32[] entityIds, uint16[] votingPowers, uint32 boardChangeDelay, uint32 controlChangeDelay, uint32 dividendChangeDelay)'
];

export const BATCH_DOMAIN_SEPARATOR = ethers.keccak256(ethers.toUtf8Bytes("XLN_DEPOSITORY_HANKO_V1"));

export const addressEntityId = (address: string): string => ethers.zeroPadValue(address, 32);

export const singleSignerLazyEntityId = (address: string): string => {
  const signerEntityId = addressEntityId(address);
  const encodedBoard = ethers.AbiCoder.defaultAbiCoder().encode(BOARD_ABI, [[
    1,
    [signerEntityId],
    [1],
    0,
    0,
    0,
  ]]);
  return ethers.keccak256(encodedBoard);
};

export const deriveHardhatPrivateKey = (index: number): string =>
  ethers.HDNodeWallet.fromPhrase(DEFAULT_HARDHAT_MNEMONIC, undefined, `m/44'/60'/0'/0/${index}`).privateKey;

export const encodeBatch = (batch: unknown): string =>
  ethers.AbiCoder.defaultAbiCoder().encode(BATCH_ABI, [batch]);

export const emptyBatch = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  flashloans: [],
  reserveToReserve: [],
  reserveToCollateral: [],
  collateralToReserve: [],
  settlements: [],
  disputeStarts: [],
  disputeFinalizations: [],
  externalTokenToReserve: [],
  reserveToExternalToken: [],
  revealSecrets: [],
  hub_id: 0,
  ...overrides,
});

export const computeDepositoryBatchHash = async (
  depository: { getAddress(): Promise<string> },
  encodedBatch: string,
  nonce: bigint,
): Promise<string> => {
  const chainId = BigInt((await hre.ethers.provider.getNetwork()).chainId);
  return ethers.keccak256(ethers.solidityPacked(
    ['bytes32', 'uint256', 'address', 'bytes', 'uint256'],
    [BATCH_DOMAIN_SEPARATOR, chainId, await depository.getAddress(), encodedBatch, nonce]
  ));
};

export const buildSingleSignerHanko = (entityId: string, hash: string, privateKey: string): string => {
  const signingKey = new ethers.SigningKey(privateKey);
  const signature = signingKey.sign(ethers.getBytes(hash));
  const vBit = signature.v === 28 ? 1 : 0;
  const packedSig = ethers.concat([signature.r, signature.s, ethers.toBeHex(vBit, 1)]);
  return ethers.AbiCoder.defaultAbiCoder().encode(HANKO_ABI, [[
    [],
    packedSig,
    [[ethers.zeroPadValue(entityId, 32), [0], [1], 1]],
  ]]);
};

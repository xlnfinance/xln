import hre from "hardhat";

const { ethers } = await hre.network.getOrCreate("hardhat");

export const DEFAULT_HARDHAT_MNEMONIC = "test test test test test test test test test test test junk";

export const BATCH_ABI = [
  'tuple(' +
    'tuple(bytes32 receivingEntity, uint256 tokenId, uint256 amount)[] reserveToReserve,' +
    'tuple(uint256 tokenId, bytes32 receivingEntity, tuple(bytes32 entity, uint256 amount)[] pairs)[] reserveToCollateral,' +
    'tuple(bytes32 counterparty, uint256 tokenId, uint256 amount, uint256 nonce, bytes sig)[] collateralToReserve,' +
    'tuple(bytes32 leftEntity, bytes32 rightEntity, tuple(uint256 tokenId, int256 leftDiff, int256 rightDiff, int256 collateralDiff, int256 ondeltaDiff)[] diffs, uint256[] forgiveDebtsInTokenIds, bytes sig, uint256 nonce)[] settlements,' +
    'tuple(bytes32 counterentity, uint256 nonce, bool proposerIsLeft, bytes32 proofbodyHash, tuple(bytes32 watchSeed, uint32 leftResponseSeconds, uint32 rightResponseSeconds, int256[] offdeltas, uint256[] tokenIds, tuple(address transformerAddress, bytes encodedBatch, tuple(uint256 deltaIndex, uint256 rightAllowance, uint256 leftAllowance)[] allowances)[] transformers) initialProofbody, bytes32 watchSeed, bytes sig, bytes starterInitialArguments, bytes starterCounterArguments, bytes32 starterCounterProofCommitment)[] disputeStarts,' +
    'tuple(bytes32 counterentity, uint256 initialNonce, bytes32 initialProofbodyHash, uint256 counterNonce, bool proposerIsLeft, tuple(bytes32 watchSeed, uint32 leftResponseSeconds, uint32 rightResponseSeconds, int256[] offdeltas, uint256[] tokenIds, tuple(address transformerAddress, bytes encodedBatch, tuple(uint256 deltaIndex, uint256 rightAllowance, uint256 leftAllowance)[] allowances)[] transformers) counterProofbody, bytes sig)[] counterDisputes,' +
    'tuple(bytes32 counterentity, uint256 initialNonce, uint256 finalNonce, bool proposerIsLeft, bytes32 initialProofbodyHash, tuple(bytes32 watchSeed, uint32 leftResponseSeconds, uint32 rightResponseSeconds, int256[] offdeltas, uint256[] tokenIds, tuple(address transformerAddress, bytes encodedBatch, tuple(uint256 deltaIndex, uint256 rightAllowance, uint256 leftAllowance)[] allowances)[] transformers) finalProofbody, bytes starterArguments, bytes otherArguments, bytes sig, bool startedByLeft, bool cooperative)[] disputeFinalizations,' +
    'tuple(bytes32 entity, address contractAddress, uint256 externalTokenId, uint8 tokenType, uint256 internalTokenId, uint256 amount)[] externalTokenToReserve,' +
    'tuple(bytes32 receivingEntity, uint256 tokenId, uint256 amount)[] reserveToExternalToken,' +
    'tuple(address transformer, bytes32 secret)[] revealSecrets,' +
    'tuple(bytes32 counterpartyEntity, bool targetRole, bytes32 fullHash, bytes32 partialRoot, tuple(uint16 fillRatio, bytes32 fullSecret, bytes32[4] reveals) witness)[] hashLadderRegistrations' +
  ')'
];

/** abi.encode(HankoBytes): placeholders, packedSignatures, claims, memberSignatures. One envelope only. */
export const HANKO_ABI = [
  'tuple(bytes32[],bytes,tuple(bytes32,uint256[],uint256[],uint256,uint32,uint32,uint32)[],bytes[])',
];
const BOARD_ABI = [
  'tuple(uint16 votingThreshold, bytes32[] entityIds, uint16[] votingPowers, uint32 boardChangeDelay, uint32 controlChangeDelay, uint32 dividendChangeDelay)'
];

const BATCH_DOMAIN_SEPARATOR = ethers.keccak256(ethers.toUtf8Bytes("XLN_DEPOSITORY_HANKO_V1"));

export const addressEntityId = (address: string): string => ethers.zeroPadValue(address, 32);

export const canonicalAccountKey = (left: string, right: string): string => {
  const [first, second] = BigInt(left) < BigInt(right) ? [left, right] : [right, left];
  return ethers.solidityPacked(['bytes32', 'bytes32'], [first, second]);
};

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

export const deployEntityProvider = async (foundationRecipient: string) => {
  const HankoVerifier = await ethers.getContractFactory('HankoVerifier');
  const hankoVerifier = await HankoVerifier.deploy();
  await hankoVerifier.waitForDeployment();
  const EntityProvider = await ethers.getContractFactory('EntityProvider', {
    libraries: { HankoVerifier: await hankoVerifier.getAddress() },
  });
  const entityProvider = await EntityProvider.deploy(foundationRecipient);
  await entityProvider.waitForDeployment();
  return entityProvider;
};

/**
 * Deploy the one production Depository graph used by every test.
 *
 * Keeping this graph in one helper is security-relevant: a test that links
 * only Account, supplies the retired global delay constructor argument, or
 * points Depository at a non-canonical DeltaTransformer is not exercising the
 * contract that can be deployed to mainnet. The transformer address remains
 * an immutable settlement-logic boundary even though registry writes are
 * independent public evidence.
 */
export const deployDepositoryStack = async (
  entityProviderAddress: string,
  options: { bindShareDepository?: boolean } = {},
) => {
  const AccountFactory = await ethers.getContractFactory('Account');
  const account = await AccountFactory.deploy();
  await account.waitForDeployment();

  const DepositoryBoundsFactory = await ethers.getContractFactory('DepositoryBounds');
  const depositoryBounds = await DepositoryBoundsFactory.deploy();
  await depositoryBounds.waitForDeployment();

  const HashLadderRegistryFactory = await ethers.getContractFactory('HashLadderRegistry');
  const hashLadderRegistry = await HashLadderRegistryFactory.deploy();
  await hashLadderRegistry.waitForDeployment();

  const NftCustodyFactory = await ethers.getContractFactory('NftCustody');
  const nftCustody = await NftCustodyFactory.deploy();
  await nftCustody.waitForDeployment();

  const DeltaTransformerFactory = await ethers.getContractFactory('DeltaTransformer');
  const deltaTransformer = await DeltaTransformerFactory.deploy();
  await deltaTransformer.waitForDeployment();

  const DepositoryFactory = await ethers.getContractFactory('Depository', {
    libraries: {
      Account: await account.getAddress(),
      DepositoryBounds: await depositoryBounds.getAddress(),
      HashLadderRegistry: await hashLadderRegistry.getAddress(),
      NftCustody: await nftCustody.getAddress(),
    },
  });
  const depository = await DepositoryFactory.deploy(
    entityProviderAddress,
    await deltaTransformer.getAddress(),
  );
  await depository.waitForDeployment();
  if (options.bindShareDepository !== false) {
    const entityProvider = await ethers.getContractAt('EntityProvider', entityProviderAddress);
    await (await entityProvider.bindShareDepository(await depository.getAddress())).wait();
  }

  return { account, depositoryBounds, hashLadderRegistry, nftCustody, deltaTransformer, depository };
};

export const encodeBatch = (batch: unknown): string =>
  ethers.AbiCoder.defaultAbiCoder().encode(BATCH_ABI, [batch]);

export const emptyBatch = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  reserveToReserve: [],
  reserveToCollateral: [],
  collateralToReserve: [],
  settlements: [],
  disputeStarts: [],
  counterDisputes: [],
  disputeFinalizations: [],
  externalTokenToReserve: [],
  reserveToExternalToken: [],
  revealSecrets: [],
  hashLadderRegistrations: [],
  ...overrides,
});

export const computeDepositoryBatchHash = async (
  depository: { getAddress(): Promise<string> },
  encodedBatch: string,
  nonce: bigint,
): Promise<string> => {
  const chainId = BigInt((await ethers.provider.getNetwork()).chainId);
  return ethers.keccak256(ethers.solidityPacked(
    ['bytes32', 'uint256', 'address', 'bytes', 'uint256'],
    [BATCH_DOMAIN_SEPARATOR, chainId, await depository.getAddress(), encodedBatch, nonce]
  ));
};

export const buildSingleSignerHanko = (entityId: string, hash: string, privateKey: string): string => {
  return buildClaimsHanko(hash, [privateKey], [], [[
    ethers.zeroPadValue(entityId, 32),
    [0],
    [1],
    1,
  ]]);
};

/**
 * 65-byte r||s||v signature: HankoVerifier's shortcut for the signer's own lazy
 * 1-of-1 entity (id = singleSignerLazyEntityId(signer)). Same verdict as the
 * full envelope for that board at a fraction of the calldata.
 */
export const buildRawSignerHanko = (hash: string, privateKey: string): string =>
  new ethers.SigningKey(privateKey).sign(ethers.getBytes(hash)).serialized;

export const buildFoundationAction = async (
  provider: {
    entityActionNonces(entityId: string): Promise<bigint>;
    computeFoundationActionHash(actionType: string, argumentsHash: string, actionNonce: bigint): Promise<string>;
  },
  actionType: string,
  argumentsHash: string,
  privateKey = deriveHardhatPrivateKey(0),
): Promise<{ hankoData: string; actionNonce: bigint }> => {
  const foundationId = ethers.zeroPadValue(ethers.toBeHex(1), 32);
  const actionNonce = await provider.entityActionNonces(foundationId) + 1n;
  const actionHash = await provider.computeFoundationActionHash(actionType, argumentsHash, actionNonce);
  return {
    hankoData: buildSingleSignerHanko(foundationId, actionHash, privateKey),
    actionNonce,
  };
};

export const buildClaimsHanko = (
  hash: string,
  privateKeys: string[],
  placeholders: string[],
  claims: Array<[
    entityId: string,
    entityIndexes: Array<number | bigint>,
    weights: Array<number | bigint>,
    threshold: number | bigint,
    delays?: readonly [number | bigint, number | bigint, number | bigint],
  ]>,
  memberSignatures: string[] = [],
): string => {
  const signatures = privateKeys.map((privateKey) =>
    new ethers.SigningKey(privateKey).sign(ethers.getBytes(hash))
  );
  const recoveryBits = new Uint8Array(Math.ceil(signatures.length / 8));
  signatures.forEach((signature, index) => {
    if (signature.v === 28) recoveryBits[Math.floor(index / 8)]! |= 1 << (index % 8);
  });
  const packedSignatures = ethers.concat([
    ...signatures.flatMap((signature) => [signature.r, signature.s]),
    ethers.hexlify(recoveryBits),
  ]);
  return ethers.AbiCoder.defaultAbiCoder().encode(HANKO_ABI, [[
    placeholders.map((entityId) => ethers.zeroPadValue(entityId, 32)),
    packedSignatures,
    claims.map(([entityId, entityIndexes, weights, threshold, delays = [0, 0, 0]]) => [
      ethers.zeroPadValue(entityId, 32),
      entityIndexes,
      weights,
      threshold,
      ...delays,
    ]),
    memberSignatures,
  ]]);
};

// ── boards & listing (post "deploy once" redesign) ──

/** abi.encode(Board) for a 1-of-1 EOA board; registration takes the preimage now. */
export const encodeSingleSignerBoard = (address: string): string =>
  ethers.AbiCoder.defaultAbiCoder().encode(BOARD_ABI, [[1, [addressEntityId(address)], [1], 0, 0, 0]]);

export const encodeBoard = (
  threshold: number,
  entityIds: string[],
  votingPowers: number[],
  delays: readonly [number, number, number] = [0, 0, 0],
): string =>
  ethers.AbiCoder.defaultAbiCoder().encode(BOARD_ABI, [[
    threshold,
    entityIds.map((id) => ethers.zeroPadValue(id, 32)),
    votingPowers,
    ...delays,
  ]]);

export const boardHashOf = (encodedBoard: string): string => ethers.keccak256(encodedBoard);

export const FOUNDATION_ENTITY_ID = ethers.zeroPadValue(ethers.toBeHex(1), 32);

/**
 * List an external token through the Foundation lane. Depository.registerExternalToken
 * is callable only by the EntityProvider; the deployer key has no listing power.
 */
export const foundationListExternalToken = async (
  provider: {
    getAddress(): Promise<string>;
    entityActionNonces(entityId: string): Promise<bigint>;
    computeFoundationActionHash(actionType: string, argumentsHash: string, actionNonce: bigint): Promise<string>;
    FOUNDATION_REGISTER_TOKEN(): Promise<string>;
    foundationRegisterExternalToken(
      depository: string, tokenType: number, contractAddress: string, externalTokenId: bigint | number,
      hankoData: string, actionNonce: bigint,
    ): Promise<{ wait(): Promise<unknown> }>;
  },
  depositoryAddress: string,
  tokenType: number,
  contractAddress: string,
  externalTokenId: bigint | number = 0,
  privateKey = deriveHardhatPrivateKey(0),
): Promise<void> => {
  const argumentsHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'uint8', 'address', 'uint256'],
    [depositoryAddress, tokenType, contractAddress, externalTokenId],
  ));
  const authorization = await buildFoundationAction(
    provider,
    await provider.FOUNDATION_REGISTER_TOKEN(),
    argumentsHash,
    privateKey,
  );
  await (await provider.foundationRegisterExternalToken(
    depositoryAddress, tokenType, contractAddress, externalTokenId, authorization.hankoData, authorization.actionNonce,
  )).wait();
};

/** Register a numbered 1-of-1 entity and return its number. */
export const registerSingleSignerEntity = async (
  provider: {
    registerNumberedEntity(encodedBoard: string): Promise<{ wait(): Promise<unknown> }>;
    nextNumber(): Promise<bigint>;
  },
  address: string,
): Promise<bigint> => {
  await (await provider.registerNumberedEntity(encodeSingleSignerBoard(address))).wait();
  return (await provider.nextNumber()) - 1n;
};

// ── entity treasuries ──

export const ENTITY_TREASURY_DOMAIN = ethers.keccak256(ethers.toUtf8Bytes('XLN_ENTITY_TREASURY_V1'));

/** Mirror of EntityTypes.entityTreasury(N): the ERC1155 holder of entity N's shares. */
export const entityTreasuryAddress = (entityNumber: bigint | number): string =>
  ethers.getAddress(ethers.dataSlice(ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(['bytes32', 'uint256'], [ENTITY_TREASURY_DOMAIN, entityNumber]),
  ), 12));

/** Move shares out of entity N's treasury with a 1-of-1 board Hanko (default: Foundation, signer 0). */
export const entityTransferFromTreasury = async (
  provider: {
    entityActionNonces(entityId: string): Promise<bigint>;
    computeEntityTransferHankoHash(
      entityNumber: bigint | number, to: string, tokenId: bigint, amount: bigint, actionNonce: bigint,
    ): Promise<string>;
    entityTransferTokens(
      entityNumber: bigint | number, to: string, tokenId: bigint, amount: bigint, hankoData: string,
    ): Promise<{ wait(): Promise<unknown> }>;
  },
  to: string,
  tokenId: bigint,
  amount: bigint,
  entityNumber: bigint | number = 1n,
  privateKey = deriveHardhatPrivateKey(0),
): Promise<void> => {
  const entityId = ethers.zeroPadValue(ethers.toBeHex(entityNumber), 32);
  const actionNonce = await provider.entityActionNonces(entityId) + 1n;
  const hash = await provider.computeEntityTransferHankoHash(entityNumber, to, tokenId, amount, actionNonce);
  await (await provider.entityTransferTokens(
    entityNumber, to, tokenId, amount, buildSingleSignerHanko(entityId, hash, privateKey),
  )).wait();
};

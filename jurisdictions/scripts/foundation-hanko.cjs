/**
 * Foundation Hanko helpers for deployment scripts.
 *
 * After "deploy once", no deployer key holds listing power: external tokens are
 * listed through EntityProvider.foundationRegisterExternalToken under a Hanko
 * from the Foundation entity (id bytes32(1)). At genesis the Foundation board is
 * the 1-of-1 EOA passed to the EntityProvider constructor (foundationRecipient),
 * so a single raw secp256k1 signature over the action hash authorizes it.
 *
 * Reference: jurisdictions/test/helpers/hanko.ts buildClaimsHanko/buildFoundationAction
 * and EntityProvider.computeFoundationActionHash / _authorizeFoundation.
 */

const HANKO_ABI = [
  'tuple(' +
    'bytes32[] placeholders,' +
    'bytes packedSignatures,' +
    'tuple(bytes32 entityId, uint256[] entityIndexes, uint256[] weights, uint256 threshold,' +
      ' uint32 boardChangeDelay, uint32 controlChangeDelay, uint32 dividendChangeDelay)[] claims' +
  ')',
];

const foundationEntityId = (ethers) => ethers.zeroPadValue(ethers.toBeHex(1), 32);

const foundationActionDomain = (ethers) =>
  ethers.keccak256(ethers.toUtf8Bytes('XLN_ENTITY_PROVIDER_FOUNDATION_ACTION_V1'));

const foundationRegisterTokenAction = (ethers) =>
  ethers.keccak256(ethers.toUtf8Bytes('REGISTER_EXTERNAL_TOKEN'));

/** keccak256(abi.encodePacked(domain, chainId, entityProvider, actionType, argumentsHash, actionNonce)). */
const computeFoundationActionHash = (ethers, { chainId, entityProviderAddress, actionType, argumentsHash, actionNonce }) =>
  ethers.keccak256(ethers.solidityPacked(
    ['bytes32', 'uint256', 'address', 'bytes32', 'bytes32', 'uint256'],
    [foundationActionDomain(ethers), BigInt(chainId), entityProviderAddress, actionType, argumentsHash, BigInt(actionNonce)],
  ));

/** keccak256(abi.encode(depository, tokenType, contractAddress, externalTokenId)). */
const tokenListingArgumentsHash = (ethers, { depository, tokenType, contractAddress, externalTokenId }) =>
  ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'uint8', 'address', 'uint256'],
    [depository, tokenType, contractAddress, BigInt(externalTokenId)],
  ));

/**
 * 1-of-1 Foundation Hanko over a raw 32-byte digest (no EIP-191 prefix):
 * packedSignatures = r || s || recoveryBits (bit 0 set when v == 28),
 * placeholders = [], claims = [[bytes32(1), [0], [1], 1, 0, 0, 0]].
 */
const buildSingleSignerFoundationHanko = (ethers, actionHash, privateKey) => {
  const key = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  const signature = new ethers.SigningKey(key).sign(ethers.getBytes(actionHash));
  const recoveryBits = new Uint8Array(1);
  if (signature.v === 28) recoveryBits[0] |= 1;
  const packedSignatures = ethers.concat([signature.r, signature.s, ethers.hexlify(recoveryBits)]);
  return ethers.AbiCoder.defaultAbiCoder().encode(HANKO_ABI, [[
    [],
    packedSignatures,
    [[foundationEntityId(ethers), [0], [1], 1, 0, 0, 0]],
  ]]);
};

/**
 * Build the (hankoData, actionNonce) pair for
 * EntityProvider.foundationRegisterExternalToken(depository, tokenType, contractAddress, externalTokenId, hankoData, actionNonce).
 * `foundationNonce` is the current entityActionNonces(bytes32(1)); the action uses nonce + 1.
 */
const buildFoundationTokenListing = (ethers, {
  chainId,
  entityProviderAddress,
  foundationNonce,
  depository,
  tokenType,
  contractAddress,
  externalTokenId,
  privateKey,
}) => {
  const actionNonce = BigInt(foundationNonce) + 1n;
  const argumentsHash = tokenListingArgumentsHash(ethers, { depository, tokenType, contractAddress, externalTokenId });
  const actionHash = computeFoundationActionHash(ethers, {
    chainId,
    entityProviderAddress,
    actionType: foundationRegisterTokenAction(ethers),
    argumentsHash,
    actionNonce,
  });
  return {
    actionNonce,
    argumentsHash,
    actionHash,
    hankoData: buildSingleSignerFoundationHanko(ethers, actionHash, privateKey),
  };
};

module.exports = {
  HANKO_ABI,
  foundationEntityId,
  foundationActionDomain,
  foundationRegisterTokenAction,
  computeFoundationActionHash,
  tokenListingArgumentsHash,
  buildSingleSignerFoundationHanko,
  buildFoundationTokenListing,
};

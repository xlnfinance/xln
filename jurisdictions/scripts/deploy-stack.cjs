/** Canonical staged Ignition executor, shared by Stack Manager and chain tooling. */
const { buildFoundationTokenListing, foundationEntityId } = require('./foundation-hanko.cjs');
const { stackModule, listingModule } = require('./deployment/modules.cjs');
const { readToken, publishManifest } = require('./deployment/preflight.cjs');
const { createModuleDeployer } = require('./deployment/engine.cjs');
const { deriveManifest, save } = require('./deployment/manifest.cjs');
const { readRecovery, recoverAddresses } = require('./deployment/recovery.cjs');
const { deploymentModuleIds } = require('./deployment/namespace.cjs');

const prepareListing = async (ethers, attempt, addresses, token, predecessorNonce) => {
  // The signer owns the genesis Foundation. Nonce one binds actual deployed
  // addresses, chain and asset. An incremented nonce must never sign a second first listing.
  const listing = buildFoundationTokenListing(ethers, {
    chainId: attempt.chainId, entityProviderAddress: addresses.entityProvider,
    foundationNonce: predecessorNonce, depository: addresses.depository,
    tokenType: 0, contractAddress: token, externalTokenId: 0, privateKey: attempt.privateKey,
  });
  const ep = await ethers.getContractAt('EntityProvider', addresses.entityProvider);
  const actionHash = await ep.computeFoundationActionHash(await ep.FOUNDATION_REGISTER_TOKEN(), listing.argumentsHash, listing.actionNonce);
  if (actionHash !== listing.actionHash) throw new Error('FOUNDATION_ACTION_HASH_MISMATCH');
  return listing;
};

async function executeStack({ connection, artifacts, config, attempt }) {
    const { ethers } = connection;
    const deployModule = createModuleDeployer({ connection, artifacts, config, attempt });
    const Base = stackModule(attempt.deploymentId, attempt.foundationRecipient, attempt.fixtureToken);
    const prior = await readRecovery(attempt, artifacts, ethers);
    // Completed native graphs only verify/reconstruct; incomplete graphs still
    // need gas before Ignition is allowed to send their next operation.
    const lastListing = `${deploymentModuleIds(attempt.deploymentId).listing}#${attempt.wrapped ? 'registerWrappedNative' : 'registerStablecoin'}`;
    if (!prior?.successful.includes(lastListing) && await ethers.provider.getBalance(attempt.deployer) === 0n) {
      throw new Error('STACK_MANAGER_SIGNER_GAS_BALANCE_EMPTY');
    }
    let addresses = recoverAddresses(prior, attempt.fixtureToken, attempt.deploymentId);
    if (!addresses) {
      addresses = await deployModule(Base);
    }
    const stablecoin = attempt.stablecoin || await readToken(ethers, addresses.stablecoin, 6);
    const listing = await prepareListing(ethers, attempt, addresses, stablecoin.address, 0n);
    const wrapped = attempt.wrapped ? { ...attempt.wrapped,
      listing: await prepareListing(ethers, attempt, addresses, attempt.wrapped.address, 1n) } : null;
    save(`${attempt.output}.listing.json`, { ...listing, ...(wrapped ? { wrapped: wrapped.listing } : {}) });
    await deployModule(listingModule(attempt.deploymentId, Base, stablecoin.address, listing, wrapped));
    const ep = await ethers.getContractAt('EntityProvider', addresses.entityProvider);
    const depository = await ethers.getContractAt('Depository', addresses.depository);
    const expectedListings = wrapped ? 2n : 1n;
    if (await ep.entityActionNonces(foundationEntityId(ethers)) !== expectedListings) throw new Error('FOUNDATION_LISTING_NONCE_MISMATCH');
    if (await depository.getTokensLength() !== expectedListings + 1n) throw new Error('DEPLOYED_TOKEN_COUNT_MISMATCH');
    const registeredTokens = { [stablecoin.symbol]: { address: stablecoin.address, tokenId: 1, decimals: 6 },
      ...(wrapped ? { WETH: { address: wrapped.address, tokenId: 2, decimals: 18 } } : {}) };
    for (const token of Object.values(registeredTokens)) {
      const actual = await depository._tokens(token.tokenId);
      if (actual.contractAddress.toLowerCase() !== token.address.toLowerCase() || actual.tokenType !== 0n || actual.externalTokenId !== 0n) {
        throw new Error(`DEPLOYED_TOKEN_REGISTRY_MISMATCH:${token.tokenId}`);
      }
    }
    const manifest = await deriveManifest({ ...attempt, addresses, registeredTokens, artifacts, ethers, network: connection.networkName });
    publishManifest(attempt.output, manifest);
    return manifest;
}

module.exports = { executeStack };

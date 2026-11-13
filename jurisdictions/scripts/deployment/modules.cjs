/** One ordered graph for all supported EVM stack variants. */
const { buildModule } = require('@nomicfoundation/ignition-core');
const { deploymentModuleIds } = require('./namespace.cjs');

const stackModule = (deploymentId, foundation, fixtureToken) => buildModule(deploymentModuleIds(deploymentId).stack, m => {
  const account = m.library('Account', { id: 'account' });
  const hankoVerifier = m.library('HankoVerifier', { id: 'hankoVerifier', after: [account] });
  const entityProvider = m.contract('EntityProvider', [foundation], {
    id: 'entityProvider', libraries: { HankoVerifier: hankoVerifier }, after: [hankoVerifier],
  });
  const deltaTransformer = m.contract('DeltaTransformer', [], { id: 'deltaTransformer', after: [entityProvider] });
  const depositoryBounds = m.library('DepositoryBounds', { id: 'depositoryBounds', after: [deltaTransformer] });
  const hashLadderRegistry = m.library('HashLadderRegistry', { id: 'hashLadderRegistry', after: [depositoryBounds] });
  const nftCustody = m.library('NftCustody', { id: 'nftCustody', after: [hashLadderRegistry] });
  const depository = m.contract('Depository', [entityProvider, deltaTransformer], {
    id: 'depository', after: [nftCustody],
    libraries: { Account: account, DepositoryBounds: depositoryBounds, HashLadderRegistry: hashLadderRegistry, NftCustody: nftCustody },
  });
  const bindTransformer = m.call(deltaTransformer, 'bindDepository', [depository], { id: 'bindTransformer', after: [depository] });
  const bindShares = m.call(entityProvider, 'bindShareDepository', [depository], { id: 'bindShares', after: [bindTransformer] });
  const stablecoin = fixtureToken ? m.contract('ERC20Mock', ['Tether USD Test', 'USDT', 6, 1000000000000n], {
    id: 'stablecoin', after: [bindShares],
  }) : undefined;
  return { account, hankoVerifier, entityProvider, deltaTransformer, depositoryBounds,
    hashLadderRegistry, nftCustody, depository, ...(stablecoin ? { stablecoin } : {}) };
});

const listingModule = (deploymentId, Base, stablecoin, listing, wrapped) => buildModule(deploymentModuleIds(deploymentId).listing, m => {
  const base = m.useModule(Base);
  const registerStablecoin = m.call(base.entityProvider, 'foundationRegisterExternalToken', [
    base.depository, 0, stablecoin, 0, listing.hankoData, listing.actionNonce,
  ], { id: 'registerStablecoin', after: [Base] });
  if (wrapped) m.call(base.entityProvider, 'foundationRegisterExternalToken', [
    base.depository, 0, wrapped.address, 0, wrapped.listing.hankoData, wrapped.listing.actionNonce,
  ], { id: 'registerWrappedNative', after: [registerStablecoin] });
  return base;
});

module.exports = { stackModule, listingModule };

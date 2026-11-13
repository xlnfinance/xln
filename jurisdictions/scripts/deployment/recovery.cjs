/** Public native views construct the graph; only Ignition decides which Future sends. */
const { status, listTransactions } = require('@nomicfoundation/ignition-core');
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { deploymentModuleIds, assertNativeDeploymentIdentity } = require('./namespace.cjs');
const { readStackFoundationAuthority } = require('../../../core/jurisdiction/adapter/stack-manager/bindings.ts');

const validateFoundation = async (attempt, prior, ethers) => {
  const modules = deploymentModuleIds(attempt.deploymentId);
  const ep = prior.contracts[`${modules.stack}#entityProvider`];
  if (!ep) return;
  const authority = await readStackFoundationAuthority(ethers.provider, ep.address, attempt.foundationRecipient);
  const listingIds = [`${modules.listing}#registerStablecoin`, ...(attempt.wrapped ? [`${modules.listing}#registerWrappedNative`] : [])];
  const completed = listingIds.filter(id => prior.successful.includes(id)).length;
  const started = listingIds.filter(id => prior.started.includes(id) || prior.successful.includes(id)).length;
  // The sealed signer owns genesis, and journal-started listing one may already
  // have mined. A nonce advanced by unrelated authority is never a new listing.
  if (authority.nonce < BigInt(completed) || authority.nonce > BigInt(started)) {
    throw new Error('STACK_MANAGER_FOUNDATION_NONCE_CONFLICT');
  }
};

const readRecovery = async (attempt, artifacts, ethers) => {
  if (!existsSync(join(attempt.journalDirectory, 'journal.jsonl'))) {
    if (attempt.mode === 'resume') throw new Error('STACK_MANAGER_IGNITION_JOURNAL_MISSING');
    return undefined;
  }
  const prior = await status(attempt.journalDirectory);
  if (prior.chainId !== attempt.chainId) throw new Error('STACK_MANAGER_IGNITION_CHAIN_MISMATCH');
  assertNativeDeploymentIdentity(prior, attempt.deploymentId);
  await validateFoundation(attempt, prior, ethers);
  const transactions = await listTransactions(attempt.journalDirectory, { loadArtifact: name => artifacts.readArtifact(name) });
  for (const tx of transactions) {
    if (tx.from.toLowerCase() !== attempt.deployer.toLowerCase()) throw new Error('STACK_MANAGER_IGNITION_SIGNER_MISMATCH');
    if (tx.status !== 'SUCCESS') continue;
    const receipt = await ethers.provider.getTransactionReceipt(tx.txHash);
    const block = receipt && await ethers.provider.getBlock(receipt.blockNumber);
    if (!receipt || receipt.status !== 1 || !block || block.hash !== receipt.blockHash) {
      throw new Error(`STACK_MANAGER_IGNITION_RECEIPT_CONFLICT:${tx.txHash}`);
    }
  }
  return prior;
};

const recoverAddresses = (prior, fixtureToken, deploymentId) => {
  if (!prior) return undefined;
  const modules = deploymentModuleIds(deploymentId);
  const names = ['account', 'hankoVerifier', 'entityProvider', 'deltaTransformer', 'depositoryBounds',
    'hashLadderRegistry', 'nftCustody', 'depository', ...(fixtureToken ? ['stablecoin'] : [])];
  const addresses = Object.fromEntries(names.map(name => [name, prior.contracts[`${modules.stack}#${name}`]?.address]));
  if (Object.values(addresses).every(Boolean)) return addresses;
  const ids = [...prior.started, ...prior.successful,
    ...[...prior.failed, ...prior.held, ...prior.timedOut].map(entry => entry.futureId)];
  if (ids.some(id => id.startsWith(`${modules.listing}#`))) throw new Error('STACK_MANAGER_IGNITION_LISTING_GRAPH_INCOMPLETE');
  return undefined;
};

module.exports = { readRecovery, recoverAddresses };

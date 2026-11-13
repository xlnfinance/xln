/** Audit exports are derived from Ignition; they never decide which Future sends. */
const { listTransactions } = require('@nomicfoundation/ignition-core');
const { writeFileSync, openSync, fsyncSync, closeSync, renameSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { dirname } = require('node:path');

const save = (path, value) => {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(handle, JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2));
    fsyncSync(handle);
  } finally { closeSync(handle); }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
};

const deriveManifest = async ({ journalDirectory, artifacts, ethers, addresses, registeredTokens,
  deploymentId, network, chainId, deployer, foundationRecipient, output }) => {
  const transactions = await listTransactions(journalDirectory, { loadArtifact: name => artifacts.readArtifact(name) });
  const audit = await Promise.all(transactions.map(async transaction => ({ ...transaction,
    receipt: (await ethers.provider.getTransactionReceipt(transaction.txHash))?.toJSON(),
  })));
  save(`${output}.transactions.json`, audit);
  const expected = 10 + Number(Boolean(addresses.stablecoin)) + Object.keys(registeredTokens).length;
  if (audit.length !== expected || audit.some(entry => entry.status !== 'SUCCESS' || entry.receipt?.status !== 1)) {
    throw new Error(`IGNITION_OPERATION_EVIDENCE_INVALID:expected=${expected}:actual=${audit.length}`);
  }
  const creation = address => {
    const entry = audit.find(entry => entry.receipt.contractAddress?.toLowerCase() === address.toLowerCase());
    if (!entry) throw new Error(`IGNITION_CREATION_RECEIPT_MISSING:${address}`);
    return { address, transactionHash: entry.txHash, deploymentBlock: entry.receipt.blockNumber };
  };
  const call = (target, functionName) => {
    const entries = audit.filter(entry => entry.to?.toLowerCase() === addresses[target[0].toLowerCase() + target.slice(1)]?.toLowerCase()
      && entry.name === `${target}#${functionName}`);
    // Public Ignition transaction names identify calls; verify actual calldata independently at admission.
    if (entries.length !== 1) throw new Error(`IGNITION_CALL_RECEIPT_MISSING:${functionName}`);
    return { transactionHash: entries[0].txHash, blockNumber: entries[0].receipt.blockNumber };
  };
  const evmContracts = Object.fromEntries(Object.entries(addresses).map(([name, address]) => [name, creation(address)]));
  evmContracts.deltaTransformerBinding = call('DeltaTransformer', 'bindDepository');
  evmContracts.shareDepositoryBinding = call('EntityProvider', 'bindShareDepository');
  const listings = audit.filter(entry => entry.name === 'EntityProvider#foundationRegisterExternalToken');
  if (listings.length !== Object.keys(registeredTokens).length) throw new Error('IGNITION_LISTING_RECEIPTS_MISSING');
  evmContracts.stablecoinRegistration = { transactionHash: listings[0].txHash, blockNumber: listings[0].receipt.blockNumber };
  if (listings[1]) evmContracts.wrappedNativeRegistration = { transactionHash: listings[1].txHash, blockNumber: listings[1].receipt.blockNumber };
  const { stablecoin: _fixture, ...contracts } = addresses;
  return { deploymentId, stackVersion: 'V1', network, chainId, deployer, foundationRecipient,
    entityProviderDeploymentBlock: evmContracts.entityProvider.deploymentBlock, contracts, evmContracts, registeredTokens };
};

module.exports = { deriveManifest, save };

import type { Signer } from 'ethers';
import { ethers } from 'ethers';
import {
  Account__factory,
  DeltaTransformer__factory,
  Depository__factory,
  EntityProvider__factory,
} from '../../../../jurisdictions/typechain-types/index.ts';
import type { RpcContractStackState } from './rpc-contract-stack';
import { rpcLog } from '../rpc-public';
import { firstAddress } from '../rpc-utils';
import type { JAdapterAddresses, JAdapterConfig } from '../types';

export const readRpcReplicaAddresses = (config: JAdapterConfig): JAdapterAddresses => {
  const replica = config.fromReplica;
  if (!replica) return { account: '', depository: '', entityProvider: '', deltaTransformer: '' };
  return {
    account: firstAddress(replica.contracts?.account),
    depository: firstAddress(replica.contracts?.depository),
    entityProvider: firstAddress(replica.contracts?.entityProvider),
    deltaTransformer: firstAddress(replica.contracts?.deltaTransformer),
  };
};

const assertEntityProviderDeploymentOrigin = async (
  provider: ethers.JsonRpcProvider,
  address: string,
  deploymentBlock: number,
): Promise<void> => {
  // The watcher begins at deploymentBlock - 1, so a caller must not be able to
  // claim a later block and skip earlier board registrations. Prove the exact
  // contract-creation receipt instead of reading historical account state:
  // production RPCs commonly retain blocks and receipts while pruning old
  // state tries. Requiring archive state here made a valid durable replica
  // impossible to restore even though the immutable creation evidence still
  // existed. Current bytecode is verified separately by readiness binding.
  let block: unknown;
  try {
    block = await provider.send('eth_getBlockByNumber', [ethers.toQuantity(deploymentBlock), true]);
  } catch (error) {
    throw new Error(
      `RPC_ENTITY_PROVIDER_DEPLOYMENT_ORIGIN_UNAVAILABLE:${deploymentBlock}`,
      { cause: error },
    );
  }
  if (typeof block !== 'object' || block === null) {
    throw new Error(`RPC_ENTITY_PROVIDER_DEPLOYMENT_BLOCK_MISSING:${deploymentBlock}`);
  }
  const transactions = (block as { transactions?: unknown }).transactions;
  if (!Array.isArray(transactions)) {
    throw new Error(`RPC_ENTITY_PROVIDER_DEPLOYMENT_BLOCK_INVALID:${deploymentBlock}`);
  }
  const normalizedAddress = address.toLowerCase();
  for (const transaction of transactions) {
    const hash = typeof transaction === 'string'
      ? transaction
      : typeof transaction === 'object' && transaction !== null
        ? (transaction as { hash?: unknown }).hash
        : undefined;
    if (typeof hash !== 'string') continue;
    const receipt = await provider.send('eth_getTransactionReceipt', [hash]) as {
      blockNumber?: unknown;
      contractAddress?: unknown;
      status?: unknown;
    } | null;
    if (
      receipt !== null &&
      typeof receipt.contractAddress === 'string' &&
      receipt.contractAddress.toLowerCase() === normalizedAddress &&
      Number(BigInt(String(receipt.blockNumber))) === deploymentBlock &&
      BigInt(String(receipt.status)) === 1n
    ) {
      return;
    }
  }
  throw new Error(`RPC_ENTITY_PROVIDER_DEPLOYMENT_RECEIPT_MISSING:${deploymentBlock}`);
};

export const attachRpcReplicaContracts = async (
  config: JAdapterConfig,
  provider: ethers.JsonRpcProvider,
  signer: Signer,
  addresses: JAdapterAddresses,
  state: RpcContractStackState,
): Promise<void> => {
  if (!config.fromReplica) return;
  if (!Number.isSafeInteger(state.entityProviderDeploymentBlock) || state.entityProviderDeploymentBlock < 1) {
    throw new Error('RPC_ENTITY_PROVIDER_DEPLOYMENT_BLOCK_REQUIRED');
  }
  const missing = Object.entries(addresses)
    .filter(([, address]) => !address)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`fromReplica: Missing required addresses (${missing.join(', ')})`);
  }
  rpcLog.info('contracts.connect_from_replica.start', { chainId: config.chainId, ...addresses });
  const codes = await Promise.all([
    provider.getCode(addresses.account),
    provider.getCode(addresses.depository),
    provider.getCode(addresses.entityProvider),
    provider.getCode(addresses.deltaTransformer),
  ]);
  if (codes.some(code => code === '0x')) {
    throw new Error(
      '[JAdapter:rpc] fromReplica contract addresses have no code on chain: ' +
        `account=${addresses.account} code=${codes[0]} depository=${addresses.depository} code=${codes[1]} ` +
        `entityProvider=${addresses.entityProvider} code=${codes[2]} ` +
        `deltaTransformer=${addresses.deltaTransformer} code=${codes[3]}`,
    );
  }
  await assertEntityProviderDeploymentOrigin(
    provider,
    addresses.entityProvider,
    state.entityProviderDeploymentBlock,
  );
  state.account = Account__factory.connect(addresses.account, signer);
  state.depository = Depository__factory.connect(addresses.depository, signer);
  state.entityProvider = EntityProvider__factory.connect(addresses.entityProvider, signer);
  state.deltaTransformer = DeltaTransformer__factory.connect(addresses.deltaTransformer, signer);
  addresses.account = await state.account.getAddress();
  addresses.depository = await state.depository.getAddress();
  addresses.entityProvider = await state.entityProvider.getAddress();
  addresses.deltaTransformer = await state.deltaTransformer.getAddress();
  state.deployed = true;
};

import type { Signer } from 'ethers';
import { ethers } from 'ethers';
import {
  Account__factory,
  DeltaTransformer__factory,
  Depository__factory,
  EntityProvider__factory,
} from '../../../jurisdictions/typechain-types/index.ts';
import type { RpcContractStackState } from './rpc-contract-stack';
import { rpcLog } from './rpc-public';
import { firstAddress } from './rpc-utils';
import type { JAdapterAddresses, JAdapterConfig } from './types';

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
  currentCode: string,
): Promise<void> => {
  // The watcher begins at deploymentBlock - 1. Trusting a configured number
  // would let an importer skip earlier board-registration history. Prove the
  // exact state transition on the chain: no code immediately before B, the
  // same runtime code at B and today. RPCs without historical state must fail
  // loud; silently starting later is not a safe compatibility option.
  let deploymentCode: string;
  let precedingCode: string;
  try {
    [deploymentCode, precedingCode] = await Promise.all([
      provider.getCode(address, deploymentBlock),
      provider.getCode(address, deploymentBlock - 1),
    ]);
  } catch (error) {
    throw new Error(
      `RPC_ENTITY_PROVIDER_DEPLOYMENT_ORIGIN_UNAVAILABLE:${deploymentBlock}`,
      { cause: error },
    );
  }
  if (deploymentCode === '0x') {
    throw new Error(`RPC_ENTITY_PROVIDER_DEPLOYMENT_CODE_MISSING:${deploymentBlock}`);
  }
  if (precedingCode !== '0x') {
    throw new Error(`RPC_ENTITY_PROVIDER_PREDEPLOY_CODE_PRESENT:${deploymentBlock - 1}`);
  }
  if (deploymentCode.toLowerCase() !== currentCode.toLowerCase()) {
    throw new Error(`RPC_ENTITY_PROVIDER_DEPLOYMENT_CODE_CHANGED:${deploymentBlock}`);
  }
};

export const attachRpcReplicaContracts = async (
  config: JAdapterConfig,
  provider: ethers.JsonRpcProvider,
  signer: Signer,
  addresses: JAdapterAddresses,
  state: RpcContractStackState,
): Promise<void> => {
  if (!config.fromReplica) return;
  const attachmentAuthority = config.replicaAttachmentAuthority;
  if (
    attachmentAuthority !== 'deployment-origin-proof'
    && attachmentAuthority !== 'committed-runtime-state'
  ) {
    throw new Error('RPC_REPLICA_ATTACHMENT_AUTHORITY_REQUIRED');
  }
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
  if (attachmentAuthority === 'deployment-origin-proof') {
    await assertEntityProviderDeploymentOrigin(
      provider,
      addresses.entityProvider,
      state.entityProviderDeploymentBlock,
      codes[2]!,
    );
  }
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

import type { ContractRunner, Signer } from 'ethers';
import { ethers } from 'ethers';
import type {
  Account,
  DeltaTransformer,
  Depository,
  EntityProvider,
} from '../../../jurisdictions/typechain-types/index.ts';
import {
  Account__factory,
  DeltaTransformer__factory,
  Depository__factory,
  DepositoryBounds__factory,
  ERC20Mock__factory,
  EntityProvider__factory,
  HankoVerifier__factory,
  HashLadderRegistry__factory,
} from '../../../jurisdictions/typechain-types/index.ts';
import {
  TOKEN_REGISTRATION_AMOUNT,
  defaultTokensForJurisdiction,
  getDefaultTokenSupply,
} from '../machine/config/default-tokens';
import { requireUsableContractAddress } from '../machine/contract-address';
import { packTokenReference } from './contract-codec';
import { DEV_CHAIN_IDS } from './chain-ids';
import type { RpcChainIo } from './rpc-chain-io';
import { rpcLog } from './rpc-public';
import { linkArtifactBytecode } from './rpc-utils';
import { assertDepositoryEntityProviderBinding } from './stack-binding';
import type { JAdapterAddresses, JAdapterConfig } from './types';

import {
  attachRpcReplicaContracts,
  readRpcReplicaAddresses,
} from './rpc-contract-attachment';

export type RpcContractStackState = {
  account?: Account;
  depository?: Depository;
  entityProvider?: EntityProvider;
  deltaTransformer?: DeltaTransformer;
  deployed: boolean;
  bindingVerified: boolean;
  entityProviderDeploymentBlock: number;
};

export type RpcContractStack = {
  readonly account: Account;
  readonly depository: Depository;
  readonly entityProvider: EntityProvider;
  readonly deltaTransformer: DeltaTransformer;
  readonly addresses: JAdapterAddresses;
  readonly entityProviderDeploymentBlock: number;
  readonly bindingVerified: boolean;
  deploy(): Promise<void>;
  verifyBinding(context: string): Promise<void>;
  markBindingUnverified(): void;
  removeAllListeners(): void;
  getDepositoryAddress(): Promise<string>;
  getEntityProviderAddress(): Promise<string>;
};

const requireContract = <T>(label: string, contract: T | undefined): T => {
  if (!contract) throw new Error(`RPC_${label.toUpperCase()}_UNAVAILABLE`);
  return contract;
};

const deployAccount = async (
  signer: Signer,
  addresses: JAdapterAddresses,
  state: RpcContractStackState,
): Promise<void> => {
  const contract = await new Account__factory(signer).deploy();
  await contract.waitForDeployment();
  addresses.account = await contract.getAddress();
  state.account = contract;
};

const deployEntityProvider = async (
  config: JAdapterConfig,
  signer: Signer,
  addresses: JAdapterAddresses,
  state: RpcContractStackState,
): Promise<void> => {
  const verifier = await new HankoVerifier__factory(signer).deploy();
  await verifier.waitForDeployment();
  const verifierAddress = await verifier.getAddress();
  const bytecode = linkArtifactBytecode(EntityProvider__factory.bytecode, {
    'contracts/HankoVerifier.sol:HankoVerifier': verifierAddress,
  });
  const factory = new ethers.ContractFactory(EntityProvider__factory.abi, bytecode, signer);
  const foundationRecipient = await signer.getAddress();
  const deployedContract = await factory.deploy(foundationRecipient);
  await deployedContract.waitForDeployment();
  const receipt = await deployedContract.deploymentTransaction()?.wait();
  if (!receipt || !Number.isSafeInteger(receipt.blockNumber)) {
    throw new Error('ENTITY_PROVIDER_DEPLOYMENT_RECEIPT_MISSING');
  }
  state.entityProviderDeploymentBlock = receipt.blockNumber;
  addresses.entityProvider = await deployedContract.getAddress();
  state.entityProvider = EntityProvider__factory.connect(addresses.entityProvider, signer);
  rpcLog.debug('contracts.deploy.entity_provider', {
    chainId: config.chainId,
    entityProvider: addresses.entityProvider,
    foundationRecipient,
    hankoVerifier: verifierAddress,
  });
};

const resolveDepositoryDeployGas = async (
  config: JAdapterConfig,
  provider: ethers.JsonRpcProvider,
): Promise<bigint> => {
  if (DEV_CHAIN_IDS.has(config.chainId)) {
    return BigInt(process.env['JADAPTER_DEPLOY_GAS_LIMIT'] ?? '60000000');
  }
  let gasLimit = 30_000_000n;
  try {
    const latestBlock = await provider.getBlock('latest');
    if (latestBlock?.gasLimit) {
      const margin = 1_000_000n;
      gasLimit = latestBlock.gasLimit > margin ? latestBlock.gasLimit - margin : latestBlock.gasLimit;
    }
  } catch (error) {
    rpcLog.warn('contracts.deploy.gas_limit_lookup_failed', {
      chainId: config.chainId,
      fallbackGasLimit: gasLimit.toString(),
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return gasLimit;
};

const deployDepository = async (
  config: JAdapterConfig,
  provider: ethers.JsonRpcProvider,
  signer: Signer,
  addresses: JAdapterAddresses,
  state: RpcContractStackState,
): Promise<void> => {
  const bounds = await new DepositoryBounds__factory(signer).deploy();
  await bounds.waitForDeployment();
  const registry = await new HashLadderRegistry__factory(signer).deploy();
  await registry.waitForDeployment();
  const bytecode = linkArtifactBytecode(Depository__factory.bytecode, {
    'contracts/Account.sol:Account': addresses.account,
    'contracts/DepositoryBounds.sol:DepositoryBounds': await bounds.getAddress(),
    'contracts/HashLadderRegistry.sol:HashLadderRegistry': await registry.getAddress(),
  });
  const factory = new ethers.ContractFactory(
    Depository__factory.abi,
    bytecode,
    signer as ContractRunner,
  );
  const contract = await factory.deploy(
    addresses.entityProvider,
    addresses.deltaTransformer,
    { gasLimit: await resolveDepositoryDeployGas(config, provider) },
  );
  await contract.waitForDeployment();
  addresses.depository = await contract.getAddress();
  state.depository = Depository__factory.connect(addresses.depository, signer);
};

const deployDeltaTransformer = async (
  signer: Signer,
  addresses: JAdapterAddresses,
  state: RpcContractStackState,
): Promise<void> => {
  const contract = await new DeltaTransformer__factory(signer).deploy();
  await contract.waitForDeployment();
  addresses.deltaTransformer = await contract.getAddress();
  state.deltaTransformer = contract;
};

const deployBootstrapTokens = async (
  config: JAdapterConfig,
  signer: Signer,
  chainIo: RpcChainIo,
  addresses: JAdapterAddresses,
  depository: Depository,
): Promise<string[]> => {
  const tokens = defaultTokensForJurisdiction({ chainId: config.chainId });
  for (const token of tokens) {
    const supply = getDefaultTokenSupply(token.decimals);
    const contract = await new ERC20Mock__factory(signer).deploy(token.name, token.symbol, token.decimals, supply);
    await contract.waitForDeployment();
    const tokenAddress = await contract.getAddress();
    await chainIo.waitForReceipt(
      await contract.mint(addresses.depository, supply, await chainIo.buildFeeOverrides()),
      `erc20.mint-to-depository.${token.symbol}`,
    );
    await chainIo.waitForReceipt(
      await contract.approve(addresses.depository, TOKEN_REGISTRATION_AMOUNT, await chainIo.buildFeeOverrides()),
      `erc20.approve.${token.symbol}`,
    );
    const registration = await depository.adminRegisterExternalToken(
      {
        entity: ethers.ZeroHash,
        contractAddress: tokenAddress,
        externalTokenId: 0,
        tokenType: 0,
        internalTokenId: 0,
        amount: TOKEN_REGISTRATION_AMOUNT,
      },
      await chainIo.buildFeeOverrides(),
    );
    await chainIo.waitForReceipt(registration, `depository.externalTokenToReserve.${token.symbol}`);
    const tokenId = await depository.tokenToId(packTokenReference(0, tokenAddress, 0n));
    if (tokenId === 0n) throw new Error(`JADAPTER_BOOTSTRAP_TOKEN_REGISTRATION_FAILED:${token.symbol}`);
  }
  return tokens.map(token => token.symbol);
};

export const createRpcContractStack = async (
  config: JAdapterConfig,
  provider: ethers.JsonRpcProvider,
  signer: Signer,
  chainIo: RpcChainIo,
): Promise<RpcContractStack> => {
  const addresses = readRpcReplicaAddresses(config);
  const state: RpcContractStackState = {
    deployed: false,
    bindingVerified: false,
    entityProviderDeploymentBlock: Number(config.fromReplica?.entityProviderDeploymentBlock ?? 0),
  };
  await attachRpcReplicaContracts(config, provider, signer, addresses, state);
  const verifyBinding = async (context: string): Promise<void> => {
    state.bindingVerified = false;
    await assertDepositoryEntityProviderBinding(context, requireContract('depository', state.depository), addresses.entityProvider);
    state.bindingVerified = true;
  };
  if (state.deployed) {
    await verifyBinding('rpc_from_replica');
    rpcLog.info('contracts.connected', { chainId: config.chainId, ...addresses });
  }
  const deploy = async (): Promise<void> => {
    if (state.deployed) {
      await verifyBinding('rpc_reuse_existing');
      rpcLog.info('contracts.reuse_existing', { chainId: config.chainId });
      return;
    }
    rpcLog.info('contracts.deploy.start', { chainId: config.chainId });
    await deployAccount(signer, addresses, state);
    await deployEntityProvider(config, signer, addresses, state);
    await deployDeltaTransformer(signer, addresses, state);
    await deployDepository(config, provider, signer, addresses, state);
    await verifyBinding('rpc_deploy');
    const tokens = await deployBootstrapTokens(
      config,
      signer,
      chainIo,
      addresses,
      requireContract('depository', state.depository),
    );
    state.deployed = true;
    rpcLog.info('contracts.deploy.ready', { chainId: config.chainId, tokens, ...addresses });
  };
  return {
    get account() { return requireContract('account', state.account); },
    get depository() { return requireContract('depository', state.depository); },
    get entityProvider() { return requireContract('entity_provider', state.entityProvider); },
    get deltaTransformer() { return requireContract('delta_transformer', state.deltaTransformer); },
    get addresses() { return addresses; },
    get entityProviderDeploymentBlock() {
      if (!Number.isSafeInteger(state.entityProviderDeploymentBlock) || state.entityProviderDeploymentBlock < 1) {
        throw new Error('ENTITY_PROVIDER_DEPLOYMENT_BLOCK_UNAVAILABLE');
      }
      return state.entityProviderDeploymentBlock;
    },
    get bindingVerified() { return state.bindingVerified; },
    deploy,
    verifyBinding,
    markBindingUnverified: () => { state.bindingVerified = false; },
    removeAllListeners: () => {
      state.depository?.removeAllListeners();
      state.entityProvider?.removeAllListeners();
    },
    getDepositoryAddress: async () =>
      requireUsableContractAddress('depository', state.depository
        ? await state.depository.getAddress()
        : addresses.depository),
    getEntityProviderAddress: async () =>
      requireUsableContractAddress('entity_provider', state.entityProvider
        ? await state.entityProvider.getAddress()
        : addresses.entityProvider),
  };
};

/**
 * JAdapter - RPC Implementation
 * Unified adapter for all JSON-RPC backends (anvil, mainnet, testnet)
 *
 * Features:
 *   - Deploy contracts (anvil) or connect to existing (mainnet/testnet)
 *   - Snapshot/revert if RPC supports evm_snapshot (anvil)
 *   - Falls back gracefully on unsupported features
 *
 * @license AGPL-3.0
 */

import { ethers } from 'ethers';
import type { ContractRunner, ContractTransactionResponse, Provider, Signer, TransactionReceipt } from 'ethers';

import type { Account, Depository, EntityProvider, DeltaTransformer } from '../../jurisdictions/typechain-types/index.ts';
import type { TypedContractMethod } from '../../jurisdictions/typechain-types/common.ts';
import {
  Account__factory,
  Depository__factory,
  EntityProvider__factory,
  DeltaTransformer__factory,
  ERC20Mock__factory,
} from '../../jurisdictions/typechain-types/index.ts';

import type { BrowserVMState, JTx, Env } from '../types';
import { normalizeEntityId } from '../entity-id-utils';
import type { JAdapter, JAdapterAddresses, JAdapterConfig, JEvent, JEventCallback, JSubmitResult, SnapshotId, JBatchReceipt, BrowserVMProvider, JTokenInfo, JReserveMint } from './types';
import {
  buildExternalTokenToReserveBatch,
  computeAccountKey,
  entityIdToAddress,
  getWatcherStartBlock,
  parseReceiptLogsToJEvents,
  setupContractEventListeners,
  processEventBatch,
  updateWatcherJurisdictionCursor,
  type EventBatchCounter,
  type RawJEvent,
  type RawJEventArgs,
} from './helpers';
import { CANONICAL_J_EVENTS } from './helpers';
import { DEV_CHAIN_IDS } from './index';
import { preflightBatchForE2 } from '../j-batch';
import { firstUsableContractAddress, requireUsableContractAddress } from '../contract-address';
import { setDeltaTransformerAddress } from '../proof-builder';
import { prepareSignedBatch } from '../hanko/batch';

type DebugEventEmitter = {
  sendDebugEvent(payload: Record<string, unknown>): void;
};

const isDebugEventEmitter = (value: unknown): value is DebugEventEmitter =>
  typeof value === 'object' &&
  value !== null &&
  'sendDebugEvent' in value &&
  typeof value.sendDebugEvent === 'function';

const firstAddress = (...values: Array<unknown>): string => {
  return firstUsableContractAddress(...values) ?? '';
};

const linkArtifactBytecode = (
  bytecode: string,
  libraries: Record<string, string>,
): string => {
  let linked = bytecode.startsWith('0x') ? bytecode.slice(2) : bytecode;
  const unresolvedLibraryRef = /__\$[0-9a-fA-F]{34}\$__/g;

  for (const [libraryName, address] of Object.entries(libraries)) {
    if (!address) {
      throw new Error(`Missing linked library address for ${libraryName}`);
    }
    const normalizedAddress = address.replace(/^0x/, '').toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(normalizedAddress)) {
      throw new Error(`Invalid linked library address for ${libraryName}: ${address}`);
    }
    linked = linked.replace(unresolvedLibraryRef, normalizedAddress);
  }

  if (/__\$[0-9a-fA-F]{34}\$__/.test(linked)) {
    throw new Error('Unresolved library placeholders remain in linked bytecode');
  }

  return `0x${linked}`;
};

/**
 * Create RPC adapter - works with any JSON-RPC provider
 *
 * Modes:
 *   - anvil/rpc with no fromReplica: Deploys fresh contracts
 *   - rpc with fromReplica: Connects to existing contracts
 */
export async function createRpcAdapter(
  config: JAdapterConfig,
  provider: Provider,
  signer: Signer
): Promise<JAdapter> {
  const traceEnabled = process.env.JADAPTER_TRACE === '1';
  const trace = (phase: string, extra?: Record<string, unknown>): void => {
    if (!traceEnabled) return;
    console.log(`[JAdapter:rpc][trace] ${phase}${extra ? ` ${JSON.stringify(extra)}` : ''}`);
  };
  const PROD_WATCH_POLL_MS = 3000;
  const TEST_WATCH_POLL_MS = (() => {
    const raw = Number(process.env.JADAPTER_TEST_WATCH_POLL_MS ?? '1000');
    if (!Number.isFinite(raw)) return 1000;
    return Math.max(1000, Math.floor(raw));
  })();
  const DEV_WATCH_POLL_MS = (() => {
    const raw = Number(process.env.JADAPTER_DEV_WATCH_POLL_MS ?? '1000');
    if (!Number.isFinite(raw)) return 1000;
    return Math.max(1000, Math.floor(raw));
  })();
  const TX_WAIT_TIMEOUT_MS = Math.max(
    10_000,
    Math.floor(Number(process.env.JADAPTER_TX_WAIT_TIMEOUT_MS ?? config.txWaitTimeoutMs ?? 300_000)),
  );
  const TX_WAIT_CONFIRMS = Math.max(
    1,
    Math.floor(Number(process.env.JADAPTER_TX_WAIT_CONFIRMS ?? config.txWaitConfirms ?? 1)),
  );
  const GAS_HEADROOM_BPS = Math.max(
    10_000,
    Math.floor(Number(process.env.JADAPTER_GAS_HEADROOM_BPS ?? '12000')),
  );
  const MAX_FEE_PER_GAS_GWEI = Math.max(
    1,
    Math.floor(Number(process.env.JADAPTER_MAX_FEE_GWEI ?? '200')),
  );
  const MAX_FEE_PER_GAS_WEI = ethers.parseUnits(String(MAX_FEE_PER_GAS_GWEI), 'gwei');
  const DEFAULT_PROCESS_BATCH_GAS = 5_000_000n;
  const DEFAULT_SETTLE_GAS = 2_000_000n;
  type RpcReceipt = TransactionReceipt;

  trace('provider.getNetwork:start');
  const rpcChainId = Number((await provider.getNetwork()).chainId);
  trace('provider.getNetwork:done', { rpcChainId, configChainId: Number(config.chainId) });
  if (rpcChainId !== Number(config.chainId)) {
    throw new Error(
      `[JAdapter:rpc] chainId mismatch: config=${config.chainId} rpc=${rpcChainId}. Refusing to sign/submit.`,
    );
  }

  const applyGasHeadroom = (value: bigint): bigint =>
    (value * BigInt(GAS_HEADROOM_BPS) + 9_999n) / 10_000n;

  const formatReserveMintDebug = (mint: JReserveMint | undefined): string => {
    if (!mint) return 'none';
    return JSON.stringify({
      entityId: mint.entityId,
      tokenId: mint.tokenId,
      amount: mint.amount.toString(),
    });
  };

  const buildFeeOverrides = async (): Promise<Record<string, bigint>> => {
    const feeData = await provider.getFeeData();
    if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
      return {
        maxFeePerGas: feeData.maxFeePerGas > MAX_FEE_PER_GAS_WEI ? MAX_FEE_PER_GAS_WEI : feeData.maxFeePerGas,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas > MAX_FEE_PER_GAS_WEI
          ? MAX_FEE_PER_GAS_WEI
          : feeData.maxPriorityFeePerGas,
      };
    }
    throw new Error(
      `[JAdapter:rpc] EIP-1559 fee data unavailable for chainId=${config.chainId}. Refusing legacy gasPrice mode.`,
    );
  };

  const waitForReceipt = async (tx: ContractTransactionResponse, label: string): Promise<RpcReceipt> => {
    const receipt = await tx.wait(TX_WAIT_CONFIRMS, TX_WAIT_TIMEOUT_MS);
    if (!receipt) {
      throw new Error(`${label} transaction not mined (hash=${tx.hash})`);
    }
    return receipt;
  };

  const getBatchSignerPrivateKey = (): string => {
    if (config.privateKey) return config.privateKey;
    const signerPrivateKey = (signer as ethers.Wallet | { privateKey?: string }).privateKey;
    if (typeof signerPrivateKey === 'string' && signerPrivateKey.startsWith('0x')) {
      return signerPrivateKey;
    }
    throw new Error('[JAdapter:rpc] processBatch requires a signer private key for Hanko signing');
  };

  const processSignedBatch = async (
    entityId: string,
    batch: import('../j-batch').JBatch,
    txSigner?: Signer,
    batchSignerPrivateKey?: string,
  ): Promise<JBatchReceipt> => {
    const activeSigner = txSigner ?? signer;
    return runSerializedBatchFor(activeSigner, async () => {
      try {
        const chainId = BigInt(config.chainId);
        const depositoryAddress = await depository.getAddress();
        const currentNonce = await depository.entityNonces(normalizeEntityId(entityId));
        const { encodedBatch, hankoData, nextNonce } = prepareSignedBatch(
          batch,
          entityId,
          batchSignerPrivateKey ?? getBatchSignerPrivateKey(),
          chainId,
          depositoryAddress,
          currentNonce,
        );

        const depositoryWithSigner = txSigner ? depository.connect(txSigner) : depository;
        const feeOverrides = await buildFeeOverrides();
        const gasLimit = await estimateGasWithHeadroom(
          () => depositoryWithSigner.processBatch.estimateGas(encodedBatch, hankoData, nextNonce),
          DEFAULT_PROCESS_BATCH_GAS,
        );

        const tx = await depositoryWithSigner.processBatch(encodedBatch, hankoData, nextNonce, {
          gasLimit,
          nonce: await allocateSerializedSignerNonceFor(activeSigner),
          ...feeOverrides,
        });
        const receipt = await waitForReceipt(tx, 'processBatch');
        const events = parseReceiptLogsToJEvents(receipt, [depository, entityProvider]);

        return {
          txHash: receipt.hash,
          blockNumber: receipt.blockNumber,
          events,
        };
      } catch (error) {
        await resetSerializedSignerNonceFor(activeSigner);
        throw error;
      }
    });
  };

  const estimateGasWithHeadroom = async (estimate: () => Promise<bigint>, fallback: bigint): Promise<bigint> => {
    try {
      return applyGasHeadroom(await estimate());
    } catch {
      return fallback;
    }
  };

  type NonPayableMethod<TArgs extends unknown[], TResult> = TypedContractMethod<TArgs, [TResult], 'nonpayable'>;
  type SendTxOptions = {
    gasFallback: bigint;
    txNonce: number | null;
    resetSignerNonce: boolean;
  };

  const sendTypedTx = async <TArgs extends unknown[], TResult>(
    label: string,
    method: NonPayableMethod<TArgs, TResult>,
    args: [...TArgs],
    options: SendTxOptions,
  ) => {
    const gasLimit = await estimateGasWithHeadroom(
      () => method.estimateGas(...args),
      options.gasFallback,
    );
    if (options.resetSignerNonce) {
      maybeResetSignerNonce();
    }
    const feeOverrides = await buildFeeOverrides();
    const overrides = options.txNonce === null
      ? { gasLimit, ...feeOverrides }
      : { gasLimit, nonce: options.txNonce, ...feeOverrides };
    const tx = await method(...args, overrides);
    return waitForReceipt(tx, label);
  };

  const readSignerTxNonce = async (): Promise<number> => {
    const signerAddress = await signer.getAddress();
    return Math.max(
      await provider.getTransactionCount(signerAddress, 'latest'),
      await provider.getTransactionCount(signerAddress, 'pending'),
    );
  };

  const resolveWatcherPollMs = (scenarioMode: boolean): number => {
    if (scenarioMode) return TEST_WATCH_POLL_MS;
    if (config.watchPollMs && Number.isFinite(config.watchPollMs)) {
      return Math.max(1000, Math.floor(config.watchPollMs));
    }
    if (config.chainId === 1) return PROD_WATCH_POLL_MS;
    if (DEV_CHAIN_IDS.has(config.chainId)) return DEV_WATCH_POLL_MS;
    return 1500;
  };

  const resolveFinalityDepth = (scenarioMode: boolean): number => {
    if (scenarioMode || DEV_CHAIN_IDS.has(config.chainId)) return 0;
    if (config.confirmationDepth !== undefined && Number.isFinite(config.confirmationDepth)) {
      return Math.max(0, Math.floor(config.confirmationDepth));
    }
    if (config.chainId === 1) return 12;
    return 2;
  };

  // Serialize batch submissions per signer EOA to avoid nonce races across concurrent entity batches.
  const batchSubmitQueues = new Map<string, Promise<unknown>>();
  const nextSerializedSignerNonces = new Map<string, number>();
  const getSerializedSignerKey = async (activeSigner: Signer): Promise<string> => {
    return (await activeSigner.getAddress()).toLowerCase();
  };
  const runSerializedBatchFor = async <T>(activeSigner: Signer, work: () => Promise<T>): Promise<T> => {
    const signerKey = await getSerializedSignerKey(activeSigner);
    const previous = batchSubmitQueues.get(signerKey) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(work);
    batchSubmitQueues.set(
      signerKey,
      next.finally(() => {
        if (batchSubmitQueues.get(signerKey) === next) {
          batchSubmitQueues.delete(signerKey);
        }
      }),
    );
    return next;
  };
  const runSerializedBatch = async <T>(work: () => Promise<T>): Promise<T> => {
    return runSerializedBatchFor(signer, work);
  };

  type NonceResettableSigner = {
    resetNonce(): void;
  };
  const maybeResetSignerNonceFor = (activeSigner: Signer): void => {
    const candidate = activeSigner as unknown as Partial<NonceResettableSigner>;
    if (typeof candidate.resetNonce === 'function') {
      try {
        candidate.resetNonce();
      } catch {
        // Best-effort only.
      }
    }
  };
  const maybeResetSignerNonce = (): void => {
    maybeResetSignerNonceFor(signer);
  };

  const resetSerializedSignerNonceFor = async (activeSigner: Signer): Promise<void> => {
    const signerKey = await getSerializedSignerKey(activeSigner);
    nextSerializedSignerNonces.delete(signerKey);
    maybeResetSignerNonceFor(activeSigner);
  };
  const resetSerializedSignerNonce = async (): Promise<void> => {
    await resetSerializedSignerNonceFor(signer);
  };

  const readSignerTxNonceFor = async (activeSigner: Signer): Promise<number> => {
    const signerAddress = await activeSigner.getAddress();
    return Math.max(
      await provider.getTransactionCount(signerAddress, 'latest'),
      await provider.getTransactionCount(signerAddress, 'pending'),
    );
  };
  const allocateSerializedSignerNonceFor = async (activeSigner: Signer): Promise<number> => {
    const signerKey = await getSerializedSignerKey(activeSigner);
    const chainNonce = await readSignerTxNonceFor(activeSigner);
    const cachedNonce = nextSerializedSignerNonces.has(signerKey)
      ? nextSerializedSignerNonces.get(signerKey) ?? null
      : null;
    let nextNonce = cachedNonce;
    if (nextNonce === null || chainNonce > nextNonce) {
      nextNonce = chainNonce;
    }
    const nonce = nextNonce;
    nextSerializedSignerNonces.set(signerKey, nonce + 1);
    return nonce;
  };
  const allocateSerializedSignerNonce = async (): Promise<number> => {
    return allocateSerializedSignerNonceFor(signer);
  };

  type ErrorWithMessage = {
    message?: unknown;
  };
  const isNonceSyncError = (error: unknown): boolean => {
    const msg =
      typeof error === 'object' && error !== null && 'message' in error
        ? String((error as ErrorWithMessage).message ?? '')
        : String(error ?? '');
    const normalized = msg.toLowerCase();
    return (
      normalized.includes('nonce too low') ||
      normalized.includes('nonce has already been used') ||
      normalized.includes('nonce expired') ||
      normalized.includes('code=nonce_expired')
    );
  };

  const addresses: JAdapterAddresses = {
    account: '',
    depository: '',
    entityProvider: '',
    deltaTransformer: '',
  };

  let account: Account;
  let depository: Depository;
  let entityProvider: EntityProvider;
  let deltaTransformer: DeltaTransformer;
  let deployed = false;

  // If fromReplica provided, connect to existing contracts
  if (config.fromReplica) {
    addresses.account = firstAddress(
      config.fromReplica.jadapter?.addresses?.account,
      config.fromReplica.contracts?.account,
    );
    addresses.depository = firstAddress(
      config.fromReplica.jadapter?.addresses?.depository,
      config.fromReplica.contracts?.depository,
      config.fromReplica.depositoryAddress,
    );
    addresses.entityProvider = firstAddress(
      config.fromReplica.jadapter?.addresses?.entityProvider,
      config.fromReplica.contracts?.entityProvider,
      config.fromReplica.entityProviderAddress,
    );
    addresses.deltaTransformer = firstAddress(
      config.fromReplica.jadapter?.addresses?.deltaTransformer,
      config.fromReplica.contracts?.deltaTransformer,
    );

    console.log('[JAdapter:rpc] fromReplica mode - connecting to contracts:');
    console.log('  Account:', addresses.account);
    console.log('  Depository:', addresses.depository);
    console.log('  EntityProvider:', addresses.entityProvider);
    console.log('  DeltaTransformer:', addresses.deltaTransformer);

    const missingReplicaAddresses = [
      !addresses.account ? 'account' : null,
      !addresses.depository ? 'depository' : null,
      !addresses.entityProvider ? 'entityProvider' : null,
      !addresses.deltaTransformer ? 'deltaTransformer' : null,
    ].filter((value): value is string => Boolean(value));
    if (missingReplicaAddresses.length > 0) {
      throw new Error(
        `fromReplica: Missing required addresses (${missingReplicaAddresses.join(', ')})`,
      );
    }

    trace('fromReplica.getCode:start');
    const [accountCode, depCode, epCode, transformerCode] = await Promise.all([
      provider.getCode(addresses.account),
      provider.getCode(addresses.depository),
      provider.getCode(addresses.entityProvider),
      provider.getCode(addresses.deltaTransformer),
    ]);
    trace('fromReplica.getCode:done', {
      accountLen: accountCode.length,
      depLen: depCode.length,
      epLen: epCode.length,
      transformerLen: transformerCode.length,
    });

    if (accountCode === '0x' || depCode === '0x' || epCode === '0x' || transformerCode === '0x') {
      throw new Error(
        '[JAdapter:rpc] fromReplica contract addresses have no code on chain: ' +
          `account=${addresses.account || 'none'} code=${accountCode} ` +
          `depository=${addresses.depository || 'none'} code=${depCode} ` +
          `entityProvider=${addresses.entityProvider || 'none'} code=${epCode} ` +
          `deltaTransformer=${addresses.deltaTransformer || 'none'} code=${transformerCode}`,
      );
    } else {
      trace('fromReplica.connect:start');
      // Use any cast to handle ethers version mismatch between root and jurisdictions
      account = Account__factory.connect(addresses.account, signer);
      depository = Depository__factory.connect(addresses.depository, signer);
      entityProvider = EntityProvider__factory.connect(addresses.entityProvider, signer);
      deltaTransformer = DeltaTransformer__factory.connect(addresses.deltaTransformer, signer);
      trace('fromReplica.connect:done');
      trace('fromReplica.getAddress:start');
      addresses.account = await account.getAddress();
      addresses.depository = await depository.getAddress();
      addresses.entityProvider = await entityProvider.getAddress();
      addresses.deltaTransformer = await deltaTransformer.getAddress();
      trace('fromReplica.getAddress:done', { addresses });
      deployed = true;
      trace('fromReplica.setDeltaTransformer:start');
      setDeltaTransformerAddress(addresses.deltaTransformer);
      trace('fromReplica.setDeltaTransformer:done');
      console.log('[JAdapter:rpc] Connected to existing contracts ✓');
    }
  }

  const eventCallbacks = new Map<string, Set<JEventCallback>>();
  const anyCallbacks = new Set<JEventCallback>();

  const getLiveDepositoryAddress = async (): Promise<string> =>
    requireUsableContractAddress(
      'depository',
      depository ? await depository.getAddress() : addresses.depository,
    );

  const getLiveEntityProviderAddress = async (): Promise<string> =>
    requireUsableContractAddress(
      'entity_provider',
      entityProvider ? await entityProvider.getAddress() : addresses.entityProvider,
    );

  // Check if RPC supports snapshots (anvil)
  const supportsSnapshots = async (): Promise<boolean> => {
    try {
      const rpc = provider as ethers.JsonRpcProvider;
      await rpc.send('evm_snapshot', []);
      return true;
    } catch {
      return false;
    }
  };

  const adapter: JAdapter = {
    mode: config.mode,
    chainId: config.chainId,
    provider,
    signer,

    get account() { return account; },
    get depository() { return depository; },
    get entityProvider() { return entityProvider; },
    get deltaTransformer() { return deltaTransformer; },
    get addresses() { return addresses; },

    async deployStack() {
      if (deployed) {
        console.log('[JAdapter:rpc] Using existing contracts');
        setDeltaTransformerAddress(addresses.deltaTransformer);
        setupContractEventListeners(depository, entityProvider, eventCallbacks, anyCallbacks);
        return;
      }

      console.log('[JAdapter:rpc] Deploying stack...');

      // Deploy Account library
      // Use any cast to handle ethers version mismatch between root and jurisdictions
      const accountFactory = new Account__factory(signer);
      const accountContract = await accountFactory.deploy();
      await accountContract.waitForDeployment();
      addresses.account = await accountContract.getAddress();
      account = accountContract;
      console.log(`  Account: ${addresses.account}`);

      // Deploy EntityProvider
      const entityProviderFactory = new EntityProvider__factory(signer);
      const entityProviderContract = await entityProviderFactory.deploy();
      await entityProviderContract.waitForDeployment();
      addresses.entityProvider = await entityProviderContract.getAddress();
      entityProvider = entityProviderContract;
      console.log(`  EntityProvider: ${addresses.entityProvider}`);

      // Deploy Depository (needs Account library linked)
      const linkedDepositoryBytecode = linkArtifactBytecode(
        Depository__factory.bytecode,
        { 'contracts/Account.sol:Account': addresses.account },
      );
      const depositoryFactory = new ethers.ContractFactory(
        Depository__factory.abi,
        linkedDepositoryBytecode,
        signer as ContractRunner,
      );
      // Fresh dev-chain deployments can exceed 30M after linking + viaIR.
      let deployGasLimit = DEV_CHAIN_IDS.has(config.chainId)
        ? BigInt(process.env.JADAPTER_DEPLOY_GAS_LIMIT ?? '60000000')
        : 30_000_000n;
      if (!DEV_CHAIN_IDS.has(config.chainId)) {
        try {
          const latestBlock = await provider.getBlock('latest');
          if (latestBlock?.gasLimit) {
            const margin = 1_000_000n;
            deployGasLimit = latestBlock.gasLimit > margin ? latestBlock.gasLimit - margin : latestBlock.gasLimit;
          }
        } catch {
          // Fallback to default when provider can't fetch block gas limit.
        }
      }
      const depositoryContract = await depositoryFactory.deploy(addresses.entityProvider, {
        gasLimit: deployGasLimit,
      });
      await depositoryContract.waitForDeployment();
      addresses.depository = await depositoryContract.getAddress();
      depository = Depository__factory.connect(addresses.depository, signer);
      console.log(`  Depository: ${addresses.depository}`);

      // Deploy DeltaTransformer
      const deltaTransformerFactory = new DeltaTransformer__factory(signer);
      const deltaTransformerContract = await deltaTransformerFactory.deploy();
      await deltaTransformerContract.waitForDeployment();
      addresses.deltaTransformer = await deltaTransformerContract.getAddress();
      deltaTransformer = deltaTransformerContract;
      setDeltaTransformerAddress(addresses.deltaTransformer);
      console.log(`  DeltaTransformer: ${addresses.deltaTransformer}`);

      // Deploy bootstrap ERC20 test token (5th contract in local anvil stack)
      const erc20Factory = new ERC20Mock__factory(signer);
      const erc20Contract = await erc20Factory.deploy('USD Coin', 'USDC', ethers.parseUnits('10000000000', 18));
      await erc20Contract.waitForDeployment();
      const erc20Address = await erc20Contract.getAddress();
      console.log(`  ERC20Mock(USDC): ${erc20Address}`);

      // Pre-fund Depository with ERC20 so withdrawals (reserveToExternalToken) work.
      // mintToReserve only updates internal accounting — the Depository needs real ERC20 balance.
      const prefundAmount = ethers.parseUnits('1000000000000', 18); // 1T tokens
      const prefundTx = await erc20Contract.mint(addresses.depository, prefundAmount, await buildFeeOverrides());
      await waitForReceipt(prefundTx, 'erc20.mint-to-depository');
      console.log(`  Depository pre-funded: ${ethers.formatUnits(prefundAmount, 18)} USDC`);

      // Register token in Depository token registry (tokenId > 0)
      const tokenRegistrationAmount = 1_000_000n;
      const approveTx = await erc20Contract.approve(addresses.depository, tokenRegistrationAmount, await buildFeeOverrides());
      await waitForReceipt(approveTx, 'erc20.approve');
      const registerTx = await depository.adminRegisterExternalToken({
        entity: ethers.ZeroHash,
        contractAddress: erc20Address,
        externalTokenId: 0,
        tokenType: 0,
        internalTokenId: 0,
        amount: tokenRegistrationAmount,
      }, await buildFeeOverrides());
      await waitForReceipt(registerTx, 'depository.externalTokenToReserve');
      const packed = await depository.packTokenReference(0, erc20Address, 0);
      const tokenId = await depository.tokenToId(packed);
      if (tokenId === 0n) {
        throw new Error('[JAdapter:rpc] Failed to register bootstrap ERC20 token');
      }
      console.log(`  TokenRegistry: USDC tokenId=${tokenId}`);

      // Setup event listeners
      setupContractEventListeners(depository, entityProvider, eventCallbacks, anyCallbacks);
      deployed = true;

      console.log('[JAdapter:rpc] Stack deployed');
    },

    async snapshot(): Promise<SnapshotId> {
      try {
        const rpc = provider as ethers.JsonRpcProvider;
        return await rpc.send('evm_snapshot', []);
      } catch {
        throw new Error('Snapshot not supported by this RPC');
      }
    },

    async revert(snapshotId: SnapshotId): Promise<void> {
      try {
        const rpc = provider as ethers.JsonRpcProvider;
        await rpc.send('evm_revert', [snapshotId]);
      } catch {
        throw new Error('Revert not supported by this RPC');
      }
    },

    async dumpState(): Promise<string> {
      try {
        const rpc = provider as ethers.JsonRpcProvider;
        const path = config.stateFile ?? './data/anvil-state.json';
        await rpc.send('anvil_dumpState', []);
        return path;
      } catch {
        throw new Error('dumpState not supported by this RPC');
      }
    },

    async loadState(state: BrowserVMState | string): Promise<void> {
      if (typeof state !== 'string') {
        throw new Error('RPC requires file path string');
      }
      try {
        const rpc = provider as ethers.JsonRpcProvider;
        await rpc.send('anvil_loadState', [state]);
      } catch {
        throw new Error('loadState not supported by this RPC');
      }
    },

    on(eventName: string, callback: JEventCallback): () => void {
      if (!eventCallbacks.has(eventName)) {
        eventCallbacks.set(eventName, new Set());
      }
      eventCallbacks.get(eventName)!.add(callback);
      return () => eventCallbacks.get(eventName)?.delete(callback);
    },

    onAny(callback: JEventCallback): () => void {
      anyCallbacks.add(callback);
      return () => anyCallbacks.delete(callback);
    },

    async processBlock(): Promise<JEvent[]> {
      // Try to mine a block (anvil)
      try {
        const rpc = provider as ethers.JsonRpcProvider;
        await rpc.send('evm_mine', []);
      } catch {
        // Real chains mine blocks automatically
      }
      return [];
    },

    async getReserves(entityId: string, tokenId: number): Promise<bigint> {
      return depository._reserves(entityId, tokenId);
    },

    async getCollateral(entity1: string, entity2: string, tokenId: number): Promise<bigint> {
      const key = computeAccountKey(entity1, entity2);
      const result = await depository._collaterals(key, tokenId);
      return result.collateral;
    },

    async getAccountInfo(
      entityId: string,
      counterpartyId: string,
    ): Promise<{ nonce: bigint; disputeHash: string; disputeTimeout: bigint }> {
      const key = computeAccountKey(entityId, counterpartyId);
      const result = await depository._accounts(key);
      return {
        nonce: result.nonce,
        disputeHash: result.disputeHash,
        disputeTimeout: result.disputeTimeout,
      };
    },

    async getEntityNonce(entityId: string): Promise<bigint> {
      return depository.entityNonces(normalizeEntityId(entityId));
    },

    async isEntityRegistered(entityId: string): Promise<boolean> {
      const info = await entityProvider.entities(entityId);
      // registrationBlock > 0 means entity was registered
      return info.registrationBlock !== 0n;
    },

    async getTokenRegistry(): Promise<JTokenInfo[]> {
      try {
        const length = Number(await depository.getTokensLength());
        const tokens: JTokenInfo[] = [];
        const erc20Interface = new ethers.Interface([
          'function symbol() view returns (string)',
          'function name() view returns (string)',
          'function decimals() view returns (uint8)',
        ]);

        for (let tokenId = 1; tokenId < length; tokenId++) {
          const [contractAddress, _externalTokenId, _tokenType] = await depository.getTokenMetadata(tokenId);

          // Skip zero/null addresses
          if (contractAddress === ethers.ZeroAddress) continue;

          // Try to read ERC20 metadata - if it has symbol(), treat as ERC20
          const erc20 = new ethers.Contract(contractAddress, erc20Interface, provider);
          const symbolFn = erc20.getFunction('symbol') as () => Promise<string>;
          const nameFn = erc20.getFunction('name') as () => Promise<string>;
          const decimalsFn = erc20.getFunction('decimals') as () => Promise<bigint>;
          let symbol = '';
          let name = '';
          let decimals = 18;
          try { symbol = await symbolFn(); } catch { continue; } // Skip if no symbol (not ERC20)
          try { name = await nameFn(); } catch { name = symbol; }
          try { decimals = Number(await decimalsFn()); } catch { }

          if (!symbol) continue;
          tokens.push({ symbol, name: name || symbol, address: contractAddress, decimals, tokenId });
        }

        return tokens;
      } catch (err) {
        console.warn('[JAdapter:rpc] Token registry fetch failed:', (err as Error).message);
        return [];
      }
    },

    async getErc20Balance(tokenAddress: string, owner: string): Promise<bigint> {
      const erc20 = new ethers.Contract(tokenAddress, ['function balanceOf(address owner) view returns (uint256)'], provider);
      const balanceOf = erc20.getFunction('balanceOf') as (owner: string) => Promise<bigint>;
      return balanceOf(owner);
    },

    async getErc20Balances(tokenAddresses: string[], owner: string): Promise<bigint[]> {
      const erc20Interface = new ethers.Interface([
        'function balanceOf(address owner) view returns (uint256)',
      ]);

      const rpcUrl = config.rpcUrl;
      if (rpcUrl && rpcUrl.startsWith('http')) {
        try {
          const batch = tokenAddresses.map((tokenAddress, idx) => ({
            id: idx + 1,
            jsonrpc: '2.0',
            method: 'eth_call',
            params: [{
              to: tokenAddress,
              data: erc20Interface.encodeFunctionData('balanceOf', [owner]),
            }, 'latest'],
          }));

          const response = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(batch),
          });

          if (response.ok) {
            const json = await response.json();
            if (Array.isArray(json)) {
              const byId = new Map<number, string>();
              for (const item of json) {
                if (item && typeof item.id === 'number' && typeof item.result === 'string') {
                  byId.set(item.id, item.result);
                }
              }
              return tokenAddresses.map((_, idx) => {
                const result = byId.get(idx + 1);
                try {
                  return result ? BigInt(result) : 0n;
                } catch {
                  return 0n;
                }
              });
            }
          }
        } catch (err) {
          console.warn('[JAdapter:rpc] Batch balance fetch failed, falling back to per-call:', (err as Error).message);
        }
      }

      // Fallback: per-token calls
      return Promise.all(tokenAddresses.map(addr => adapter.getErc20Balance(addr, owner)));
    },

    // === WRITE METHODS ===

    async processBatch(encodedBatch: string, hankoData: string, nonce: bigint): Promise<JBatchReceipt> {
      return runSerializedBatch(async () => {
        try {
          const receipt = await sendTypedTx(
            'processBatch',
            depository.processBatch,
            [encodedBatch, hankoData, nonce],
            {
              gasFallback: DEFAULT_PROCESS_BATCH_GAS,
              txNonce: await allocateSerializedSignerNonce(),
              resetSignerNonce: true,
            },
          );
          const events = parseReceiptLogsToJEvents(receipt, [depository, entityProvider]);

          return {
            txHash: receipt.hash,
            blockNumber: receipt.blockNumber,
            events,
          };
        } catch (error) {
          await resetSerializedSignerNonce();
          throw error;
        }
      });
    },

    async enforceDebts(entityId: string, tokenId: number): Promise<void> {
      await runSerializedBatch(async () => {
        try {
          await sendTypedTx(
            'enforceDebts',
            depository.enforceDebts,
            [entityId, BigInt(tokenId), 100n],
            {
              gasFallback: 500_000n,
              txNonce: await allocateSerializedSignerNonce(),
              resetSignerNonce: false,
            },
          );
        } catch (error) {
          await resetSerializedSignerNonce();
          throw error;
        }
      });
    },

    async debugFundReserves(entityId: string, tokenId: number, amount: bigint): Promise<JEvent[]> {
      // For dev chains (anvil), allow debug funding for testnet
      if (DEV_CHAIN_IDS.has(config.chainId)) {
        return runSerializedBatch(async () => {
          try {
            const receipt = await sendTypedTx(
              'mintToReserve',
              depository.mintToReserve,
              [entityId, tokenId, amount],
              {
                gasFallback: 1_000_000n,
                txNonce: await allocateSerializedSignerNonce(),
                resetSignerNonce: false,
              },
            );
            return parseReceiptLogsToJEvents(receipt, [depository]);
          } catch (error) {
            await resetSerializedSignerNonce();
            throw error;
          }
        });
      }
      // Real networks: must use real deposits
      throw new Error('debugFundReserves only available on configured dev chains - use real token deposits');
      /* Original implementation for reference (requires Depository extension):
      const tx = await depository.debugFundReserves(entityId, tokenId, amount);
      const receipt = await tx.wait();
      if (!receipt) throw new Error('Fund reserves failed');

      const events: JEvent[] = [];
      for (const log of receipt.logs) {
        try {
          const parsed = depository.interface.parseLog(log);
          if (parsed) {
            events.push({
              name: parsed.name,
              args: Object.fromEntries(
                parsed.fragment.inputs.map((input: { name: string }, i: number) => [input.name, parsed.args[i]])
              ),
              blockNumber: receipt.blockNumber,
              blockHash: receipt.blockHash,
              transactionHash: receipt.hash,
            });
          }
        } catch { }
      }
      return events;
      */
    },

    async debugFundReservesBatch(mints: JReserveMint[]): Promise<JEvent[]> {
      if (!DEV_CHAIN_IDS.has(config.chainId)) {
        throw new Error('debugFundReservesBatch only available on configured dev chains');
      }
      if (mints.length === 0) return [];
      const payload = mints.map((mint) => ({
        entity: mint.entityId,
        tokenId: BigInt(mint.tokenId),
        amount: mint.amount,
      }));
      console.log(
        `[JAdapter:rpc] mintToReserveBatch start chainId=${config.chainId} ` +
          `count=${mints.length} ` +
          `first=${formatReserveMintDebug(mints[0])}`,
      );
      return runSerializedBatch(async () => {
        try {
          const receipt = await sendTypedTx(
            'mintToReserveBatch',
            depository.mintToReserveBatch,
            [payload],
            {
              gasFallback: 5_000_000n,
              txNonce: await allocateSerializedSignerNonce(),
              resetSignerNonce: false,
            },
          );
          return parseReceiptLogsToJEvents(receipt, [depository]);
        } catch (error) {
          await resetSerializedSignerNonce();
          throw error;
        }
      });
    },

    async externalTokenToReserve(
      signerPrivateKey: Uint8Array,
      entityId: string,
      tokenAddress: string,
      amount: bigint,
      options?: {
        tokenType?: number;
        externalTokenId?: bigint;
        internalTokenId?: number;
      }
    ): Promise<JEvent[]> {
      const signerWallet = new ethers.Wallet(
        '0x' + Buffer.from(signerPrivateKey).toString('hex'),
        provider
      );
      const signerAddress = signerWallet.address;
      let nextNonce = await provider.getTransactionCount(signerAddress, 'pending');

      const tokenType = options?.tokenType ?? 0;
      const externalTokenIdRaw = options?.externalTokenId ?? 0n;
      const externalTokenId = typeof externalTokenIdRaw === 'bigint' ? externalTokenIdRaw : BigInt(externalTokenIdRaw);
      const internalTokenId = options?.internalTokenId ?? 0;

      if (tokenType !== 0) {
        throw new Error('RPC adapter externalTokenToReserve currently supports ERC20 only');
      }

      const erc20 = new ethers.Contract(tokenAddress, [
        'function balanceOf(address owner) view returns (uint256)',
        'function approve(address spender, uint256 amount) returns (bool)',
        'function allowance(address owner, address spender) view returns (uint256)',
      ], signerWallet);

      const tokenCode = await provider.getCode(tokenAddress);
      if (!tokenCode || tokenCode === '0x') {
        throw new Error(`ERC20 token not deployed at ${tokenAddress}`);
      }

      const balanceFn = erc20.getFunction('balanceOf') as (owner: string) => Promise<bigint>;
      const externalBalance = await balanceFn(signerAddress);
      if (externalBalance < amount) {
        throw new Error(
          `Insufficient external token balance: have ${externalBalance}, need ${amount} at ${tokenAddress}`,
        );
      }

      // Step 1: Approve Depository to spend tokens (max allowance for smoother UX)
      const allowanceFn = erc20.getFunction('allowance') as (owner: string, spender: string) => Promise<bigint>;
      const approveFn = erc20.getFunction('approve') as (
        spender: string,
        amount: bigint,
        overrides?: Record<string, bigint>
      ) => Promise<{ wait: (confirms?: number, timeout?: number) => Promise<unknown>; hash: string }>;
      const liveDepositoryAddress = await getLiveDepositoryAddress();
      const allowance: bigint = await allowanceFn(signerAddress, liveDepositoryAddress);
      if (allowance < amount) {
        // Safer approval model: approve exact amount needed.
        // For USDT-like tokens, clear to 0 before raising allowance.
        if (allowance > 0n) {
          const clearTx = await approveFn(liveDepositoryAddress, 0n, {
            ...(await buildFeeOverrides()),
            nonce: nextNonce,
          });
          nextNonce += 1;
          await waitForReceipt(clearTx, 'erc20ApproveReset');
        }
        const approveTx = await approveFn(liveDepositoryAddress, amount, {
          ...(await buildFeeOverrides()),
          nonce: nextNonce,
        });
        nextNonce += 1;
        await waitForReceipt(approveTx, 'erc20ApproveExact');
        console.log(`[JAdapter:rpc] Approved exact allowance=${amount} for Depository`);
      }

      const batch = buildExternalTokenToReserveBatch({
        entityId,
        tokenAddress,
        amount,
        tokenType,
        externalTokenId,
        internalTokenId,
      });
      const receipt = await processSignedBatch(entityId, batch, signerWallet, signerWallet.privateKey);
      const normalizedEntityId = normalizeEntityId(entityId);
      const batchProcessed = receipt.events.find((event) =>
        event.name === 'HankoBatchProcessed' &&
        String(event.args.entityId || '').toLowerCase() === normalizedEntityId,
      );
      if (batchProcessed && batchProcessed.args.success === false) {
        throw new Error(`externalTokenToReserve failed on-chain for ${normalizedEntityId.slice(-8)}`);
      }
      const reserveUpdated = receipt.events.find((event) =>
        event.name === 'ReserveUpdated' &&
        String(event.args.entity || '').toLowerCase() === normalizedEntityId,
      );
      if (!reserveUpdated) {
        const eventNames = receipt.events.map((event) => event.name).join(',') || 'none';
        throw new Error(
          `externalTokenToReserve missing ReserveUpdated for ${normalizedEntityId.slice(-8)} (events=${eventNames})`,
        );
      }

      console.log(`[JAdapter:rpc] Deposited ${amount} tokens to entity ${entityId.slice(0, 16)}...`);
      return receipt.events;
    },

    async getErc20Allowance(tokenAddress: string, owner: string, spender: string): Promise<bigint> {
      const erc20 = new ethers.Contract(tokenAddress, [
        'function allowance(address owner, address spender) view returns (uint256)',
      ], provider);
      const allowanceFn = erc20.getFunction('allowance') as (ownerAddress: string, spenderAddress: string) => Promise<bigint>;
      return allowanceFn(owner, spender);
    },

    async approveErc20(
      signerPrivateKey: Uint8Array,
      tokenAddress: string,
      spender: string,
      amount: bigint,
    ): Promise<string> {
      const signerWallet = new ethers.Wallet(
        '0x' + Buffer.from(signerPrivateKey).toString('hex'),
        provider,
      );
      const erc20 = new ethers.Contract(tokenAddress, [
        'function approve(address spender, uint256 amount) returns (bool)',
      ], signerWallet);
      const approveFn = erc20.getFunction('approve') as (
        spenderAddress: string,
        approvalAmount: bigint,
        overrides?: Record<string, bigint>
      ) => Promise<{ hash: string }>;
      const tx = await approveFn(spender, amount, await buildFeeOverrides());
      await waitForReceipt(tx, 'approveErc20');
      return tx.hash;
    },

    async transferErc20(
      signerPrivateKey: Uint8Array,
      tokenAddress: string,
      to: string,
      amount: bigint,
    ): Promise<string> {
      const signerWallet = new ethers.Wallet(
        '0x' + Buffer.from(signerPrivateKey).toString('hex'),
        provider,
      );
      const erc20 = new ethers.Contract(tokenAddress, [
        'function transfer(address to, uint256 amount) returns (bool)',
      ], signerWallet);
      const transferFn = erc20.getFunction('transfer') as (
        recipient: string,
        transferAmount: bigint,
        overrides?: Record<string, bigint>
      ) => Promise<{ hash: string }>;
      const tx = await transferFn(to, amount, await buildFeeOverrides());
      await waitForReceipt(tx, 'transferErc20');
      return tx.hash;
    },

    async transferNative(
      signerPrivateKey: Uint8Array,
      to: string,
      amount: bigint,
    ): Promise<string> {
      const signerWallet = new ethers.Wallet(
        '0x' + Buffer.from(signerPrivateKey).toString('hex'),
        provider,
      );
      const tx = await signerWallet.sendTransaction({
        to,
        value: amount,
        ...(await buildFeeOverrides()),
      });
      await waitForReceipt(tx, 'transferNative');
      return tx.hash;
    },

    // === High-level J-tx submission ===
    async submitTx(jTx: JTx, options: { env: Env; signerId?: string; signerPrivateKey?: Uint8Array; timestamp?: number }): Promise<JSubmitResult> {
      const { env, signerId, signerPrivateKey, timestamp } = options;

      console.log(`📤 [JAdapter:rpc] submitTx type=${jTx.type} entity=${jTx.entityId.slice(-4)}`);

      if (jTx.type === 'batch') {
        const { encodeJBatch, computeBatchHankoHash, isBatchEmpty, getBatchSize } = await import('../j-batch');
        const { normalizeEntityId } = await import('../entity-id-utils');
        const batchData = jTx.data;
        const batch = batchData.batch;
        const effectiveTimestamp = typeof timestamp === 'number' ? timestamp : env.timestamp;

        if (isBatchEmpty(batch)) {
          console.log(`📦 [JAdapter:rpc] Empty batch, skipping`);
          return { success: true };
        }

        const normalizedId = normalizeEntityId(jTx.entityId);
        const preflightIssues = preflightBatchForE2(
          normalizedId,
          batch,
          Math.floor(Number(effectiveTimestamp) / 1000),
        );
        if (preflightIssues.length > 0) {
          console.warn(
            `⚠️ [JAdapter:rpc] batch preflight issues (${normalizedId.slice(-4)}): ${preflightIssues.join(' | ')}`,
          );
        }

        // Validate settlement signatures + entityProvider
        for (const settlement of batch.settlements) {
          if (!settlement.entityProvider || settlement.entityProvider === '0x0000000000000000000000000000000000000000') {
            settlement.entityProvider = await getLiveEntityProviderAddress();
          }
          if (settlement.diffs.length > 0 && settlement.sig === '0x') {
            return { success: false, error: `Settlement missing hanko sig` };
          }
        }

        return runSerializedBatch(async () => {
          const entityProviderAddr = await getLiveEntityProviderAddress();
          const depositoryAddr = await getLiveDepositoryAddress();
          const batchRequiresExternalSubmitter = batch.externalTokenToReserve.length > 0;
          const externalSubmitterWallet = batchRequiresExternalSubmitter
            ? (() => {
                if (!signerPrivateKey) {
                  throw new Error(`Missing signer private key for externalTokenToReserve batch from ${jTx.entityId.slice(-4)}`);
                }
                return new ethers.Wallet(`0x${Buffer.from(signerPrivateKey).toString('hex')}`, provider);
              })()
            : null;
          const submitterDepository = externalSubmitterWallet ? depository.connect(externalSubmitterWallet) : depository;
          // Use pre-provided encoded batch + hanko (from entity consensus) or sign locally
          let encodedBatch: string;
          let hankoData: string;
          let nextNonce: bigint;

          if (
            batchData.hankoSignature &&
            batchData.encodedBatch &&
            typeof batchData.entityNonce === 'number'
          ) {
            // Entity consensus already signed — use pre-provided hanko
            encodedBatch = batchData.encodedBatch;
            hankoData = batchData.hankoSignature;
            nextNonce = BigInt(batchData.entityNonce);
            console.log(`🔐 [JAdapter:rpc] Using consensus hanko: nonce=${nextNonce}`);
          } else {
            // Fallback: single-signer sign locally
            const sid = signerId || batchData.signerId;
            if (!sid) {
              return { success: false, error: `Missing signerId for batch from ${jTx.entityId.slice(-4)}` };
            }
            if (!depository || !depositoryAddr) {
              return {
                success: false,
                error:
                  `RPC_ADAPTER_NOT_CONNECTED:${normalizedId.slice(-4)}` +
                  ` depository=${depositoryAddr || 'none'}` +
                  ` entityProvider=${entityProviderAddr || 'none'}` +
                  ` hasDepository=${depository ? 1 : 0}` +
                  ` hasEntityProvider=${entityProvider ? 1 : 0}`,
              };
            }

            encodedBatch = encodeJBatch(batch);
            const currentNonce = await depository.entityNonces(normalizedId);
            nextNonce = BigInt(currentNonce) + 1n;
            const batchHash = computeBatchHankoHash(BigInt(config.chainId), depositoryAddr, encodedBatch, nextNonce);

            console.log(`🔐 [JAdapter:rpc] Local signing: entity=${normalizedId.slice(-4)} nonce=${nextNonce}`);
            const { signHashesAsSingleEntity } = await import('../hanko/signing');
            const hankos = await signHashesAsSingleEntity(env, normalizedId, sid, [batchHash]);
            hankoData = hankos[0]!;
            if (!hankoData) {
              return { success: false, error: 'Failed to build batch hanko signature' };
            }
          }

          let disputeStartDebug: Array<Record<string, unknown>> = [];
          if (batch.disputeStarts.length > 0) {
            const { inspectHankoForHash } = await import('../hanko/signing');
            disputeStartDebug = await Promise.all(batch.disputeStarts.map(async (start) => {
              const accountKey = computeAccountKey(normalizedId, start.counterentity);
              const disputeHash = ethers.keccak256(
                ethers.AbiCoder.defaultAbiCoder().encode(
                  ['uint8', 'address', 'bytes', 'uint256', 'bytes32'],
                  [1, depositoryAddr, accountKey, BigInt(start.nonce), start.proofbodyHash],
                ),
              );
              const hankoDebug = await inspectHankoForHash(start.sig, disputeHash);
              const matchingClaim = hankoDebug.claims.find(
                (claim) => String(claim.entityId).toLowerCase() === String(start.counterentity).toLowerCase(),
              );
              return {
                contractGuard: 'EntityProvider.sol:469 require(entityId == boardHash)',
                senderEntityId: normalizedId,
                counterentity: start.counterentity,
                nonce: start.nonce,
                proofbodyHash: start.proofbodyHash,
                initialArgumentsBytes: Math.max(start.initialArguments.length - 2, 0) / 2,
                disputeHash,
                accountKey,
                sigBytes: Math.max(start.sig.length - 2, 0) / 2,
                recoveredAddresses: hankoDebug.recoveredAddresses,
                matchingClaim: matchingClaim
                  ? {
                      entityId: matchingClaim.entityId,
                      threshold: matchingClaim.threshold,
                      entityIndexes: matchingClaim.entityIndexes,
                      weights: matchingClaim.weights,
                      boardEntityIds: matchingClaim.boardEntityIds,
                      reconstructedBoardHash: matchingClaim.reconstructedBoardHash,
                      entityMatchesBoardHash:
                        String(matchingClaim.entityId).toLowerCase() ===
                        String(matchingClaim.reconstructedBoardHash).toLowerCase(),
                    }
                  : null,
              };
            }));
            console.log(`🧾 [JAdapter:rpc] disputeStart.batch ${JSON.stringify(disputeStartDebug)}`);
          }

          try {
            console.log(`📦 [JAdapter:rpc] processBatch (${getBatchSize(batch)} ops) nonce=${nextNonce}`);
            if (externalSubmitterWallet) {
              for (const op of batch.externalTokenToReserve) {
                const tokenContract = new ethers.Contract(op.contractAddress, [
                  'function allowance(address owner, address spender) view returns (uint256)',
                  'function approve(address spender, uint256 amount) returns (bool)',
                ], externalSubmitterWallet);
                const tokenOwner = externalSubmitterWallet.address;
                const allowanceFn = tokenContract.getFunction('allowance') as (owner: string, spender: string) => Promise<bigint>;
                const approveFn = tokenContract.getFunction('approve') as (
                  spender: string,
                  amount: bigint,
                  overrides?: Record<string, bigint | number>
                ) => Promise<{ wait: (confirms?: number, timeout?: number) => Promise<unknown>; hash: string }>;
                const currentAllowance = await allowanceFn(tokenOwner, depositoryAddr);
                if (currentAllowance >= op.amount) continue;
                let nextExternalNonce = await provider.getTransactionCount(tokenOwner, 'pending');
                if (currentAllowance > 0n) {
                  const clearTx = await approveFn(depositoryAddr, 0n, {
                    ...(await buildFeeOverrides()),
                    nonce: nextExternalNonce,
                  });
                  nextExternalNonce += 1;
                  await waitForReceipt(clearTx, 'erc20ApproveReset');
                }
                const approveTx = await approveFn(depositoryAddr, op.amount, {
                  ...(await buildFeeOverrides()),
                  nonce: nextExternalNonce,
                });
                await waitForReceipt(approveTx, 'erc20ApproveExact');
              }
            }
            const gasLimit = await estimateGasWithHeadroom(
              () => submitterDepository.processBatch.estimateGas(encodedBatch, hankoData, nextNonce),
              DEFAULT_PROCESS_BATCH_GAS,
            );
            const resolvedFeeOverrides = await buildFeeOverrides();
            const requestedFeeOverrides = batchData.feeOverrides;
            if (requestedFeeOverrides?.maxFeePerGasWei) {
              resolvedFeeOverrides.maxFeePerGas = BigInt(requestedFeeOverrides.maxFeePerGasWei);
            }
            if (requestedFeeOverrides?.maxPriorityFeePerGasWei) {
              resolvedFeeOverrides.maxPriorityFeePerGas = BigInt(requestedFeeOverrides.maxPriorityFeePerGasWei);
            }
            if (requestedFeeOverrides?.gasBumpBps && requestedFeeOverrides.gasBumpBps > 0) {
              const bumpBps = BigInt(Math.floor(requestedFeeOverrides.gasBumpBps));
              const factor = 10_000n + bumpBps;
              if (resolvedFeeOverrides.maxFeePerGas) {
                resolvedFeeOverrides.maxFeePerGas = (resolvedFeeOverrides.maxFeePerGas * factor + 9_999n) / 10_000n;
              }
              if (resolvedFeeOverrides.maxPriorityFeePerGas) {
                resolvedFeeOverrides.maxPriorityFeePerGas =
                  (resolvedFeeOverrides.maxPriorityFeePerGas * factor + 9_999n) / 10_000n;
              }
            }

            // Pre-flight: staticCall to decode revert reason before sending real tx
            try {
              await submitterDepository.processBatch.staticCall(encodedBatch, hankoData, nextNonce, {
                gasLimit,
              });
            } catch (simErr: unknown) {
              // Decode revert data using contract ABI (typechain-connected interface).
              const revertSource =
                typeof simErr === 'object' && simErr !== null
                  ? simErr as {
                      data?: unknown;
                      error?: { data?: unknown };
                      info?: { error?: { data?: unknown } };
                      reason?: unknown;
                      message?: unknown;
                    }
                  : null;
              const revertData = revertSource?.data ?? revertSource?.error?.data ?? revertSource?.info?.error?.data;
              let errDetail = '';
              if (revertData && revertData !== '0x') {
                const sig = typeof revertData === 'string' ? revertData.slice(0, 10) : '';
                let errName = `unknown(${sig})`;
                let decoded = '';
                if (typeof revertData === 'string') {
                  try {
                    const parsedError = depository.interface.parseError(revertData);
                    if (parsedError) {
                      const args = Array.from(parsedError.args ?? []);
                      const argStr = args.length > 0 ? ` args=${JSON.stringify(args.map((v) => String(v)))}` : '';
                      errName = `${parsedError.name}()`;
                      decoded = argStr;
                    }
                  } catch {
                    // fall through to standard Error(string)/Panic decoding below
                  }
                }
                // Decode Error(string) if present
                if (sig === '0x08c379a0' && typeof revertData === 'string') {
                  try {
                    const reason = ethers.AbiCoder.defaultAbiCoder().decode(['string'], '0x' + revertData.slice(10));
                    decoded = ` reason="${reason[0]}"`;
                  } catch { }
                } else if (sig === '0x4e487b71' && typeof revertData === 'string') {
                  try {
                    const [panicCode] = ethers.AbiCoder.defaultAbiCoder().decode(['uint256'], '0x' + revertData.slice(10));
                    decoded = ` panic=0x${BigInt(panicCode).toString(16)}`;
                  } catch { }
                }
                errDetail = `${errName}${decoded}`;
                console.error(`🔍 [JAdapter:rpc] staticCall revert: ${errDetail} data=${typeof revertData === 'string' ? revertData.slice(0, 40) : revertData}...`);
              } else {
                errDetail = String(revertSource?.reason ?? revertSource?.message ?? simErr);
                console.error(`🔍 [JAdapter:rpc] staticCall revert: ${errDetail}`);
              }
              if (disputeStartDebug.length > 0) {
                console.error(`🧾 [JAdapter:rpc] disputeStart.batch.revert ${JSON.stringify(disputeStartDebug)}`);
              }
              // Bail — do NOT submit a known-bad batch on-chain
              return { success: false, error: `staticCall revert: ${errDetail}` };
            }

            for (let attempt = 1; attempt <= 2; attempt++) {
              try {
                if (attempt > 1) {
                  await resetSerializedSignerNonce();
                  console.warn(`⚠️ [JAdapter:rpc] retrying processBatch after nonce sync (attempt ${attempt}/2)`);
                }
                const tx = externalSubmitterWallet
                  ? await submitterDepository.processBatch(encodedBatch, hankoData, nextNonce, {
                      gasLimit,
                      nonce: await provider.getTransactionCount(externalSubmitterWallet.address, 'pending'),
                      ...resolvedFeeOverrides,
                    })
                  : await depository.processBatch(encodedBatch, hankoData, nextNonce, {
                      gasLimit,
                      nonce: await allocateSerializedSignerNonce(),
                      ...resolvedFeeOverrides,
                    });
                const minedReceipt = await waitForReceipt(tx, 'submitTx:processBatch');
                const txHash = minedReceipt.hash ?? tx.hash;
                const blockNum = minedReceipt.blockNumber ?? 0;
                console.log(`✅ [JAdapter:rpc] Batch executed: block=${blockNum} gas=${minedReceipt.gasUsed}`);
                return { success: true, txHash, blockNumber: blockNum };
              } catch (error) {
                if (attempt < 2 && isNonceSyncError(error)) {
                  continue;
                }
                await resetSerializedSignerNonce();
                const msg = error instanceof Error ? error.message : String(error);
                console.error(`❌ [JAdapter:rpc] processBatch failed: ${msg}`);
                return { success: false, error: msg };
              }
            }
            return { success: false, error: 'processBatch failed after nonce retry' };
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error(`❌ [JAdapter:rpc] processBatch failed: ${msg}`);
            return { success: false, error: msg };
          }
        });
      }

      if (jTx.type === 'mint') {
        const entityId = String(jTx.data.entityId || jTx.entityId || '');
        const tokenId = Number(jTx.data.tokenId);
        const amount = jTx.data.amount;
        if (!entityId || !Number.isFinite(tokenId) || amount <= 0n) {
          return { success: false, error: 'Invalid mint payload' };
        }
        if (!DEV_CHAIN_IDS.has(config.chainId)) {
          console.warn(`⚠️ [JAdapter:rpc] Mint only allowed on configured dev chains`);
          return { success: false, error: 'Mint not supported on non-dev RPC chains' };
        }
        try {
          const events = await adapter.debugFundReserves(entityId, tokenId, amount);
          const blockNumber = events[events.length - 1]?.blockNumber;
          console.log(`✅ [JAdapter:rpc] Minted ${amount} token=${tokenId} to ${entityId.slice(-4)}`);
          return { success: true, events, ...(typeof blockNumber === 'number' ? { blockNumber } : {}) };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.error(`❌ [JAdapter:rpc] Mint failed: ${msg}`);
          return { success: false, error: msg };
        }
      }

      const unhandledType: never = jTx;
      return { success: false, error: `Unknown JTx type: ${String(unhandledType)}` };
    },

    // === J-Watcher integration (RPC polling — uses shared event conversion from helpers.ts) ===
    startWatching(env: Env): void {
      if (watcherInterval) {
        console.log(`🔭 [JAdapter:rpc] Already watching`);
        return;
      }
      watcherEnv = env;
      txCounter.value = 0;
      txCounter._seenLogs = { set: new Set<string>(), order: [] as string[] };
      const watchPollMs = resolveWatcherPollMs(!!env?.scenarioMode);
      const confirmationDepth = resolveFinalityDepth(!!env?.scenarioMode);
      const startBlock = getWatcherStartBlock(env, addresses.depository);
      lastSyncedBlock = Math.max(0, startBlock - 1);
      console.log(
        `🔭 [JAdapter:rpc] Starting event watcher (${watchPollMs}ms polling, depth=${confirmationDepth}, fromBlock=${startBlock})...`,
      );

      // Depository ABI for queryFilter — must match CANONICAL_J_EVENTS
      const depositoryABI = [
        'event ReserveUpdated(bytes32 indexed entity, uint256 indexed tokenId, uint256 newBalance)',
        'event SecretRevealed(bytes32 indexed hashlock, bytes32 indexed revealer, bytes32 secret)',
        'event AccountSettled(tuple(bytes32 left, bytes32 right, tuple(uint256 tokenId, uint256 leftReserve, uint256 rightReserve, uint256 collateral, int256 ondelta)[] tokens, uint256 nonce)[] settled)',
        'event DisputeStarted(bytes32 indexed sender, bytes32 indexed counterentity, uint256 indexed nonce, bytes32 proofbodyHash, bytes initialArguments)',
        'event DisputeFinalized(bytes32 indexed sender, bytes32 indexed counterentity, uint256 indexed initialNonce, bytes32 initialProofbodyHash, bytes32 finalProofbodyHash)',
        'event DebtCreated(bytes32 indexed debtor, bytes32 indexed creditor, uint256 indexed tokenId, uint256 amount, uint256 debtIndex)',
        'event DebtEnforced(bytes32 indexed debtor, bytes32 indexed creditor, uint256 indexed tokenId, uint256 amountPaid, uint256 remainingAmount, uint256 newDebtIndex)',
        'event DebtForgiven(bytes32 indexed debtor, bytes32 indexed creditor, uint256 indexed tokenId, uint256 amountForgiven, uint256 debtIndex)',
        'event HankoBatchProcessed(bytes32 indexed entityId, bytes32 indexed hankoHash, uint256 nonce, bool success)',
      ];
      const depositoryIface = new ethers.Interface(depositoryABI);

      const emitWatcherDebug = (payload: Record<string, unknown>) => {
        const p2p = watcherEnv?.runtimeState?.p2p;
        if (isDebugEventEmitter(p2p)) {
          p2p.sendDebugEvent({
            level: 'info',
            code: 'J_WATCH_RPC',
            ...payload,
          });
        }
      };

      const doPoll = (): Promise<void> => {
        if (!watcherEnv) return Promise.resolve();
        if (pollInFlight) return pollInFlight;
        pollInFlight = (async () => {
          const activeEnv = watcherEnv;
          if (!activeEnv) return;
          const currentBlock = parseInt(await (provider as ethers.JsonRpcProvider).send('eth_blockNumber', []), 16);
          const safeToBlock = currentBlock - confirmationDepth;
          if (safeToBlock <= 0) return;
          if (lastSyncedBlock >= safeToBlock) return;

          const fromBlock = lastSyncedBlock + 1;
          updateWatcherJurisdictionCursor(activeEnv, safeToBlock, addresses.depository);
          const filter = { address: await getLiveDepositoryAddress(), fromBlock, toBlock: safeToBlock };
          const logs = await provider.getLogs(filter);

          if (logs.length > 0) {
            const rawEvents: RawJEvent[] = [];
            for (const log of logs) {
              try {
                const parsed = depositoryIface.parseLog({ topics: log.topics as string[], data: log.data });
                if (!parsed) continue;
                if (!CANONICAL_J_EVENTS.some(name => name === parsed.name)) continue;
                // Extract named args from ethers v6 Result (array-like, named keys
                // not enumerable via Object.keys). Use positional fallback for unnamed params.
                const args: RawJEventArgs = {};
                for (let idx = 0; idx < parsed.fragment.inputs.length; idx++) {
                  const input = parsed.fragment.inputs[idx];
                  const key = input.name || String(idx);
                  args[key] = parsed.args[idx]; // Use positional index (always works)
                  if (input.name) args[input.name] = parsed.args[idx];
                }
                rawEvents.push({
                  name: parsed.name,
                  args,
                  blockNumber: log.blockNumber,
                  blockHash: log.blockHash,
                  transactionHash: log.transactionHash,
                  logIndex: log.index,
                });
              } catch {
                // Skip unparseable logs
              }
            }

            if (rawEvents.length > 0) {
              const eventCounts: Record<string, number> = {};
              for (const e of rawEvents) {
                eventCounts[e.name] = (eventCounts[e.name] || 0) + 1;
              }

              const byBlock = new Map<number, RawJEvent[]>();
              for (const e of rawEvents) {
                const bn = e.blockNumber ?? 0;
                if (!byBlock.has(bn)) byBlock.set(bn, []);
                byBlock.get(bn)!.push(e);
              }
              for (const [blockNum, events] of byBlock) {
                const blockHash = events[0]?.blockHash ?? '0x0';
                processEventBatch(events, activeEnv, blockNum, blockHash, txCounter, 'rpc');
              }

              emitWatcherDebug({
                event: 'j_watch_batch',
                fromBlock,
                toBlock: safeToBlock,
                chainTip: currentBlock,
                confirmationDepth,
                blockCount: byBlock.size,
                rawEventCount: rawEvents.length,
                eventCounts,
              });
            }
            lastSyncedBlock = safeToBlock;
            return;
          }

          // Do not permanently skip a single just-mined tail block on an empty poll.
          // Some RPC backends briefly return no logs for the newest block even after the
          // receipt is available. If we advance lastSyncedBlock here, that block is lost
          // forever and the runtime never sees its J-events.
          if (fromBlock === safeToBlock) {
            return;
          }

          lastSyncedBlock = safeToBlock;
        })().catch((error: unknown) => {
          emitWatcherDebug({
            event: 'j_watch_error',
            message: error instanceof Error ? error.message : String(error),
            lastSyncedBlock,
          });
          if (!(error instanceof Error && error.message.includes('ECONNREFUSED'))) {
            console.error(`🔭❌ [JAdapter:rpc] Sync error:`, error instanceof Error ? error.message : String(error));
          }
        }).finally(() => {
          pollInFlight = null;
        });
        return pollInFlight;
      };

      pollNowHandler = doPoll;
      watcherInterval = setInterval(() => {
        void doPoll();
      }, watchPollMs);
      void doPoll();

      console.log(`🔭 [JAdapter:rpc] Watcher started (${watchPollMs}ms polling)`);
    },

    async pollNow(): Promise<void> {
      const fn = pollNowHandler;
      if (fn) await fn();
    },

    stopWatching(): void {
      if (watcherInterval) {
        clearInterval(watcherInterval);
        watcherInterval = null;
        watcherEnv = null;
        pollInFlight = null;
        pollNowHandler = null;
        console.log(`🔭 [JAdapter:rpc] Watcher stopped`);
      }
    },

    getBrowserVM(): BrowserVMProvider | null {
      return null;
    },

    setBlockTimestamp(_timestamp: number): void {
      // RPC mode follows chain timestamps from mined blocks; runtime logical time is separate.
    },

    setQuietLogs(_quiet: boolean): void {
      // no-op in RPC mode
    },

    registerEntityWallet(_entityId: string, _privateKey: string): void {
      // no-op in RPC mode
    },

    async captureStateRoot(): Promise<Uint8Array | null> {
      return null;
    },

    async syncRuntimeState(): Promise<null> {
      return null;
    },

    async close(): Promise<void> {
      adapter.stopWatching();
      depository?.removeAllListeners();
      entityProvider?.removeAllListeners();
    },
  };

  // Watcher state
  let watcherInterval: ReturnType<typeof setInterval> | null = null;
  let watcherEnv: Env | null = null;
  let pollInFlight: Promise<void> | null = null;
  let pollNowHandler: (() => Promise<void>) | null = null;
  let lastSyncedBlock = 0;
  const txCounter: EventBatchCounter = { value: 0 };

  trace('return adapter');
  return adapter;
}

// Alias for backward compatibility
export const createAnvilAdapter = createRpcAdapter;

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
import type { Provider, Signer } from 'ethers';

import { Account__factory } from '../../jurisdictions/typechain-types/factories/Account__factory';
import type { Account, Depository, EntityProvider, DeltaTransformer } from '../../jurisdictions/typechain-types';
import { Depository__factory, EntityProvider__factory, DeltaTransformer__factory, ERC20Mock__factory } from '../../jurisdictions/typechain-types';

import type { BrowserVMState, JTx } from '../types';
import type { JAdapter, JAdapterAddresses, JAdapterConfig, JEvent, JEventCallback, JSubmitResult, SnapshotId, JBatchReceipt, JTxReceipt, SettlementDiff, BrowserVMProvider, JTokenInfo } from './types';
import { computeAccountKey, entityIdToAddress, setupContractEventListeners, processEventBatch, type RawJEvent } from './helpers';
import { CANONICAL_J_EVENTS } from './helpers';
import { DEV_CHAIN_IDS } from './index';

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
  const PROD_WATCH_POLL_MS = 3000;
  const TEST_WATCH_POLL_MS = (() => {
    const raw = Number(process.env.JADAPTER_TEST_WATCH_POLL_MS ?? '100');
    if (!Number.isFinite(raw)) return 100;
    return Math.max(25, Math.floor(raw));
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

  const rpcChainId = Number((await provider.getNetwork()).chainId);
  if (rpcChainId !== Number(config.chainId)) {
    throw new Error(
      `[JAdapter:rpc] chainId mismatch: config=${config.chainId} rpc=${rpcChainId}. Refusing to sign/submit.`,
    );
  }

  const applyGasHeadroom = (value: bigint): bigint =>
    (value * BigInt(GAS_HEADROOM_BPS) + 9_999n) / 10_000n;

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

  const waitForReceipt = async (tx: { wait: (confirms?: number, timeout?: number) => Promise<any>; hash: string }, label: string) => {
    const receipt = await tx.wait(TX_WAIT_CONFIRMS, TX_WAIT_TIMEOUT_MS);
    if (!receipt) {
      throw new Error(`${label} transaction not mined (hash=${tx.hash})`);
    }
    return receipt;
  };

  const estimateGasWithHeadroom = async (estimate: () => Promise<bigint>, fallback: bigint): Promise<bigint> => {
    try {
      return applyGasHeadroom(await estimate());
    } catch {
      return fallback;
    }
  };

  const resolveWatcherPollMs = (scenarioMode: boolean): number => {
    if (scenarioMode) return TEST_WATCH_POLL_MS;
    if (config.watchPollMs && Number.isFinite(config.watchPollMs)) {
      return Math.max(200, Math.floor(config.watchPollMs));
    }
    if (config.chainId === 1) return PROD_WATCH_POLL_MS;
    if (DEV_CHAIN_IDS.has(config.chainId)) return 1000;
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

  // One signer submits all on-chain txs for this adapter, so queue must be global,
  // not per-entity, to avoid EOA nonce races across concurrent entity batches.
  let batchSubmitQueue: Promise<unknown> = Promise.resolve();
  const runSerializedBatch = async <T>(work: () => Promise<T>): Promise<T> => {
    const previous = batchSubmitQueue;
    const next = previous
      .catch(() => undefined)
      .then(work);
    batchSubmitQueue = next.finally(() => {
      if (batchSubmitQueue === next) {
        batchSubmitQueue = Promise.resolve();
      }
    });
    return next;
  };

  const maybeResetSignerNonce = (): void => {
    const signerAny = signer as any;
    if (typeof signerAny?.resetNonce === 'function') {
      try {
        signerAny.resetNonce();
      } catch {
        // Best-effort only.
      }
    }
  };

  const isNonceSyncError = (error: unknown): boolean => {
    const msg = String((error as any)?.message || error || '').toLowerCase();
    return (
      msg.includes('nonce too low') ||
      msg.includes('nonce has already been used') ||
      msg.includes('nonce expired') ||
      msg.includes('code=nonce_expired')
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
    addresses.account = config.fromReplica.contracts?.account ?? '';
    addresses.depository = config.fromReplica.depositoryAddress ?? config.fromReplica.contracts?.depository ?? '';
    addresses.entityProvider = config.fromReplica.entityProviderAddress ?? config.fromReplica.contracts?.entityProvider ?? '';
    addresses.deltaTransformer = config.fromReplica.contracts?.deltaTransformer ?? '';

    console.log('[JAdapter:rpc] fromReplica mode - connecting to contracts:');
    console.log('  Account:', addresses.account);
    console.log('  Depository:', addresses.depository);
    console.log('  EntityProvider:', addresses.entityProvider);
    console.log('  DeltaTransformer:', addresses.deltaTransformer);

    if (!addresses.depository || !addresses.entityProvider) {
      throw new Error('fromReplica: Missing required addresses (depository or entityProvider)');
    }

    const [depCode, epCode] = await Promise.all([
      provider.getCode(addresses.depository),
      provider.getCode(addresses.entityProvider),
    ]);

    if (depCode === '0x' || epCode === '0x') {
      console.warn('[JAdapter:rpc] fromReplica addresses have no code on chain - redeploying');
      addresses.account = '';
      addresses.depository = '';
      addresses.entityProvider = '';
      addresses.deltaTransformer = '';
    } else {
      // Use any cast to handle ethers version mismatch between root and jurisdictions
      if (!addresses.account) {
        console.warn('[JAdapter:rpc] fromReplica missing Account address - using zero address placeholder');
        addresses.account = ethers.ZeroAddress;
      }
      if (!addresses.deltaTransformer) {
        console.warn('[JAdapter:rpc] fromReplica missing DeltaTransformer address - using zero address placeholder');
        addresses.deltaTransformer = ethers.ZeroAddress;
      }
      account = Account__factory.connect(addresses.account, signer as any);
      depository = Depository__factory.connect(addresses.depository, signer as any);
      entityProvider = EntityProvider__factory.connect(addresses.entityProvider, signer as any);
      deltaTransformer = DeltaTransformer__factory.connect(addresses.deltaTransformer, signer as any);
      deployed = true;
      console.log('[JAdapter:rpc] Connected to existing contracts ✓');
    }
  }

  const eventCallbacks = new Map<string, Set<JEventCallback>>();
  const anyCallbacks = new Set<JEventCallback>();

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
        setupContractEventListeners(depository, entityProvider, eventCallbacks, anyCallbacks);
        return;
      }

      console.log('[JAdapter:rpc] Deploying stack...');

      // Deploy Account library
      // Use any cast to handle ethers version mismatch between root and jurisdictions
      const accountFactory = new Account__factory(signer as any);
      const accountContract = await accountFactory.deploy();
      await accountContract.waitForDeployment();
      addresses.account = await accountContract.getAddress();
      account = accountContract;
      console.log(`  Account: ${addresses.account}`);

      // Deploy EntityProvider
      const entityProviderFactory = new EntityProvider__factory(signer as any);
      const entityProviderContract = await entityProviderFactory.deploy();
      await entityProviderContract.waitForDeployment();
      addresses.entityProvider = await entityProviderContract.getAddress();
      entityProvider = entityProviderContract;
      console.log(`  EntityProvider: ${addresses.entityProvider}`);

      // Deploy Depository (needs Account library linked)
      const depositoryFactory = new Depository__factory(
        { 'contracts/Account.sol:Account': addresses.account },
        signer as any
      );
      // Use block gas limit minus margin (anvil default is 30M)
      let deployGasLimit = 30_000_000n;
      try {
        const latestBlock = await provider.getBlock('latest');
        if (latestBlock?.gasLimit) {
          const margin = 1_000_000n;
          deployGasLimit = latestBlock.gasLimit > margin ? latestBlock.gasLimit - margin : latestBlock.gasLimit;
        }
      } catch {
        // Fallback to 30M if provider can't fetch block gas limit
      }
      const depositoryContract = await depositoryFactory.deploy(addresses.entityProvider, {
        gasLimit: deployGasLimit,
      });
      await depositoryContract.waitForDeployment();
      addresses.depository = await depositoryContract.getAddress();
      depository = depositoryContract;
      console.log(`  Depository: ${addresses.depository}`);

      // Deploy DeltaTransformer
      const deltaTransformerFactory = new DeltaTransformer__factory(signer as any);
      const deltaTransformerContract = await deltaTransformerFactory.deploy();
      await deltaTransformerContract.waitForDeployment();
      addresses.deltaTransformer = await deltaTransformerContract.getAddress();
      deltaTransformer = deltaTransformerContract;
      console.log(`  DeltaTransformer: ${addresses.deltaTransformer}`);

      // Deploy bootstrap ERC20 test token (5th contract in local anvil stack)
      const erc20Factory = new ERC20Mock__factory(signer as any);
      const erc20Contract = await erc20Factory.deploy('USD Coin', 'USDC', ethers.parseUnits('10000000000', 18));
      await erc20Contract.waitForDeployment();
      const erc20Address = await erc20Contract.getAddress();
      console.log(`  ERC20Mock(USDC): ${erc20Address}`);

      // Register token in Depository token registry (tokenId > 0)
      const tokenRegistrationAmount = 1_000_000n;
      const approveTx = await erc20Contract.approve(addresses.depository, tokenRegistrationAmount, await buildFeeOverrides());
      await waitForReceipt(approveTx as any, 'erc20.approve');
      const registerTx = await depository.externalTokenToReserve({
        entity: ethers.ZeroHash,
        contractAddress: erc20Address,
        externalTokenId: 0,
        tokenType: 0,
        internalTokenId: 0,
        amount: tokenRegistrationAmount,
      }, await buildFeeOverrides());
      await waitForReceipt(registerTx as any, 'depository.externalTokenToReserve');
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
      return depository.entityNonces(entityIdToAddress(entityId));
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
      const gasLimit = await estimateGasWithHeadroom(
        () => depository.processBatch.estimateGas(encodedBatch, addresses.entityProvider, hankoData, nonce),
        DEFAULT_PROCESS_BATCH_GAS,
      );
      const feeOverrides = await buildFeeOverrides();
      maybeResetSignerNonce();
      const tx = await depository.processBatch(encodedBatch, addresses.entityProvider, hankoData, nonce, {
        gasLimit,
        ...feeOverrides,
      });
      const receipt = await waitForReceipt(tx as any, 'processBatch');

      // Parse events from receipt
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
        } catch {
          // Try parsing as EntityProvider event
          try {
            const parsed = entityProvider.interface.parseLog(log);
            if (parsed) {
              events.push({
                name: parsed.name,
                args: Object.fromEntries(
                  parsed.fragment.inputs.map((input, i) => [input.name, parsed.args[i]])
                ),
                blockNumber: receipt.blockNumber,
                blockHash: receipt.blockHash,
                transactionHash: receipt.hash,
              });
            }
          } catch {
            // Unparseable log, skip
          }
        }
      }

      return {
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        events,
      };
    },

    async settle(
      leftEntity: string,
      rightEntity: string,
      diffs: SettlementDiff[],
      forgiveDebtsInTokenIds: number[] = [],
      sig?: string
    ): Promise<JTxReceipt> {
      const hasChanges = diffs.length > 0 || forgiveDebtsInTokenIds.length > 0;
      if (hasChanges && (!sig || sig === '0x')) {
        throw new Error('Settlement signature required');
      }
      const finalSig = sig || '0x';

      // Ensure ondeltaDiff is set (default to 0n if not provided)
      const normalizedDiffs = diffs.map(d => ({
        tokenId: d.tokenId,
        leftDiff: d.leftDiff,
        rightDiff: d.rightDiff,
        collateralDiff: d.collateralDiff,
        ondeltaDiff: d.ondeltaDiff ?? 0n,
      }));

      const tx = await depository.settle(
        leftEntity,
        rightEntity,
        normalizedDiffs,
        forgiveDebtsInTokenIds,
        finalSig,
        {
          gasLimit: await estimateGasWithHeadroom(
            () => depository.settle.estimateGas(
              leftEntity,
              rightEntity,
              normalizedDiffs,
              forgiveDebtsInTokenIds,
              finalSig,
            ),
            DEFAULT_SETTLE_GAS,
          ),
          ...(await buildFeeOverrides()),
        },
      );
      const receipt = await waitForReceipt(tx as any, 'settle');

      return {
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
      };
    },

    async registerNumberedEntity(boardHash: string): Promise<{ entityNumber: number; txHash: string }> {
      const tx = await entityProvider.registerNumberedEntity(boardHash, await buildFeeOverrides());
      const receipt = await waitForReceipt(tx as any, 'registerNumberedEntity');

      // Find EntityRegistered event
      for (const log of receipt.logs) {
        try {
          const parsed = entityProvider.interface.parseLog(log);
          if (parsed?.name === 'EntityRegistered') {
            return {
              entityNumber: Number(parsed.args[1]),
              txHash: receipt.hash,
            };
          }
        } catch {
          // Not our event
        }
      }
      throw new Error('EntityRegistered event not found');
    },

    async registerNumberedEntitiesBatch(boardHashes: string[]): Promise<{ entityNumbers: number[]; txHash: string }> {
      const tx = await entityProvider.registerNumberedEntitiesBatch(boardHashes, await buildFeeOverrides());
      const receipt = await waitForReceipt(tx as any, 'registerNumberedEntitiesBatch');

      // Extract all EntityRegistered events
      const entityNumbers: number[] = [];
      for (const log of receipt.logs) {
        try {
          const parsed = entityProvider.interface.parseLog(log);
          if (parsed?.name === 'EntityRegistered') {
            entityNumbers.push(Number(parsed.args[1]));
          }
        } catch {
          // Not our event
        }
      }

      return {
        entityNumbers,
        txHash: receipt.hash,
      };
    },

    async getNextEntityNumber(): Promise<number> {
      return Number(await entityProvider.nextNumber());
    },

    async debugFundReserves(entityId: string, tokenId: number, amount: bigint): Promise<JEvent[]> {
      // For dev chains (anvil), allow debug funding for testnet
      if (DEV_CHAIN_IDS.has(config.chainId)) {
        // Use mintToReserve (renamed from debugFundReserves in Depository contract)
        const tx = await depository.mintToReserve(entityId, tokenId, amount, await buildFeeOverrides());
        const receipt = await waitForReceipt(tx as any, 'mintToReserve');

        const events: JEvent[] = [];
        for (const log of receipt.logs) {
          try {
            const parsed = depository.interface.parseLog({ topics: log.topics as string[], data: log.data });
            if (parsed) {
              events.push({
                name: parsed.name,
                args: Object.fromEntries(Object.entries(parsed.args)),
                blockNumber: receipt.blockNumber,
                blockHash: receipt.blockHash,
                transactionHash: receipt.hash,
              });
            }
          } catch { }
        }
        return events;
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

    async reserveToReserve(from: string, to: string, tokenId: number, amount: bigint): Promise<JEvent[]> {
      const tx = await depository.reserveToReserve(from, to, tokenId, amount, await buildFeeOverrides());
      const receipt = await waitForReceipt(tx as any, 'reserveToReserve');

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
        } catch {
          // Skip
        }
      }
      return events;
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
      // Create wallet from private key (use NonceManager to avoid nonce races)
      const signerWallet = new ethers.Wallet(
        '0x' + Buffer.from(signerPrivateKey).toString('hex'),
        provider
      );
      const managedSigner = new ethers.NonceManager(signerWallet);

      const tokenType = options?.tokenType ?? 0;
      const externalTokenIdRaw = options?.externalTokenId ?? 0n;
      const externalTokenId = typeof externalTokenIdRaw === 'bigint' ? externalTokenIdRaw : BigInt(externalTokenIdRaw);
      const internalTokenId = options?.internalTokenId ?? 0;

      if (tokenType !== 0) {
        throw new Error('RPC adapter externalTokenToReserve currently supports ERC20 only');
      }

      const erc20 = new ethers.Contract(tokenAddress, [
        'function approve(address spender, uint256 amount) returns (bool)',
        'function allowance(address owner, address spender) view returns (uint256)',
      ], managedSigner);

      // Step 1: Approve Depository to spend tokens (max allowance for smoother UX)
      const allowanceFn = erc20.getFunction('allowance') as (owner: string, spender: string) => Promise<bigint>;
      const approveFn = erc20.getFunction('approve') as (
        spender: string,
        amount: bigint,
        overrides?: Record<string, bigint>
      ) => Promise<{ wait: (confirms?: number, timeout?: number) => Promise<unknown>; hash: string }>;
      const allowance: bigint = await allowanceFn(signerWallet.address, addresses.depository);
      if (allowance < amount) {
        // Safer approval model: approve exact amount needed.
        // For USDT-like tokens, clear to 0 before raising allowance.
        if (allowance > 0n) {
          const clearTx = await approveFn(addresses.depository, 0n, await buildFeeOverrides());
          await waitForReceipt(clearTx as any, 'erc20ApproveReset');
        }
        const approveTx = await approveFn(addresses.depository, amount, await buildFeeOverrides());
        await waitForReceipt(approveTx as any, 'erc20ApproveExact');
        console.log(`[JAdapter:rpc] Approved exact allowance=${amount} for Depository`);
      }

      // Step 3: Call externalTokenToReserve
      // Connect depository with signer's wallet
      const depositoryWithSigner = depository.connect(managedSigner as any) as typeof depository;
      const depositTx = await depositoryWithSigner.externalTokenToReserve({
        entity: entityId,
        contractAddress: tokenAddress,
        externalTokenId,
        tokenType,
        internalTokenId, // Auto-detect from registry when 0
        amount: amount,
      }, await buildFeeOverrides());
      const receipt = await waitForReceipt(depositTx as any, 'externalTokenToReserve');

      // Parse events
      const events: JEvent[] = [];
      for (const log of receipt.logs) {
        try {
          const parsed = depository.interface.parseLog({ topics: log.topics as string[], data: log.data });
          if (parsed) {
            events.push({
              name: parsed.name,
              args: Object.fromEntries(Object.entries(parsed.args)),
              blockNumber: receipt.blockNumber,
              blockHash: receipt.blockHash,
              transactionHash: receipt.hash,
            });
          }
        } catch { }
      }

      console.log(`[JAdapter:rpc] Deposited ${amount} tokens to entity ${entityId.slice(0, 16)}...`);
      return events;
    },

    // === High-level J-tx submission ===
    async submitTx(jTx: JTx, options: { env: any; signerId?: string; timestamp?: number }): Promise<JSubmitResult> {
      const { env, signerId, timestamp } = options;

      console.log(`📤 [JAdapter:rpc] submitTx type=${jTx.type} entity=${jTx.entityId.slice(-4)}`);

      if (jTx.type === 'batch' && jTx.data?.batch) {
        const { encodeJBatch, computeBatchHankoHash, isBatchEmpty, getBatchSize } = await import('../j-batch');
        const { normalizeEntityId } = await import('../entity-id-utils');

        if (isBatchEmpty(jTx.data.batch)) {
          console.log(`📦 [JAdapter:rpc] Empty batch, skipping`);
          return { success: true };
        }

        const entityProviderAddr = addresses.entityProvider;
        const normalizedId = normalizeEntityId(jTx.entityId);

        // Validate settlement signatures + entityProvider
        for (const settlement of jTx.data.batch.settlements ?? []) {
          if (!settlement.entityProvider || settlement.entityProvider === '0x0000000000000000000000000000000000000000') {
            settlement.entityProvider = entityProviderAddr;
          }
          if (settlement.diffs?.length > 0 && (!settlement.sig || settlement.sig === '0x')) {
            return { success: false, error: `Settlement missing hanko sig` };
          }
        }

        return runSerializedBatch(async () => {
          // Use pre-provided encoded batch + hanko (from entity consensus) or sign locally
          let encodedBatch: string;
          let hankoData: string;
          let nextNonce: bigint;

          if (jTx.data.hankoSignature && jTx.data.encodedBatch && jTx.data.entityNonce) {
            // Entity consensus already signed — use pre-provided hanko
            encodedBatch = jTx.data.encodedBatch;
            hankoData = jTx.data.hankoSignature;
            nextNonce = BigInt(jTx.data.entityNonce);
            console.log(`🔐 [JAdapter:rpc] Using consensus hanko: nonce=${nextNonce}`);
          } else {
            // Fallback: single-signer sign locally
            const sid = signerId ?? jTx.data.signerId;
            if (!sid) {
              return { success: false, error: `Missing signerId for batch from ${jTx.entityId.slice(-4)}` };
            }

            const depositoryAddr = addresses.depository;
            encodedBatch = encodeJBatch(jTx.data.batch);
            const entityAddress = ethers.getAddress(`0x${normalizedId.slice(-40)}`);
            const currentNonce = await depository['entityNonces']?.(entityAddress) ?? 0n;
            nextNonce = BigInt(currentNonce) + 1n;
            const batchHash = computeBatchHankoHash(BigInt(config.chainId), depositoryAddr, encodedBatch, nextNonce);

            console.log(`🔐 [JAdapter:rpc] Local signing: entity=${normalizedId.slice(-4)} nonce=${nextNonce}`);
            const { signHashesAsSingleEntity } = await import('../hanko-signing');
            const hankos = await signHashesAsSingleEntity(env, normalizedId, sid, [batchHash]);
            hankoData = hankos[0]!;
            if (!hankoData) {
              return { success: false, error: 'Failed to build batch hanko signature' };
            }
          }

          try {
            console.log(`📦 [JAdapter:rpc] processBatch (${getBatchSize(jTx.data.batch)} ops) nonce=${nextNonce}`);
            const gasLimit = await estimateGasWithHeadroom(
              () => depository['processBatch']!.estimateGas(encodedBatch, entityProviderAddr, hankoData, nextNonce),
              DEFAULT_PROCESS_BATCH_GAS,
            );
            const resolvedFeeOverrides = await buildFeeOverrides();
            const requestedFeeOverrides = jTx.data.feeOverrides;
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
              await depository['processBatch']!.staticCall(encodedBatch, entityProviderAddr, hankoData, nextNonce, {
                gasLimit,
              });
            } catch (simErr: any) {
              // Decode revert data using contract ABI (typechain-connected interface).
              const revertData = simErr?.data ?? simErr?.error?.data ?? simErr?.info?.error?.data;
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
                errDetail = simErr?.reason ?? simErr?.message ?? String(simErr);
                console.error(`🔍 [JAdapter:rpc] staticCall revert: ${errDetail}`);
              }
              // Bail — do NOT submit a known-bad batch on-chain
              return { success: false, error: `staticCall revert: ${errDetail}` };
            }

            for (let attempt = 1; attempt <= 2; attempt++) {
              try {
                if (attempt > 1) {
                  maybeResetSignerNonce();
                  console.warn(`⚠️ [JAdapter:rpc] retrying processBatch after nonce sync (attempt ${attempt}/2)`);
                }
                const tx = await depository['processBatch']!(encodedBatch, entityProviderAddr, hankoData, nextNonce, {
                  gasLimit,
                  ...resolvedFeeOverrides,
                });
                const receipt = await waitForReceipt(tx as any, 'submitTx:processBatch');
                const txHash = receipt.hash ?? tx.hash;
                const blockNum = receipt.blockNumber ?? 0;
                console.log(`✅ [JAdapter:rpc] Batch executed: block=${blockNum} gas=${receipt.gasUsed}`);
                return { success: true, txHash, blockNumber: blockNum };
              } catch (error) {
                if (attempt < 2 && isNonceSyncError(error)) {
                  continue;
                }
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
        const entityId = String((jTx.data as any)?.entityId || jTx.entityId || '');
        const tokenId = Number((jTx.data as any)?.tokenId);
        const amount = BigInt((jTx.data as any)?.amount ?? 0n);
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

      return { success: false, error: `Unknown JTx type: ${(jTx as any).type}` };
    },

    // === J-Watcher integration (RPC polling — uses shared event conversion from helpers.ts) ===
    startWatching(env: any): void {
      if (watcherInterval) {
        console.log(`🔭 [JAdapter:rpc] Already watching`);
        return;
      }
      watcherEnv = env;
      lastSyncedBlock = 0;
      txCounter.value = 0;
      (txCounter as any)._seenLogs = { set: new Set<string>(), order: [] as string[] };
      const watchPollMs = resolveWatcherPollMs(!!env?.scenarioMode);
      const confirmationDepth = resolveFinalityDepth(!!env?.scenarioMode);
      console.log(`🔭 [JAdapter:rpc] Starting event watcher (${watchPollMs}ms polling, depth=${confirmationDepth})...`);

      // Depository ABI for queryFilter — must match CANONICAL_J_EVENTS
      const depositoryABI = [
        'event ReserveUpdated(bytes32 indexed entity, uint256 indexed tokenId, uint256 newBalance)',
        'event SecretRevealed(bytes32 indexed hashlock, bytes32 indexed revealer, bytes32 secret)',
        'event AccountSettled(tuple(bytes32 left, bytes32 right, tuple(uint256 tokenId, uint256 leftReserve, uint256 rightReserve, uint256 collateral, int256 ondelta)[] tokens, uint256 nonce)[] settled)',
        'event DisputeStarted(bytes32 indexed sender, bytes32 indexed counterentity, uint256 indexed nonce, bytes32 proofbodyHash, bytes initialArguments)',
        'event DisputeFinalized(bytes32 indexed sender, bytes32 indexed counterentity, uint256 indexed initialNonce, bytes32 initialProofbodyHash, bytes32 finalProofbodyHash)',
        'event DebtCreated(bytes32 indexed debtor, bytes32 indexed creditor, uint256 indexed tokenId, uint256 amount, uint256 debtIndex)',
        'event DebtEnforced(bytes32 indexed debtor, bytes32 indexed creditor, uint256 indexed tokenId, uint256 amountPaid, uint256 remainingAmount, uint256 newDebtIndex)',
        'event HankoBatchProcessed(bytes32 indexed entityId, bytes32 indexed hankoHash, uint256 nonce, bool success)',
      ];
      const depositoryIface = new ethers.Interface(depositoryABI);

      const emitWatcherDebug = (payload: Record<string, unknown>) => {
        const p2p = (watcherEnv as any)?.runtimeState?.p2p;
        if (p2p && typeof p2p.sendDebugEvent === 'function') {
          p2p.sendDebugEvent({
            level: 'info',
            code: 'J_WATCH_RPC',
            ...payload,
          });
        }
      };

      const doPoll = async () => {
        if (!watcherEnv) return;
        try {
          // Use raw RPC call to bypass ethers' block number caching
          const rpcResult = await (provider as ethers.JsonRpcProvider).send('eth_blockNumber', []);
          const currentBlock = parseInt(rpcResult, 16);
          const safeToBlock = currentBlock - confirmationDepth;
          if (safeToBlock <= 0) return;
          if (lastSyncedBlock >= safeToBlock) return;

          const fromBlock = lastSyncedBlock + 1;
          const filter = { address: addresses.depository, fromBlock, toBlock: safeToBlock };
          const logs = await provider.getLogs(filter);

          if (logs.length > 0) {
            const rawEvents: RawJEvent[] = [];
            for (const log of logs) {
              try {
                const parsed = depositoryIface.parseLog({ topics: log.topics as string[], data: log.data });
                if (!parsed) continue;
                if (!CANONICAL_J_EVENTS.includes(parsed.name as any)) continue;
                // Extract named args from ethers v6 Result (array-like, named keys
                // not enumerable via Object.keys). Use positional fallback for unnamed params.
                const args: Record<string, any> = {};
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
                processEventBatch(events, watcherEnv, blockNum, blockHash, txCounter, 'rpc');
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
          }

          lastSyncedBlock = safeToBlock;
        } catch (error) {
          emitWatcherDebug({
            event: 'j_watch_error',
            message: error instanceof Error ? error.message : String(error),
            lastSyncedBlock,
          });
          if (!(error instanceof Error && error.message.includes('ECONNREFUSED'))) {
            console.error(`🔭❌ [JAdapter:rpc] Sync error:`, error instanceof Error ? error.message : String(error));
          }
        }
      };

      // Store pollNow for scenarios that need immediate sync
      (adapter as any)._pollNow = doPoll;
      watcherInterval = setInterval(doPoll, watchPollMs);

      console.log(`🔭 [JAdapter:rpc] Watcher started (${watchPollMs}ms polling)`);
    },

    async pollNow(): Promise<void> {
      const fn = (adapter as any)._pollNow;
      if (fn) await fn();
    },

    stopWatching(): void {
      if (watcherInterval) {
        clearInterval(watcherInterval);
        watcherInterval = null;
        watcherEnv = null;
        console.log(`🔭 [JAdapter:rpc] Watcher stopped`);
      }
    },

    getBrowserVM(): BrowserVMProvider | null {
      return null;
    },

    setBlockTimestamp(_timestamp: number): void {
      console.warn('[JAdapter:rpc] setBlockTimestamp not supported in RPC mode');
    },

    async close(): Promise<void> {
      adapter.stopWatching();
      depository?.removeAllListeners();
      entityProvider?.removeAllListeners();
    },
  };

  // Watcher state
  let watcherInterval: any = null;
  let watcherEnv: any = null;
  let lastSyncedBlock = 0;
  const txCounter = { value: 0 };

  return adapter;
}

// Alias for backward compatibility
export const createAnvilAdapter = createRpcAdapter;

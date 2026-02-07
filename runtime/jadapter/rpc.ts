/**
 * JAdapter - RPC Implementation
 * Unified adapter for all JSON-RPC backends (anvil, hardhat, mainnet, testnet)
 *
 * Features:
 *   - Deploy contracts (anvil/hardhat) or connect to existing (mainnet/testnet)
 *   - Snapshot/revert if RPC supports evm_snapshot (anvil/hardhat)
 *   - Falls back gracefully on unsupported features
 *
 * @license AGPL-3.0
 */

import { ethers } from 'ethers';
import type { Provider, Signer } from 'ethers';

import { Account__factory } from '../../jurisdictions/typechain-types/factories/Account__factory';
import type { Account, Depository, EntityProvider, DeltaTransformer } from '../../jurisdictions/typechain-types';
import { Depository__factory, EntityProvider__factory, DeltaTransformer__factory } from '../../jurisdictions/typechain-types';

import type { BrowserVMState, JTx } from '../types';
import type { JAdapter, JAdapterAddresses, JAdapterConfig, JEvent, JEventCallback, JSubmitResult, SnapshotId, JBatchReceipt, JTxReceipt, SettlementDiff, InsuranceReg, BrowserVMProvider, JTokenInfo } from './types';
import { computeAccountKey, entityIdToAddress, setupContractEventListeners, processEventBatch, type RawJEvent } from './helpers';
import { CANONICAL_J_EVENTS } from './helpers';

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
  const WATCH_POLL_MS = 15000;
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

  // Check if RPC supports snapshots (anvil/hardhat)
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
      // Try to mine a block (anvil/hardhat)
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
      const tx = await depository.processBatch(encodedBatch, addresses.entityProvider, hankoData, nonce, {
        gasLimit: 5_000_000n,
      });
      const receipt = await tx.wait();
      if (!receipt) throw new Error('Transaction failed');

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
      insuranceRegs: InsuranceReg[] = [],
      sig?: string
    ): Promise<JTxReceipt> {
      const hasChanges = diffs.length > 0 || forgiveDebtsInTokenIds.length > 0 || insuranceRegs.length > 0;
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
        insuranceRegs,
        finalSig,
        { gasLimit: 2_000_000n }
      );
      const receipt = await tx.wait();
      if (!receipt) throw new Error('Settlement transaction failed');

      return {
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
      };
    },

    async registerNumberedEntity(boardHash: string): Promise<{ entityNumber: number; txHash: string }> {
      const tx = await entityProvider.registerNumberedEntity(boardHash);
      const receipt = await tx.wait();
      if (!receipt) throw new Error('Registration failed');

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
      const tx = await entityProvider.registerNumberedEntitiesBatch(boardHashes);
      const receipt = await tx.wait();
      if (!receipt) throw new Error('Batch registration failed');

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
      // For dev chains (anvil/hardhat), allow debug funding for testnet
      if (config.chainId === 31337 || config.chainId === 1337) {
        // Use mintToReserve (renamed from debugFundReserves in Depository contract)
        const tx = await depository.mintToReserve(entityId, tokenId, amount);
        const receipt = await tx.wait();
        if (!receipt) throw new Error('Fund reserves failed');

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
      throw new Error('debugFundReserves only available on dev chains (31337/1337) - use real token deposits');
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
      const tx = await depository.reserveToReserve(from, to, tokenId, amount);
      const receipt = await tx.wait();
      if (!receipt) throw new Error('R2R transfer failed');

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
      const approveFn = erc20.getFunction('approve') as (spender: string, amount: bigint) => Promise<{ wait: () => Promise<unknown> }>;
      const allowance: bigint = await allowanceFn(signerWallet.address, addresses.depository);
      if (allowance < amount) {
        const approveTx = await approveFn(addresses.depository, ethers.MaxUint256);
        await approveTx.wait();
        console.log('[JAdapter:rpc] Approved max allowance for Depository');
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
      });
      const receipt = await depositTx.wait();
      if (!receipt) throw new Error('Deposit failed');

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

        const sid = signerId ?? jTx.data.signerId;
        if (!sid) {
          return { success: false, error: `Missing signerId for batch from ${jTx.entityId.slice(-4)}` };
        }

        const depositoryAddr = addresses.depository;
        const entityProviderAddr = addresses.entityProvider;
        const resolvedChainId = BigInt(config.chainId || (await provider.getNetwork()).chainId);

        // Validate settlement signatures
        for (const settlement of jTx.data.batch.settlements ?? []) {
          settlement.entityProvider = entityProviderAddr;
          if (settlement.diffs?.length > 0 && (!settlement.sig || settlement.sig === '0x')) {
            return { success: false, error: `Settlement missing hanko sig` };
          }
        }

        const encodedBatch = encodeJBatch(jTx.data.batch);
        const normalizedId = normalizeEntityId(jTx.entityId);
        const entityAddress = ethers.getAddress(`0x${normalizedId.slice(-40)}`);
        const currentNonce = await depository['entityNonces']?.(entityAddress) ?? 0n;
        const nextNonce = BigInt(currentNonce) + 1n;
        const batchHash = computeBatchHankoHash(resolvedChainId, depositoryAddr, encodedBatch, nextNonce);

        console.log(`🔐 [JAdapter:rpc] Signing hanko: entity=${normalizedId.slice(-4)} nonce=${nextNonce} chainId=${resolvedChainId}`);

        const { signHashesAsSingleEntity } = await import('../hanko-signing');
        const hankos = await signHashesAsSingleEntity(env, normalizedId, sid, [batchHash]);
        const hankoData = hankos[0];
        if (!hankoData) {
          return { success: false, error: 'Failed to build batch hanko signature' };
        }

        try {
          console.log(`📦 [JAdapter:rpc] processBatch (${getBatchSize(jTx.data.batch)} ops) nonce=${nextNonce}`);
          const tx = await depository['processBatch']!(encodedBatch, entityProviderAddr, hankoData, nextNonce, {
            gasLimit: 5000000,
          });
          const receipt = await tx.wait();
          const txHash = receipt?.hash ?? tx.hash;
          const blockNum = receipt?.blockNumber ?? 0;
          console.log(`✅ [JAdapter:rpc] Batch executed: block=${blockNum} gas=${receipt?.gasUsed}`);
          return { success: true, txHash, blockNumber: blockNum };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.error(`❌ [JAdapter:rpc] processBatch failed: ${msg}`);
          return { success: false, error: msg };
        }
      }

      if (jTx.type === 'mint') {
        console.warn(`⚠️ [JAdapter:rpc] Mint not supported on RPC chains`);
        return { success: false, error: 'Mint not supported on RPC chains' };
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
      console.log(`🔭 [JAdapter:rpc] Starting event watcher (${WATCH_POLL_MS}ms polling)...`);

      // Depository ABI for queryFilter — must match CANONICAL_J_EVENTS
      const depositoryABI = [
        'event ReserveUpdated(bytes32 indexed entity, uint256 indexed tokenId, uint256 newBalance)',
        'event SecretRevealed(bytes32 indexed hashlock, bytes32 indexed revealer, bytes32 secret)',
        'event AccountSettled(tuple(bytes32 left, bytes32 right, uint256 tokenId, uint256 leftReserve, uint256 rightReserve, uint256 collateral, int256 ondelta)[])',
        'event DisputeStarted(bytes32 indexed sender, bytes32 indexed counterentity, uint256 indexed disputeNonce, bytes32 proofbodyHash, bytes initialArguments)',
        'event DisputeFinalized(bytes32 indexed sender, bytes32 indexed counterentity, uint256 indexed initialDisputeNonce, bytes32 initialProofbodyHash, bytes32 finalProofbodyHash)',
        'event DebtCreated(bytes32 indexed debtor, bytes32 indexed creditor, uint256 indexed tokenId, uint256 amount, uint256 debtIndex)',
        'event HankoBatchProcessed(bytes32 indexed entityId, bytes32 indexed hankoHash, uint256 nonce, bool success)',
      ];
      const depositoryIface = new ethers.Interface(depositoryABI);
      const depositoryForQuery = new ethers.Contract(addresses.depository, depositoryABI, provider);

      watcherInterval = setInterval(async () => {
        if (!watcherEnv) return;
        try {
          const currentBlock = await provider.getBlockNumber();
          if (lastSyncedBlock >= currentBlock) return;

          const fromBlock = lastSyncedBlock + 1;
          // Query ALL depository logs in range
          const filter = { address: addresses.depository, fromBlock, toBlock: currentBlock };
          const logs = await provider.getLogs(filter);

          if (logs.length > 0) {
            // Parse logs into RawJEvent format using depository ABI
            const rawEvents: RawJEvent[] = [];
            for (const log of logs) {
              try {
                const parsed = depositoryIface.parseLog({ topics: log.topics as string[], data: log.data });
                if (!parsed) continue;
                // Only process canonical events
                if (!CANONICAL_J_EVENTS.includes(parsed.name as any)) continue;
                // Convert ethers Result to plain object args
                const args: Record<string, any> = {};
                for (const key of Object.keys(parsed.args)) {
                  if (/^\d+$/.test(key)) continue; // skip positional
                  args[key] = parsed.args[key];
                }
                rawEvents.push({
                  name: parsed.name,
                  args,
                  blockNumber: log.blockNumber,
                  blockHash: log.blockHash,
                  transactionHash: log.transactionHash,
                });
              } catch {
                // Skip unparseable logs
              }
            }

            if (rawEvents.length > 0) {
              // Group by block for proper batch processing
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
            }
          }

          lastSyncedBlock = currentBlock;
        } catch (error) {
          if (!(error instanceof Error && error.message.includes('ECONNREFUSED'))) {
            console.error(`🔭❌ [JAdapter:rpc] Sync error:`, error instanceof Error ? error.message : String(error));
          }
        }
      }, WATCH_POLL_MS);

      console.log(`🔭 [JAdapter:rpc] Watcher started (${WATCH_POLL_MS}ms polling)`);
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

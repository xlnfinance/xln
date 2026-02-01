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
import { Depository__factory } from '../../jurisdictions/typechain-types/factories/Depository__factory';
import { EntityProvider__factory } from '../../jurisdictions/typechain-types/factories/EntityProvider__factory';
import { DeltaTransformer__factory } from '../../jurisdictions/typechain-types/factories/DeltaTransformer__factory';
import type { Account } from '../../jurisdictions/typechain-types/Account';
import type { Depository } from '../../jurisdictions/typechain-types/Depository';
import type { EntityProvider } from '../../jurisdictions/typechain-types/EntityProvider';
import type { DeltaTransformer } from '../../jurisdictions/typechain-types/DeltaTransformer';

import type { BrowserVMState } from '../types';
import type { JAdapter, JAdapterAddresses, JAdapterConfig, JEvent, JEventCallback, SnapshotId, JBatchReceipt, JTxReceipt, SettlementDiff, InsuranceReg, BrowserVMProvider } from './types';
import { computeAccountKey, entityIdToAddress, setupContractEventListeners } from './helpers';

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
    addresses.deltaTransformer = '';

    // Use any cast to handle ethers version mismatch between root and jurisdictions
    account = Account__factory.connect(addresses.account, signer as any);
    depository = Depository__factory.connect(addresses.depository, signer as any);
    entityProvider = EntityProvider__factory.connect(addresses.entityProvider, signer as any);
    deltaTransformer = DeltaTransformer__factory.connect(addresses.deltaTransformer, signer as any);
    deployed = true;
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
      // Use explicit gas limit for large contracts
      const depositoryContract = await depositoryFactory.deploy(addresses.entityProvider, {
        gasLimit: 20_000_000n
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
                parsed.fragment.inputs.map((input, i) => [input.name, parsed.args[i]])
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
      // For anvil (chainId 31337), allow debug funding for testnet
      if (config.chainId === 31337) {
        const tx = await depository.debugFundReserves(entityId, tokenId, amount);
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
      throw new Error('debugFundReserves only available on anvil (chainId 31337) - use real token deposits');
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
                parsed.fragment.inputs.map((input, i) => [input.name, parsed.args[i]])
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
                parsed.fragment.inputs.map((input, i) => [input.name, parsed.args[i]])
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

    getBrowserVM(): BrowserVMProvider | null {
      return null; // RPC mode doesn't have BrowserVM
    },

    setBlockTimestamp(_timestamp: number): void {
      // RPC mode can't control timestamps (except maybe anvil with evm_setNextBlockTimestamp)
      console.warn('[JAdapter:rpc] setBlockTimestamp not supported in RPC mode');
    },

    async close(): Promise<void> {
      depository?.removeAllListeners();
      entityProvider?.removeAllListeners();
    },
  };

  return adapter;
}

// Alias for backward compatibility
export const createAnvilAdapter = createRpcAdapter;

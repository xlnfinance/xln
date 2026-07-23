/**
 * BrowserVMProvider - In-browser EVM using @ethereumjs/vm
 * Self-contained environment with Depository.sol
 *
 * Uses ethers.js Interface for ABI encoding - same pattern as the RPC adapter path
 * This ensures browserVM calls are identical to real blockchain calls.
 *
 * @license AGPL-3.0
 * Copyright (C) 2025 XLN Finance
 */

import { createVM, runTx } from '@ethereumjs/vm';
import { createBlock } from '@ethereumjs/block';
import type { Block } from '@ethereumjs/block';
import { createLegacyTx, createTxFromRLP } from '@ethereumjs/tx';
import { createAddressFromPrivateKey, createAddressFromString, hexToBytes, createAccount, bytesToHex } from '@ethereumjs/util';
import type { Address } from '@ethereumjs/util';
import { createCustomCommon, Mainnet } from '@ethereumjs/common';
import { ethers } from 'ethers';
import {
  Account__factory,
  EntityProvider__factory,
  DeltaTransformer__factory,
  ERC20Mock__factory,
  Depository__factory,
} from '../../jurisdictions/typechain-types/index.ts';
import { safeStringify } from '../protocol/serialization.js';
import { isLeftEntity, normalizeEntityId } from '../entity/id';
import type { EntityProviderActionIntent } from '../types/entity-provider-actions';
import {
  assertEntityProviderActionIntent,
  assertEntityProviderActionResolutionReceipt,
} from '../entity/entity-provider-action';
import { batchAddSettlement, createEmptyBatch, decodeJBatch, summarizeBatch } from '../jurisdiction/batch';
import { buildExternalTokenToReserveBatch, packTokenReference } from './helpers';
import { buildSingleSignerHanko, prepareSignedBatch } from '../hanko/batch';
import { decodeHankoEnvelope } from '../hanko/codec';
import {
  hashCooperativeUpdateHankoPayload,
  hashDisputeProofHankoPayload,
} from '../hanko/onchain-domain';
import { TOKEN_REGISTRATION_AMOUNT, defaultTokensForJurisdiction, getDefaultTokenSupply } from './default-tokens';
import { getBootstrapTokenAmountBySymbol } from '../jurisdiction/bootstrap-economy';
import {
  decodeBrowserVmEvents,
  toBrowserVmReceiptLogs,
  type EVMEvent,
  type EthereumLog,
} from './browservm-events';
import type { JEvent } from './types';
import {
  computeCanonicalReceiptsRoot,
  createCanonicalReceiptProofs,
  type AuthenticatedRpcLog,
  type CanonicalRpcReceipt,
} from './receipt-codec';
import {
  BROWSERVM_CONTRACT_VERSION,
  decodeBrowserVmStateRoot,
  normalizeBrowserVmAddress,
  restoreBrowserVmTrieData,
  serializeBrowserVmTrieData,
  type BrowserVmChainCheckpoint,
  type BrowserVmSerializedState,
  type BrowserVmStoredReceipt,
} from './browservm-state';

export type { EVMEvent } from './browservm-events';
export type { BrowserVmChainCheckpoint } from './browservm-state';

const BLOCK_GAS_LIMIT = 200_000_000n; // Simnet headroom for large deploys/batches
// BrowserVM shares the local-dev chain id with Anvil, so deploying from nonce
// zero would reproduce Anvil's contract addresses and create an ambiguous
// (chainId, Depository) watcher domain when both stacks are imported.
const BROWSERVM_DEPLOYMENT_NONCE = 1_024n;
const MAX_BROWSER_VM_DEBT_QUEUE_READS = 100_000;

const requireBrowserVmChainId = (value: unknown, code: string): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${code}:${String(value)}`);
  }
  return Number(value);
};

type EthereumVm = Awaited<ReturnType<typeof createVM>>;
type EthereumCommon = ReturnType<typeof createCustomCommon>;
type ContractArtifact = { abi: ethers.InterfaceAbi; bytecode: string };
type BrowserVmRunTxResult = Awaited<ReturnType<typeof runTx>>;
type BrowserVmTx = Parameters<typeof runTx>[1]['tx'];
type ValidatedBrowserVmChainCheckpoint = {
  blockHashes: Map<number, string>;
  blockReceiptRoots: Map<number, string>;
  txReceipts: Map<string, BrowserVmStoredReceipt>;
};

const normalizeCheckpointHash = (value: unknown, code: string): string => {
  const normalized = String(value ?? '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) throw new Error(`${code}:${String(value)}`);
  return normalized;
};

const checkpointBlockHashes = (checkpoint: BrowserVmChainCheckpoint): Map<number, string> => {
  if (!Array.isArray(checkpoint.blockHashes)) throw new Error('BROWSERVM_CHECKPOINT_BLOCK_HASHES_MISSING');
  const hashes = new Map<number, string>();
  for (const [height, rawHash] of checkpoint.blockHashes) {
    if (!Number.isSafeInteger(height) || height < 1 || height > checkpoint.blockHeight || hashes.has(height)) {
      throw new Error(`BROWSERVM_CHECKPOINT_BLOCK_HEIGHT_INVALID:${String(height)}`);
    }
    hashes.set(height, normalizeCheckpointHash(rawHash, 'BROWSERVM_CHECKPOINT_BLOCK_HASH_INVALID'));
  }
  if (hashes.size !== checkpoint.blockHeight) {
    throw new Error(`BROWSERVM_CHECKPOINT_BLOCK_HASH_GAP:${hashes.size}:${checkpoint.blockHeight}`);
  }
  return hashes;
};

const checkpointReceiptRoots = (checkpoint: BrowserVmChainCheckpoint): Map<number, string> => {
  if (!Array.isArray(checkpoint.blockReceiptRoots)) {
    throw new Error('BROWSERVM_CHECKPOINT_RECEIPT_ROOTS_MISSING');
  }
  const roots = new Map<number, string>();
  for (const [height, rawRoot] of checkpoint.blockReceiptRoots) {
    if (!Number.isSafeInteger(height) || height < 1 || height > checkpoint.blockHeight || roots.has(height)) {
      throw new Error(`BROWSERVM_CHECKPOINT_RECEIPT_ROOT_HEIGHT_INVALID:${String(height)}`);
    }
    roots.set(height, normalizeCheckpointHash(rawRoot, 'BROWSERVM_CHECKPOINT_RECEIPT_ROOT_INVALID'));
  }
  return roots;
};

const checkpointReceipts = (
  checkpoint: BrowserVmChainCheckpoint,
  blockHashes: ReadonlyMap<number, string>,
): Map<string, BrowserVmStoredReceipt> => {
  if (!Array.isArray(checkpoint.txReceipts)) throw new Error('BROWSERVM_CHECKPOINT_RECEIPTS_MISSING');
  const receipts = new Map<string, BrowserVmStoredReceipt>();
  for (const [rawKey, rawReceipt] of checkpoint.txReceipts) {
    const key = normalizeCheckpointHash(rawKey, 'BROWSERVM_CHECKPOINT_RECEIPT_KEY_INVALID');
    if (receipts.has(key)) throw new Error(`BROWSERVM_CHECKPOINT_RECEIPT_DUPLICATE:${key}`);
    if (!rawReceipt || typeof rawReceipt !== 'object') {
      throw new Error(`BROWSERVM_CHECKPOINT_RECEIPT_INVALID:${key}`);
    }
    const transactionHash = normalizeCheckpointHash(
      rawReceipt.transactionHash,
      'BROWSERVM_CHECKPOINT_RECEIPT_TRANSACTION_HASH_INVALID',
    );
    if (transactionHash !== key) throw new Error(`BROWSERVM_CHECKPOINT_RECEIPT_KEY_MISMATCH:${key}`);
    if (!Number.isSafeInteger(rawReceipt.blockNumber) || rawReceipt.blockNumber < 1) {
      throw new Error(`BROWSERVM_CHECKPOINT_RECEIPT_BLOCK_INVALID:${key}`);
    }
    const blockHash = normalizeCheckpointHash(
      rawReceipt.blockHash,
      'BROWSERVM_CHECKPOINT_RECEIPT_BLOCK_HASH_INVALID',
    );
    if (blockHashes.get(rawReceipt.blockNumber) !== blockHash) {
      throw new Error(`BROWSERVM_CHECKPOINT_RECEIPT_BLOCK_HASH_MISMATCH:${key}`);
    }
    if (!Array.isArray(rawReceipt.logs)) throw new Error(`BROWSERVM_CHECKPOINT_RECEIPT_LOGS_INVALID:${key}`);
    const logs = rawReceipt.logs.map((log, logIndex) => {
      if (
        log.blockNumber !== rawReceipt.blockNumber ||
        String(log.transactionHash).toLowerCase() !== key ||
        log.logIndex !== logIndex
      ) {
        throw new Error(`BROWSERVM_CHECKPOINT_RECEIPT_LOG_METADATA_INVALID:${key}:${logIndex}`);
      }
      return { ...log, transactionHash: key, topics: [...log.topics] };
    });
    receipts.set(key, { ...rawReceipt, transactionHash: key, blockHash, logs });
  }
  return receipts;
};

const assertCheckpointReceiptRoots = async (
  receipts: ReadonlyMap<string, BrowserVmStoredReceipt>,
  roots: ReadonlyMap<number, string>,
): Promise<void> => {
  const receiptsByBlock = new Map<number, BrowserVmStoredReceipt[]>();
  for (const receipt of receipts.values()) {
    const entries = receiptsByBlock.get(receipt.blockNumber) ?? [];
    entries.push(receipt);
    receiptsByBlock.set(receipt.blockNumber, entries);
  }
  for (const [height, entries] of receiptsByBlock) {
    const committed = roots.get(height);
    if (!committed) throw new Error(`BROWSERVM_CHECKPOINT_RECEIPT_ROOT_MISSING:${height}`);
    const computed = await computeCanonicalReceiptsRoot(entries);
    if (computed !== committed) {
      throw new Error(`BROWSERVM_CHECKPOINT_RECEIPT_ROOT_MISMATCH:${height}:${committed}:${computed}`);
    }
  }
  for (const height of roots.keys()) {
    if (!receiptsByBlock.has(height)) throw new Error(`BROWSERVM_CHECKPOINT_RECEIPT_ROOT_ORPHAN:${height}`);
  }
};

export class BrowserVMProvider {
  private vm: EthereumVm = null as unknown as EthereumVm;
  private common: EthereumCommon = null as unknown as EthereumCommon;
  private configuredChainId = 31_337;
  private accountAddress: Address | null = null;
  private depositoryAddress: Address | null = null;
  private entityProviderAddress: Address | null = null;
  private entityProviderDeploymentBlock = 0;
  private deltaTransformerAddress: Address | null = null;
  private deployerPrivKey: Uint8Array;
  private deployerAddress: Address;
  private nonce = 0n;
  private accountArtifact: ContractArtifact | null = null;
  private depositoryArtifact: ContractArtifact | null = null;
  private entityProviderArtifact: ContractArtifact | null = null;
  private deltaTransformerArtifact: ContractArtifact | null = null;
  private erc20Artifact: ContractArtifact | null = null;
  private depositoryInterface: ethers.Interface | null = null;
  private entityProviderInterface: ethers.Interface | null = null;
  private accountInterface: ethers.Interface | null = null;
  private erc20Interface: ethers.Interface | null = null;
  private tokenRegistry: Map<string, { address: string; name: string; symbol: string; decimals: number; tokenId: number }> = new Map();
  private fundedAddresses: Set<string> = new Set();
  private initialized = false;
  private quietLogs = false;
  private blockHeight = 0; // Track J-Machine block height
  private blockHash = '0x0000000000000000000000000000000000000000000000000000000000000000'; // Current block hash
  private blockHashes = new Map<number, string>();
  private blockReceiptRoots = new Map<number, string>();
  private blockTimestamp = 0; // Deterministic block timestamp (set by runtime)
  private activeBlock: Block | null = null;
  private activeBlockGasUsed = 0n;
  // ─────────────────────────────────────────────────────────────────────────────
  // Event callbacks receive BATCHES of events (all events from one tx/block)
  // This matches real blockchain behavior where events are grouped by block
  // ─────────────────────────────────────────────────────────────────────────────
  private eventCallbacks: Set<(events: EVMEvent[]) => void | Promise<void>> = new Set();

  // Transaction receipts for ethers compatibility
  private txReceipts = new Map<string, BrowserVmStoredReceipt>();
  private vmOperationTail: Promise<void> = Promise.resolve();

  constructor() {
    // Hardhat default account #0
    this.deployerPrivKey = hexToBytes('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
    this.deployerAddress = createAddressFromPrivateKey(this.deployerPrivKey);
  }

  setQuietLogs(quiet: boolean): void {
    this.quietLogs = quiet;
  }

  private log(...args: unknown[]): void {
    if (!this.quietLogs) {
      console.log(...args);
    }
  }

  async runExclusiveVmOperation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.vmOperationTail;
    let release!: () => void;
    this.vmOperationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  /** Initialize VM and deploy contracts */
  async init(options?: { chainId?: number }): Promise<void> {
    const requestedChainId = requireBrowserVmChainId(
      options?.chainId ?? this.configuredChainId,
      'BROWSERVM_CHAIN_ID_INVALID',
    );
    if (this.initialized) {
      if (requestedChainId !== this.configuredChainId) {
        throw new Error(
          `BROWSERVM_CHAIN_ID_REINITIALIZATION_MISMATCH:${requestedChainId}:${this.configuredChainId}`,
        );
      }
      console.log('[BrowserVM] Already initialized, skipping');
      return;
    }
    this.configuredChainId = requestedChainId;

    // Canonical ABI/bytecode source: typechain factories (keeps BrowserVM in sync with RPC adapter).
    this.accountArtifact = { abi: Account__factory.abi, bytecode: Account__factory.bytecode };
    this.depositoryArtifact = { abi: Depository__factory.abi, bytecode: Depository__factory.bytecode };
    this.entityProviderArtifact = { abi: EntityProvider__factory.abi, bytecode: EntityProvider__factory.bytecode };
    this.deltaTransformerArtifact = { abi: DeltaTransformer__factory.abi, bytecode: DeltaTransformer__factory.bytecode };
    this.erc20Artifact = { abi: ERC20Mock__factory.abi, bytecode: ERC20Mock__factory.bytecode };
    console.log('[BrowserVM] Loaded artifacts from typechain factories');

    // Create ethers Interfaces for ABI encoding
    this.depositoryInterface = new ethers.Interface(this.depositoryArtifact.abi);
    this.entityProviderInterface = new ethers.Interface(this.entityProviderArtifact.abi);
    this.accountInterface = new ethers.Interface(this.accountArtifact.abi);
    this.erc20Interface = new ethers.Interface(this.erc20Artifact.abi);
    console.log('[BrowserVM] Loaded all contract artifacts (including Account library and DeltaTransformer)');

    // Create VM with evmOpts to disable contract size limit
    const common = createCustomCommon({ chainId: this.configuredChainId }, Mainnet);
    this.vm = await createVM({
      common,
      evmOpts: {
        allowUnlimitedContractSize: true, // Disable EIP-170 24KB limit for simnet
      },
    });
    this.common = common;
    console.log('[BrowserVM] Unlimited contract size enabled for simnet');

    // Fund deployer
    const deployerAccount = createAccount({
      nonce: BROWSERVM_DEPLOYMENT_NONCE,
      balance: 10000000000000000000000n, // 10000 ETH
    });
    await this.vm.stateManager.putAccount(this.deployerAddress, deployerAccount);
    console.log(`[BrowserVM] Deployer funded: ${this.deployerAddress.toString()}`);

    // Deploy contracts in order: Account (library) → EntityProvider → Depository(EP) → DeltaTransformer
    await this.deployAccount();
    await this.deployEntityProvider();
    await this.deployDepository();  // Now requires EntityProvider address
    await this.deployDeltaTransformer();
    await this.deployDefaultTokens();

    this.initialized = true;
    console.log('[BrowserVM] All contracts deployed successfully');
  }

  /** Reset VM to fresh state - recreates VM and redeploys contracts */
  async reset(): Promise<void> {
    console.log('[BrowserVM] Resetting to fresh state...');
    this.initialized = false;
    this.vm = null as unknown as EthereumVm;
    this.common = null as unknown as EthereumCommon;
    this.accountAddress = null;
    this.depositoryAddress = null;
    this.entityProviderAddress = null;
    this.entityProviderDeploymentBlock = 0;
    this.deltaTransformerAddress = null;
    this.nonce = 0n;
    this.blockHeight = 0;
    this.blockHash = '0x0000000000000000000000000000000000000000000000000000000000000000';
    this.blockTimestamp = 0;
    this.blockHashes.clear();
    this.blockReceiptRoots.clear();
    this.txReceipts.clear();
    this.activeBlock = null;
    this.activeBlockGasUsed = 0n;
    this.tokenRegistry.clear();
    this.fundedAddresses.clear();
    await this.init({ chainId: this.configuredChainId });
    console.log('[BrowserVM] Reset complete - fresh contracts deployed');
  }

  /** Deploy Account library */
  private async deployAccount(): Promise<void> {
    console.log('[BrowserVM] Deploying Account library...');
    const { result } = await this.runTxWithNonce(this.deployerAddress, (currentNonce) =>
      createLegacyTx({
        gasLimit: 100000000n,
        gasPrice: 10n,
        data: this.accountArtifact!.bytecode as `0x${string}`,
        nonce: currentNonce,
      }, { common: this.common }).sign(this.deployerPrivKey));

    if (result.execResult.exceptionError) {
      console.error('[BrowserVM] Account deployment failed:', result.execResult.exceptionError);
      throw new Error(`Account deployment failed: ${result.execResult.exceptionError}`);
    }

    this.accountAddress = result.createdAddress!;
    console.log(`[BrowserVM] Account library deployed at: ${this.accountAddress?.toString() ?? 'null'}`);
  }

  /** Deploy Depository contract with Account library linking and EntityProvider */
  private async deployDepository(): Promise<void> {
    console.log('[BrowserVM] Deploying Depository with Account library linking + EntityProvider...');

    if (!this.accountAddress) {
      throw new Error('Account library must be deployed first');
    }
    if (!this.entityProviderAddress) {
      throw new Error('EntityProvider must be deployed before Depository');
    }

    // Link Account library address into Depository bytecode
    // Replace placeholder __$...$__ with actual library address
    let linkedBytecode = this.depositoryArtifact!.bytecode;
    const accountAddrHex = this.accountAddress.toString().slice(2).toLowerCase(); // Remove 0x prefix

    // Find and replace library placeholder (format: __$<hash>$__)
    const placeholderRegex = /__\$[a-f0-9]{34}\$__/g;
    const placeholders = linkedBytecode.match(placeholderRegex);

    if (placeholders && placeholders.length > 0) {
      console.log(`[BrowserVM] Found ${placeholders.length} library placeholders, linking Account at ${accountAddrHex}`);
      linkedBytecode = linkedBytecode.replace(placeholderRegex, accountAddrHex);
    } else {
      console.warn('[BrowserVM] No library placeholders found in Depository bytecode');
    }

    // BrowserVM uses the local deterministic policy; live jurisdictions pass
    // their block-time-specific immutable value from the deployment profile.
    const constructorArgs = ethers.AbiCoder.defaultAbiCoder().encode(
      ['address', 'uint256'],
      [this.entityProviderAddress.toString(), 5_760]
    );
    const deployData = linkedBytecode + constructorArgs.slice(2); // Remove 0x from args

    const { result } = await this.runTxWithNonce(this.deployerAddress, (currentNonce) =>
      createLegacyTx({
        gasLimit: 100000000n,
        gasPrice: 10n,
        data: deployData as `0x${string}`,
        nonce: currentNonce,
      }, { common: this.common }).sign(this.deployerPrivKey));

    if (result.execResult.exceptionError) {
      console.error('[BrowserVM] Depository deployment failed:', result.execResult.exceptionError);
      throw new Error(`Depository deployment failed: ${result.execResult.exceptionError}`);
    }

    this.depositoryAddress = result.createdAddress!;
    console.log(`[BrowserVM] Depository deployed at: ${this.depositoryAddress?.toString() ?? 'null'}`);
    console.log(`[BrowserVM] Gas used: ${result.totalGasSpent}`);

    // Verify code exists
    const code = await this.vm.stateManager.getCode(this.depositoryAddress!);
    if (code.length === 0) {
      throw new Error('Depository deployment failed - no code at address');
    }
  }

  /** Deploy EntityProvider contract */
  private async deployEntityProvider(): Promise<void> {
    console.log('[BrowserVM] Deploying EntityProvider...');
    const constructorArgs = ethers.AbiCoder.defaultAbiCoder().encode(
      ['address'],
      [this.deployerAddress.toString()]
    );
    const deployData = `${this.entityProviderArtifact!.bytecode}${constructorArgs.slice(2)}`;

    const { result } = await this.runTxWithNonce(this.deployerAddress, (currentNonce) =>
      createLegacyTx({
        gasLimit: 100000000n,
        gasPrice: 10n,
        data: deployData as `0x${string}`,
        nonce: currentNonce,
      }, { common: this.common }).sign(this.deployerPrivKey));

    if (result.execResult.exceptionError) {
      console.error('[BrowserVM] EntityProvider deployment failed:', result.execResult.exceptionError);
      throw new Error(`EntityProvider deployment failed: ${result.execResult.exceptionError}`);
    }

    this.entityProviderAddress = result.createdAddress!;
    this.entityProviderDeploymentBlock = Number(this.getBlockNumber());
    console.log(`[BrowserVM] EntityProvider deployed at: ${this.entityProviderAddress?.toString() ?? 'null'}`);
  }

  /** Deploy DeltaTransformer contract (HTLC + Swap transformer) */
  private async deployDeltaTransformer(): Promise<void> {
    console.log('[BrowserVM] Deploying DeltaTransformer...');
    const { result } = await this.runTxWithNonce(this.deployerAddress, (currentNonce) =>
      createLegacyTx({
        gasLimit: 100000000n,
        gasPrice: 10n,
        data: this.deltaTransformerArtifact!.bytecode as `0x${string}`,
        nonce: currentNonce,
      }, { common: this.common }).sign(this.deployerPrivKey));

    if (result.execResult.exceptionError) {
      console.error('[BrowserVM] DeltaTransformer deployment failed:', result.execResult.exceptionError);
      throw new Error(`DeltaTransformer deployment failed: ${result.execResult.exceptionError}`);
    }

    this.deltaTransformerAddress = result.createdAddress!;
    console.log(`[BrowserVM] DeltaTransformer deployed at: ${this.deltaTransformerAddress?.toString() ?? 'null'}`);

    // Update proof-builder with deployed address
  }

  /** Get DeltaTransformer contract address */
  getDeltaTransformerAddress(): string {
    if (!this.deltaTransformerAddress) {
      throw new Error('DeltaTransformer not deployed');
    }
    return this.deltaTransformerAddress.toString();
  }

  /** Token registry (symbol → metadata) */
  getTokenRegistry(): Array<{ symbol: string; name: string; address: string; decimals: number; tokenId: number }> {
    return Array.from(this.tokenRegistry.values());
  }

  getTokenAddress(symbol: string): string | null {
    return this.tokenRegistry.get(symbol)?.address || null;
  }

  getTokenId(symbol: string): number | null {
    const tokenId = this.tokenRegistry.get(symbol)?.tokenId;
    return typeof tokenId === 'number' ? tokenId : null;
  }

  /** Faucet: fund ETH plus either one exact token target or value-normalized defaults. */
  async fundSignerWallet(address: string, amount?: bigint, tokenSymbol?: string): Promise<void> {
    if (!address) return;
    if (!this.tokenRegistry.size) {
      await this.deployDefaultTokens();
    }
    const normalized = address.toLowerCase();

    await this.ensureEthBalance(address, 1000n * 10n ** 18n);

    const normalizedSymbol = String(tokenSymbol || '').trim().toUpperCase();
    const selectedToken = normalizedSymbol ? this.tokenRegistry.get(normalizedSymbol) : undefined;
    if (normalizedSymbol && !selectedToken) throw new Error(`BROWSERVM_FAUCET_TOKEN_UNKNOWN:${normalizedSymbol}`);
    const tokens = selectedToken ? [selectedToken] : Array.from(this.tokenRegistry.values());
    for (const token of tokens) {
      const targetAmount = amount ?? getBootstrapTokenAmountBySymbol(token.symbol, token.decimals);
      const balance = await this.getErc20Balance(token.address, address);
      if (balance >= targetAmount) continue;
      const delta = targetAmount - balance;
      await this.transferErc20(this.deployerPrivKey, token.address, address, delta);
    }

    this.fundedAddresses.add(normalized);
    console.log(
      `[BrowserVM] Faucet funded ${address.slice(0, 10)}... for ${normalizedSymbol || `${tokens.length} default tokens`}`,
    );
  }

  private async deployDefaultTokens(): Promise<void> {
    if (this.tokenRegistry.size > 0) return;
    if (!this.erc20Artifact || !this.erc20Interface) {
      throw new Error('ERC20 artifact not loaded');
    }
    if (!this.depositoryAddress || !this.depositoryInterface) {
      throw new Error('Depository not deployed');
    }

    const rawChainId = (this.common as EthereumCommon & { chainId?: () => bigint | number }).chainId?.();
    const chainId = typeof rawChainId === 'bigint' ? Number(rawChainId) : Number(rawChainId);
    for (const token of defaultTokensForJurisdiction({ chainId })) {
      const tokenSupply = getDefaultTokenSupply(token.decimals);
      const address = await this.deployErc20Token(token.name, token.symbol, token.decimals, tokenSupply);
      const tokenId = await this.registerErc20Token(address);

      // Pre-fund Depository with real ERC20 so reserveToExternalToken works.
      // mintToReserve only updates internal accounting — Depository needs actual token balance.
      await this.mintErc20(address, this.depositoryAddress!.toString(), tokenSupply);

      this.tokenRegistry.set(token.symbol, {
        address,
        name: token.name,
        symbol: token.symbol,
        decimals: token.decimals,
        tokenId,
      });
      console.log(`[BrowserVM] Token registered: ${token.symbol} id=${tokenId} addr=${address.slice(0, 10)}... (depository pre-funded)`);
    }
  }

  private async deployErc20Token(name: string, symbol: string, decimals: number, supply: bigint): Promise<string> {
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const constructorData = abiCoder.encode(
      ['string', 'string', 'uint8', 'uint256'],
      [name, symbol, decimals, supply],
    );
    const bytecode = `${this.erc20Artifact!.bytecode}${constructorData.slice(2)}`;

    const { result } = await this.runTxWithNonce(this.deployerAddress, (currentNonce) =>
      createLegacyTx({
        gasLimit: 5_000_000n,
        gasPrice: 10n,
        data: bytecode as `0x${string}`,
        nonce: currentNonce,
      }, { common: this.common }).sign(this.deployerPrivKey));

    if (result.execResult.exceptionError) {
      throw new Error(`ERC20 deployment failed: ${result.execResult.exceptionError}`);
    }

    return result.createdAddress!.toString();
  }

  private async registerErc20Token(tokenAddress: string): Promise<number> {
    const packedToken = packTokenReference(0, tokenAddress, 0n);
    await this.approveErc20(this.deployerPrivKey, tokenAddress, this.depositoryAddress!.toString(), TOKEN_REGISTRATION_AMOUNT);

    const callData = this.depositoryInterface!.encodeFunctionData('adminRegisterExternalToken', [{
      entity: ethers.ZeroHash,
      contractAddress: tokenAddress,
      externalTokenId: 0,
      tokenType: 0,
      internalTokenId: 0,
      amount: TOKEN_REGISTRATION_AMOUNT,
    }]);

    const { result } = await this.runTxWithNonce(this.deployerAddress, (currentNonce) =>
      createLegacyTx({
        to: this.depositoryAddress!,
        gasLimit: 1_000_000n,
        gasPrice: 10n,
        data: hexToBytes(callData as `0x${string}`),
        nonce: currentNonce,
      }, { common: this.common }).sign(this.deployerPrivKey));

    if (result.execResult.exceptionError) {
      throw new Error(`adminRegisterExternalToken failed: ${result.execResult.exceptionError}`);
    }

    const tokenId = await this.lookupTokenId(packedToken);
    return tokenId;
  }

  private async lookupTokenId(packedToken: string): Promise<number> {
    const callData = this.depositoryInterface!.encodeFunctionData('tokenToId', [packedToken]);
    const result = await this.runReadOnlyCall({
      to: this.depositoryAddress!,
      caller: this.deployerAddress,
      data: hexToBytes(callData as `0x${string}`),
      gasLimit: 100000n,
    });
    if (result.execResult.exceptionError) {
      throw new Error(`tokenToId failed: ${result.execResult.exceptionError}`);
    }
    const decoded = this.depositoryInterface!.decodeFunctionResult('tokenToId', result.execResult.returnValue);
    return Number(decoded[0]);
  }

  async getErc20Balance(tokenAddress: string, owner: string): Promise<bigint> {
    const callData = this.erc20Interface!.encodeFunctionData('balanceOf', [owner]);
    const result = await this.runReadOnlyCall({
      to: createAddressFromString(tokenAddress),
      caller: this.deployerAddress,
      data: hexToBytes(callData as `0x${string}`),
      gasLimit: 100000n,
    });
    if (result.execResult.exceptionError) return 0n;
    const decoded = this.erc20Interface!.decodeFunctionResult('balanceOf', result.execResult.returnValue);
    return decoded[0];
  }

  async getEthBalance(owner: string): Promise<bigint> {
    return await this.runExclusiveVmOperation(async () => {
      const account = await this.vm.stateManager.getAccount(createAddressFromString(owner));
      return account?.balance || 0n;
    });
  }

  async getErc20Allowance(tokenAddress: string, owner: string, spender: string): Promise<bigint> {
    const callData = this.erc20Interface!.encodeFunctionData('allowance', [owner, spender]);
    const result = await this.runReadOnlyCall({
      to: createAddressFromString(tokenAddress),
      caller: this.deployerAddress,
      data: hexToBytes(callData as `0x${string}`),
      gasLimit: 100000n,
    });
    if (result.execResult.exceptionError) return 0n;
    const decoded = this.erc20Interface!.decodeFunctionResult('allowance', result.execResult.returnValue);
    return decoded[0];
  }

  async approveErc20(privKey: Uint8Array, tokenAddress: string, spender: string, amount: bigint): Promise<JEvent[]> {
    const callData = this.erc20Interface!.encodeFunctionData('approve', [spender, amount]);
    await this.executeTx({
      to: tokenAddress,
      data: callData,
      gasLimit: 200000n,
    }, privKey);
    return [];
  }

  async mintErc20(tokenAddress: string, to: string, amount: bigint): Promise<string> {
    const iface = new ethers.Interface(['function mint(address to, uint256 amount)']);
    const callData = iface.encodeFunctionData('mint', [to, amount]);
    const result = await this.executeTx({
      to: tokenAddress,
      data: callData,
      gasLimit: 200000n,
    }, this.deployerPrivKey);
    return result.txHash;
  }

  async transferErc20(privKey: Uint8Array, tokenAddress: string, to: string, amount: bigint): Promise<string> {
    const callData = this.erc20Interface!.encodeFunctionData('transfer', [to, amount]);
    const result = await this.executeTx({
      to: tokenAddress,
      data: callData,
      gasLimit: 200000n,
    }, privKey);
    return result.txHash;
  }

  async transferNative(privKey: Uint8Array, to: string, amount: bigint): Promise<string> {
    const result = await this.executeTx({
      to,
      value: amount,
      gasLimit: 21000n,
    }, privKey);
    return result.txHash;
  }

  async externalTokenToReserve(
    privKey: Uint8Array,
    entityId: string,
    tokenAddress: string,
    amount: bigint,
    options?: {
      tokenType?: number;
      externalTokenId?: bigint;
      internalTokenId?: number;
    }
  ): Promise<EVMEvent[]> {
    const batch = buildExternalTokenToReserveBatch({
      entityId,
      tokenAddress,
      amount,
      tokenType: options?.tokenType ?? 0,
      externalTokenId: options?.externalTokenId ?? 0n,
      internalTokenId: options?.internalTokenId ?? 0,
    });
    return this.processEntityBatch(entityId, batch, privKey, privKey);
  }

  async executeTx(
    txData: { to?: string; data?: string; gasLimit?: bigint; value?: bigint },
    privKey: Uint8Array = this.deployerPrivKey,
    options?: { emitEvents?: boolean }
  ): Promise<{ txHash: string; events?: EVMEvent[] }> {
    const fromAddress = createAddressFromPrivateKey(privKey);
    const toAddress = txData.to ? createAddressFromString(txData.to) : undefined;
    const { tx, result } = await this.runTxWithNonce(fromAddress, (currentNonce) => {
      const txDataObj: Parameters<typeof createLegacyTx>[0] & { to?: Address } = {
        gasLimit: txData.gasLimit ?? 1000000n,
        gasPrice: 10n,
        data: hexToBytes((txData.data || '0x') as `0x${string}`),
        nonce: currentNonce,
        value: txData.value ?? 0n,
      };
      if (toAddress) txDataObj.to = toAddress;
      return createLegacyTx(txDataObj, { common: this.common }).sign(privKey);
    });

    if (result.execResult.exceptionError) {
      const errObj = result.execResult.exceptionError;
      const errStr = errObj?.error || JSON.stringify(errObj);
      // Log revert events before they are discarded by the failed transaction.
      if (result.execResult.logs && result.execResult.logs.length > 0) {
        console.log('[BrowserVM] Events before revert:', result.execResult.logs.length);
        const events = decodeBrowserVmEvents(
          result.execResult.logs as EthereumLog[],
          [this.depositoryInterface, this.accountInterface, this.entityProviderInterface],
          this.blockHeight,
          this.blockHash,
          this.blockTimestamp,
          bytesToHex(tx.hash()),
        );
        for (const ev of events) {
          console.log(`   Event: ${ev.name}`, ev.args);
        }
      }
      throw new Error(`executeTx failed: ${errStr}`);
    }

    const txHash = bytesToHex(tx.hash());
    if (options?.emitEvents) {
      const events = await this.emitEvents(
        result.execResult.logs || [],
        txHash,
      );
      return { txHash, events };
    }
    return { txHash };
  }

  private canonicalReceiptsAt(blockNumber: number): CanonicalRpcReceipt[] {
    return Array.from(this.txReceipts.values())
      .filter(receipt => receipt.blockNumber === blockNumber)
      .sort((left, right) => left.transactionIndex - right.transactionIndex)
      .map(receipt => ({
        transactionHash: receipt.transactionHash,
        transactionIndex: receipt.transactionIndex,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        type: receipt.type,
        status: receipt.status,
        cumulativeGasUsed: receipt.cumulativeGasUsed,
        logsBloom: receipt.logsBloom,
        logs: receipt.logs,
      }));
  }

  private async recordTransactionReceipt(
    rawLogs: readonly EthereumLog[],
    transactionHash: string,
    receipt: BrowserVmRunTxResult['receipt'],
    transactionType: number,
    metadata?: { from?: string; to?: string | null; contractAddress?: string | null },
  ): Promise<void> {
    if (!transactionHash || transactionHash === '0x') {
      throw new Error('BROWSERVM_RECEIPT_TRANSACTION_HASH_MISSING');
    }
    if (this.txReceipts.has(transactionHash)) {
      throw new Error(`BROWSERVM_RECEIPT_DUPLICATE_TRANSACTION:${transactionHash}`);
    }
    const transactionIndex = Array.from(this.txReceipts.values())
      .filter(candidate => candidate.blockNumber === this.blockHeight).length;
    const logs = toBrowserVmReceiptLogs([...rawLogs], transactionHash, this.blockHeight);
    this.txReceipts.set(transactionHash, {
      transactionHash,
      blockNumber: this.blockHeight,
      blockHash: this.blockHash,
      from: metadata?.from ?? this.deployerAddress.toString(),
      to: metadata?.to ?? logs[0]?.address ?? null,
      contractAddress: metadata?.contractAddress ?? null,
      status: 'status' in receipt ? receipt.status : 1,
      type: transactionType,
      transactionIndex,
      cumulativeGasUsed: receipt.cumulativeBlockGasUsed.toString(),
      logsBloom: bytesToHex(receipt.bitvector),
      logs,
    });
    this.blockReceiptRoots.set(
      this.blockHeight,
      await computeCanonicalReceiptsRoot(this.canonicalReceiptsAt(this.blockHeight)),
    );
  }

  async executeSignedTx(serializedTx: string): Promise<string> {
    const raw = hexToBytes(serializedTx as `0x${string}`);
    const tx = createTxFromRLP(raw, { common: this.common });
    const result = await this.runTxInBlock(tx);

    if (result.execResult.exceptionError) {
      const err = result.execResult.exceptionError;
      const errInfo = typeof err === 'object' && err ? err as { error?: string; message?: string } : null;
      const errMsg = errInfo?.error || errInfo?.message || JSON.stringify(err);
      throw new Error(`executeSignedTx failed: ${errMsg}`);
    }

    const txHash = bytesToHex(tx.hash());
    return txHash;
  }

  private async ensureEthBalance(address: string, minBalance: bigint): Promise<void> {
    await this.runExclusiveVmOperation(async () => {
      const addr = createAddressFromString(address);
      const account = await this.vm.stateManager.getAccount(addr);
      const balance = account?.balance || 0n;
      if (balance >= minBalance) return;
      const updated = account || createAccount({ nonce: 0n, balance: minBalance });
      updated.balance = minBalance;
      await this.vm.stateManager.putAccount(addr, updated);
    });
  }

  /** Get entity reserves for a token */
  async getReserves(entityId: string, tokenId: number): Promise<bigint> {
    if (!this.depositoryAddress || !this.depositoryInterface) {
      throw new Error('Depository not deployed');
    }

    // Use ethers Interface for ABI encoding (same as mainnet)
    const callData = this.depositoryInterface.encodeFunctionData('_reserves', [entityId, tokenId]);

    const result = await this.runReadOnlyCall({
      to: this.depositoryAddress,
      caller: this.deployerAddress,
      data: hexToBytes(callData as `0x${string}`),
      gasLimit: 100000n,
    });

    if (result.execResult.exceptionError) {
      console.error(`[BrowserVM] getReserves failed:`, result.execResult.exceptionError);
      return 0n;
    }

    const returnData = result.execResult.returnValue;
    if (!returnData || returnData.length === 0) return 0n;

    // Decode return value using ethers Interface
    const decoded = this.depositoryInterface.decodeFunctionResult('_reserves', returnData);
    return decoded[0];
  }

  /** Get total number of tokens */
  async getTokensLength(): Promise<number> {
    if (!this.depositoryAddress || !this.depositoryInterface) {
      throw new Error('Depository not deployed');
    }

    // Use ethers Interface for ABI encoding (same as mainnet)
    const callData = this.depositoryInterface.encodeFunctionData('getTokensLength', []);

    const result = await this.runReadOnlyCall({
      to: this.depositoryAddress,
      caller: this.deployerAddress,
      data: hexToBytes(callData as `0x${string}`),
      gasLimit: 100000n,
    });

    if (result.execResult.exceptionError) {
      console.error(`[BrowserVM] getTokensLength failed:`, result.execResult.exceptionError);
      return 0;
    }

    const returnData = result.execResult.returnValue;
    if (returnData.length === 0) return 0;

    const decoded = this.depositoryInterface.decodeFunctionResult('getTokensLength', returnData);
    return Number(decoded[0]);
  }

  /** Debug: Fund entity reserves (uses admin mintToReserve) - emits ReserveUpdated event */
  async debugFundReserves(entityId: string, tokenId: number, amount: bigint): Promise<EVMEvent[]> {
    if (!this.depositoryAddress || !this.depositoryInterface) {
      throw new Error('Depository not deployed');
    }

    // Use ethers Interface for ABI encoding (same as mainnet)
    // mintToReserve is the onlyAdmin function in Depository.sol
    const callData = this.depositoryInterface.encodeFunctionData('mintToReserve', [entityId, tokenId, amount]);

    const { tx, result } = await this.runTxWithNonce(this.deployerAddress, (currentNonce) =>
      createLegacyTx({
        to: this.depositoryAddress!,
        gasLimit: 1000000n,
        gasPrice: 10n,
        data: hexToBytes(callData as `0x${string}`),
        nonce: currentNonce,
      }, { common: this.common }).sign(this.deployerPrivKey));

    if (result.execResult.exceptionError) {
      throw new Error(`mintToReserve failed: ${result.execResult.exceptionError}`);
    }

    console.log(`[BrowserVM] Funded ${entityId.slice(0, 10)}... with ${amount} of token ${tokenId}`);
    console.log(`[BrowserVM] debugFundReserves: logs=${result.execResult.logs?.length || 0}`);

    // Emit events to j-watcher subscribers
    return await this.emitEvents(
      result.execResult.logs || [],
      bytesToHex(tx.hash()),
    );
  }

  /** Get contract address */
  getAccountAddress(): string {
    return this.accountAddress?.toString() || '0x0';
  }

  getDepositoryAddress(): string {
    return this.depositoryAddress?.toString() || '0x0';
  }

  getEntityProviderAddress(): string {
    return this.entityProviderAddress?.toString() || '0x0';
  }

  /** Get all deployed contract addresses */
  getDeployedContracts(): { account: string; depository: string; entityProvider: string } {
    return {
      account: this.getAccountAddress(),
      depository: this.getDepositoryAddress(),
      entityProvider: this.getEntityProviderAddress(),
    };
  }

  /**
   * R2C (Reserve to Collateral) - Move funds from reserve to bilateral account collateral
   * Emits AccountSettled event for j-watcher
   * Note: Solidity prefundAccount() was deleted - this is BrowserVM-only implementation
   *
   * @param entityId - Entity depositing collateral (must be a valid entityId for Hanko signing)
   * @param counterpartyId - The counterparty entity (must sign the settlement)
   */
  async reserveToCollateralDirect(entityId: string, counterpartyId: string, tokenId: number, amount: bigint): Promise<EVMEvent[]> {
    if (!this.depositoryAddress || !this.depositoryInterface) throw new Error('Depository not deployed');

    // Use settle() with appropriate diffs to achieve R2C effect
    const isLeft = isLeftEntity(entityId, counterpartyId);
    const leftEntity = isLeft ? entityId : counterpartyId;
    const rightEntity = isLeft ? counterpartyId : entityId;

    // R2C: Reduce entity's reserve, increase collateral + ondelta
    const diffs = [{
      tokenId,
      leftDiff: isLeft ? -BigInt(amount) : 0n,
      rightDiff: isLeft ? 0n : -BigInt(amount),
      collateralDiff: BigInt(amount),
      ondeltaDiff: isLeft ? BigInt(amount) : -BigInt(amount),
    }];

    // Generate counterparty signature (REQUIRED)
    const sig = await this.signSettlement(entityId, counterpartyId, diffs, []);

    return this.settle(leftEntity, rightEntity, diffs, [], sig);
  }

  /** Get collateral for an account */
  async getCollateral(entityId: string, counterpartyId: string, tokenId: number): Promise<{ collateral: bigint; ondelta: bigint }> {
    if (!this.depositoryAddress || !this.depositoryInterface) throw new Error('Depository not deployed');

    // Use ethers Interface for ABI encoding (same as mainnet)
    // Solidity mapping: _collaterals(bytes accountKey, uint tokenId) -> AccountCollateral
    // Need to compute accountKey first via accountKey(e1, e2), then call the mapping getter
    const accountKeyData = this.depositoryInterface.encodeFunctionData('accountKey', [entityId, counterpartyId]);
    const accountKeyResult = await this.runReadOnlyCall({
      to: this.depositoryAddress,
      caller: this.deployerAddress,
      data: hexToBytes(accountKeyData as `0x${string}`),
      gasLimit: 100000n,
    });
    if (accountKeyResult.execResult.exceptionError) return { collateral: 0n, ondelta: 0n };
    const accountKeyDecoded = this.depositoryInterface.decodeFunctionResult(
      'accountKey',
      accountKeyResult.execResult.returnValue
    );
    const accountKey = accountKeyDecoded[0];

    const callData = this.depositoryInterface.encodeFunctionData('_collaterals', [accountKey, tokenId]);

    const result = await this.runReadOnlyCall({
      to: this.depositoryAddress,
      caller: this.deployerAddress,
      data: hexToBytes(callData as `0x${string}`),
      gasLimit: 100000n,
    });

    if (result.execResult.exceptionError) return { collateral: 0n, ondelta: 0n };
    const returnData = result.execResult.returnValue;
    if (!returnData || returnData.length === 0) return { collateral: 0n, ondelta: 0n };

    // _collaterals returns AccountCollateral struct: { collateral: uint256, ondelta: int256 }
    const decoded = this.depositoryInterface.decodeFunctionResult('_collaterals', returnData);
    return { collateral: BigInt(decoded[0]), ondelta: BigInt(decoded[1]) };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SIGNATURE GENERATION FOR HANKO-COMPATIBLE OPERATIONS
  // ═══════════════════════════════════════════════════════════════════════════

  // Cache of entity wallets (entityId -> wallet)
  private entityWallets: Map<string, ethers.Wallet> = new Map();

  /**
   * Create a deterministic entityId from a seed (name/number).
   * Returns a padded wallet address for local testing.
   *
   * NOTE: Hanko verification expects entityId to be a board hash or a numbered entity ID.
   */
  createEntityId(seed: string | number): string {
    const seedStr = typeof seed === 'number' ? `entity_${seed}` : seed;
    const privateKey = ethers.keccak256(ethers.toUtf8Bytes(seedStr));
    const wallet = new ethers.Wallet(privateKey);

    // Pad address to bytes32 (left-pad with zeros)
    const entityId = '0x' + wallet.address.slice(2).toLowerCase().padStart(64, '0');

    // Cache the wallet for later signing
    this.entityWallets.set(entityId.toLowerCase(), wallet);

    return entityId;
  }

  /** Get an explicitly registered wallet for an Entity. */
  getEntityWallet(entityId: string): ethers.Wallet {
    const normalized = entityId.toLowerCase();

    // Check cache first
    const cached = this.entityWallets.get(normalized);
    if (cached) return cached;

    // Try to extract address from entityId and find matching wallet
    // entityId format: 0x000...000<address>
    const addressPart = '0x' + normalized.slice(-40);

    // Check if we have a wallet for this address
    for (const [, wallet] of this.entityWallets) {
      if (wallet.address.toLowerCase() === addressPart.toLowerCase()) {
        this.entityWallets.set(normalized, wallet);
        return wallet;
      }
    }

    throw new Error(
      `BrowserVM missing wallet for entity ${entityId.slice(0, 20)}... ` +
      `(registerEntityWallet must bind an Env-derived key explicitly)`
    );
  }

  private getSigningWallet(entityId: string): ethers.Wallet {
    const normalized = entityId.toLowerCase();
    const cached = this.entityWallets.get(normalized);
    if (cached) return cached;

    throw new Error(
      `Cannot sign: no explicitly registered wallet for entity ${entityId.slice(0, 20)}...`,
    );
  }

  /**
   * Register an existing wallet for an entityId.
   * Use when entityId was created externally but you have the key.
   */
  registerEntityWallet(entityId: string, privateKey: string): void {
    const wallet = new ethers.Wallet(privateKey);
    const normalizedEntityId = entityId.toLowerCase();
    const existing = this.entityWallets.get(normalizedEntityId);
    if (existing) {
      if (existing.address.toLowerCase() !== wallet.address.toLowerCase()) {
        throw new Error(
          `BROWSERVM_ENTITY_WALLET_CONFLICT:${normalizedEntityId}:` +
          `${existing.address.toLowerCase()}:${wallet.address.toLowerCase()}`,
        );
      }
      return;
    }
    this.entityWallets.set(normalizedEntityId, wallet);
  }

  /**
   * Get the account key for two entities (canonical order: left < right)
   */
  private getAccountKey(leftEntity: string, rightEntity: string): string {
    const isLeft = isLeftEntity(leftEntity, rightEntity);
    const left = isLeft ? leftEntity : rightEntity;
    const right = isLeft ? rightEntity : leftEntity;
    return ethers.solidityPacked(['bytes32', 'bytes32'], [left, right]);
  }

  /**
   * Sign a settlement message (CooperativeUpdate).
   * The COUNTERPARTY must sign, not the initiator.
   *
   * Uses Hanko signature format for entity-level verification.
   */
  async signSettlement(
    initiatorEntityId: string,
    counterpartyEntityId: string,
    diffs: Array<{
      tokenId: number;
      leftDiff: bigint;
      rightDiff: bigint;
      collateralDiff: bigint;
      ondeltaDiff: bigint;
    }>,
    forgiveDebtsInTokenIds: number[] = []
  ): Promise<string> {
    // Get current nonce from chain
    const accountInfo = await this.getAccountInfo(initiatorEntityId, counterpartyEntityId);
    const jNonce = accountInfo.nonce + 1n;

    // Determine canonical left/right order
    const isLeft = isLeftEntity(initiatorEntityId, counterpartyEntityId);
    const leftEntity = isLeft ? initiatorEntityId : counterpartyEntityId;
    const rightEntity = isLeft ? counterpartyEntityId : initiatorEntityId;
    const accountKey = this.getAccountKey(leftEntity, rightEntity);
    if (!this.depositoryAddress) throw new Error('Depository not deployed');

    const hash = hashCooperativeUpdateHankoPayload(
      { chainId: this.getChainId(), depositoryAddress: this.depositoryAddress.toString() },
      accountKey,
      jNonce,
      diffs,
      forgiveDebtsInTokenIds,
    );
    console.log(`[BrowserVM] signSettlement:`);
    console.log(`  hash: ${hash}`);
    console.log(`  accountKey: ${accountKey} (${(accountKey.length - 2) / 2} bytes)`);
    console.log(`  nonce: ${jNonce}`);
    console.log(`  diffs: ${JSON.stringify(diffs.map(d => ({ tokenId: d.tokenId, leftDiff: d.leftDiff.toString(), rightDiff: d.rightDiff.toString(), collateralDiff: d.collateralDiff.toString(), ondeltaDiff: d.ondeltaDiff.toString() })))}`);

    const counterpartyWallet = this.getSigningWallet(counterpartyEntityId);
    const hankoEncoded = buildSingleSignerHanko(counterpartyEntityId, hash, counterpartyWallet.privateKey);
    console.log(`[BrowserVM] Built Hanko signature for entity ${counterpartyEntityId.slice(0, 10)}... (signer=${counterpartyWallet.address.slice(0, 10)}...)`);
    return hankoEncoded;
  }

  /**
   * Sign a dispute proof message.
   * The COUNTERPARTY must sign to prove they agreed to this state.
   */
  async signDisputeProof(
    entityId: string,
    counterpartyEntityId: string,
    nonce: bigint,
    proofbodyHash: string,
    watchSeed: string,
  ): Promise<string> {
    const accountKey = this.getAccountKey(entityId, counterpartyEntityId);
    if (!this.depositoryAddress) throw new Error('Depository not deployed');

    const hash = hashDisputeProofHankoPayload(
      { chainId: this.getChainId(), depositoryAddress: this.depositoryAddress.toString() },
      accountKey,
      nonce,
      proofbodyHash,
      watchSeed,
    );
    const counterpartyWallet = this.getSigningWallet(counterpartyEntityId);
    return buildSingleSignerHanko(counterpartyEntityId, hash, counterpartyWallet.privateKey);
  }

  // ═══════════════════════════════════════════════════════════════════════════

  /** Get on-chain account info (nonce, disputeHash, disputeTimeout) */
  async getAccountInfo(entityId: string, counterpartyId: string): Promise<{ nonce: bigint; disputeHash: string; disputeTimeout: bigint }> {
    if (!this.depositoryAddress || !this.depositoryInterface) throw new Error('Depository not deployed');

    const accountKeyData = this.depositoryInterface.encodeFunctionData('accountKey', [entityId, counterpartyId]);
    const accountKeyResult = await this.runReadOnlyCall({
      to: this.depositoryAddress,
      caller: this.deployerAddress,
      data: hexToBytes(accountKeyData as `0x${string}`),
      gasLimit: 100000n,
    });
    if (accountKeyResult.execResult.exceptionError) {
      throw new Error(
        `BROWSERVM_ACCOUNT_KEY_READ_FAILED:${safeStringify(accountKeyResult.execResult.exceptionError)}`,
      );
    }
    const accountKeyDecoded = this.depositoryInterface.decodeFunctionResult(
      'accountKey',
      accountKeyResult.execResult.returnValue
    );
    const accountKey = accountKeyDecoded[0];

    const callData = this.depositoryInterface.encodeFunctionData('_accounts', [accountKey]);
    const result = await this.runReadOnlyCall({
      to: this.depositoryAddress,
      caller: this.deployerAddress,
      data: hexToBytes(callData as `0x${string}`),
      gasLimit: 100000n,
    });
    if (result.execResult.exceptionError) {
      throw new Error(
        `BROWSERVM_ACCOUNT_INFO_READ_FAILED:${safeStringify(result.execResult.exceptionError)}`,
      );
    }

    const decoded = this.depositoryInterface.decodeFunctionResult('_accounts', result.execResult.returnValue);
    return {
      nonce: BigInt(decoded[0]),
      disputeHash: decoded[1],
      disputeTimeout: BigInt(decoded[2]),
    };
  }

  /** Read the active FIFO debt queue through the current public mapping ABI. */
  async getDebts(entityId: string, tokenId: number): Promise<Array<{ amount: bigint; creditor: string }>> {
    if (!this.depositoryAddress || !this.depositoryInterface) throw new Error('Depository not deployed');

    const readUint = async (functionName: '_debtIndex' | '_activeDebtsByToken' | 'debtOutstanding'): Promise<bigint> => {
      const call = this.depositoryInterface!.encodeFunctionData(functionName, [entityId, tokenId]);
      const result = await this.runReadOnlyCall({
        to: this.depositoryAddress!,
        caller: this.deployerAddress,
        data: hexToBytes(call as `0x${string}`),
        gasLimit: 500_000n,
      });
      if (result.execResult.exceptionError) {
        throw new Error(
          `BROWSERVM_DEBT_METADATA_READ_FAILED:function=${functionName}:` +
          `${safeStringify(result.execResult.exceptionError)}`,
        );
      }
      const [value] = this.depositoryInterface!.decodeFunctionResult(
        functionName,
        result.execResult.returnValue,
      );
      return BigInt(value);
    };
    const [cursor, activeCount, outstanding] = await Promise.all([
      readUint('_debtIndex'),
      readUint('_activeDebtsByToken'),
      readUint('debtOutstanding'),
    ]);
    if (activeCount > BigInt(MAX_BROWSER_VM_DEBT_QUEUE_READS)) {
      throw new Error(
        `BROWSERVM_DEBT_QUEUE_READ_LIMIT:entity=${entityId}:token=${tokenId}:` +
        `active=${activeCount}:limit=${MAX_BROWSER_VM_DEBT_QUEUE_READS}`,
      );
    }
    const debts: Array<{ amount: bigint; creditor: string }> = [];
    let observedOutstanding = 0n;

    for (let offset = 0n; offset < activeCount; offset += 1n) {
      const index = cursor + offset;
      const debtCall = this.depositoryInterface.encodeFunctionData('_debts', [entityId, tokenId, index]);
      const debtResult = await this.runReadOnlyCall({
        to: this.depositoryAddress,
        caller: this.deployerAddress,
        data: hexToBytes(debtCall as `0x${string}`),
        gasLimit: 500_000n,
      });
      if (debtResult.execResult.exceptionError) {
        throw new Error(
          `BROWSERVM_DEBT_ENTRY_READ_FAILED:index=${index}:` +
          `${safeStringify(debtResult.execResult.exceptionError)}`,
        );
      }
      const [creditor, amountRaw] = this.depositoryInterface.decodeFunctionResult(
        '_debts',
        debtResult.execResult.returnValue,
      );
      const amount = BigInt(amountRaw);
      if (amount <= 0n) throw new Error(`BROWSERVM_DEBT_ENTRY_ZERO:index=${index}`);
      observedOutstanding += amount;
      debts.push({ creditor: String(creditor), amount });
    }

    if (observedOutstanding !== outstanding) {
      throw new Error(
        `BROWSERVM_DEBT_OUTSTANDING_MISMATCH:entity=${entityId}:token=${tokenId}:` +
        `observed=${observedOutstanding}:contract=${outstanding}`,
      );
    }
    return debts;
  }

  /** Enforce debts (FIFO) */
  async enforceDebts(entityId: string, tokenId: number, maxIterations: number | bigint = 100n): Promise<void> {
    if (!this.depositoryAddress || !this.depositoryInterface) throw new Error('Depository not deployed');

    // Use ethers Interface for ABI encoding (same as mainnet)
    const callData = this.depositoryInterface.encodeFunctionData('enforceDebts', [entityId, tokenId, BigInt(maxIterations)]);

    const { result } = await this.runTxWithNonce(this.deployerAddress, (currentNonce) =>
      createLegacyTx({
        to: this.depositoryAddress!,
        gasLimit: 2000000n,
        gasPrice: 10n,
        data: hexToBytes(callData as `0x${string}`),
        nonce: currentNonce,
      }, { common: this.common }).sign(this.deployerPrivKey));

    if (result.execResult.exceptionError) {
      console.error(`[BrowserVM] enforceDebts failed:`, result.execResult.exceptionError);
      throw new Error(`enforceDebts failed: ${String(result.execResult.exceptionError)}`);
    }
    console.log(`[BrowserVM] Enforced debts for ${entityId.slice(0, 10)}...`);
  }

  /** Process batch (Hanko) - calls Depository.processBatch() directly (no TS logic duplication) */
  async processBatch(encodedBatch: string, hankoData: string, nonce: bigint): Promise<EVMEvent[]> {
    return this.processBatchWithSigner(encodedBatch, hankoData, nonce, this.deployerPrivKey);
  }

  async processBatchAs(
    encodedBatch: string,
    hankoData: string,
    nonce: bigint,
    txPrivKey: Uint8Array,
  ): Promise<EVMEvent[]> {
    return this.processBatchWithSigner(encodedBatch, hankoData, nonce, txPrivKey);
  }

  private async processBatchWithSigner(
    encodedBatch: string,
    hankoData: string,
    nonce: bigint,
    txPrivKey: Uint8Array,
  ): Promise<EVMEvent[]> {
    if (!this.depositoryAddress || !this.depositoryInterface) {
      throw new Error('Depository not deployed');
    }

    console.log(`[BrowserVM] processBatch: calling contract with hanko (nonce=${nonce})...`);

    // BrowserVM submits as admin to mirror J-machine execution (Hanko still enforced on-chain).
    // Call Depository.processBatch() - ALL logic in Solidity (single source of truth)
    const callData = this.depositoryInterface.encodeFunctionData('processBatch', [encodedBatch, hankoData, nonce]);

    const { tx, result } = await this.runTxWithNonce(
      createAddressFromPrivateKey(txPrivKey),
      (currentNonce) => createLegacyTx({
        to: this.depositoryAddress!,
        gasLimit: 10000000n,
        gasPrice: 10n,
        data: hexToBytes(callData as `0x${string}`),
        nonce: currentNonce,
      }, { common: this.common }).sign(txPrivKey),
    );

    if (result.execResult.exceptionError) {
      let claimedEntityId: string | null = null;
      let expectedNextNonce: bigint | null = null;
      let batchSummary: string | null = null;
      let revertReason: string | null = null;
      const returnData = bytesToHex(result.execResult.returnValue || new Uint8Array());
      try {
        const claims = decodeHankoEnvelope(hankoData).claims;
        if (claims.length > 0) {
          claimedEntityId = claims[claims.length - 1]!.entityId;
          expectedNextNonce = (await this.getEntityNonce(claimedEntityId)) + 1n;
        }
        const batch = decodeJBatch(encodedBatch);
        batchSummary = safeStringify(summarizeBatch(batch));
        if (returnData !== '0x') {
          try {
            const parsed = this.depositoryInterface?.parseError(returnData);
            if (parsed) {
              revertReason = `${parsed.name}(${parsed.args?.map((arg: unknown) => String(arg)).join(', ')})`;
            }
          } catch {
            // fall through
          }
          if (!revertReason && returnData.startsWith('0x08c379a0')) {
            try {
              const decodedReason = ethers.AbiCoder.defaultAbiCoder().decode(
                ['string'],
                `0x${returnData.slice(10)}`
              );
              revertReason = String(decodedReason[0]);
            } catch {
              // best-effort only
            }
          }
        }
      } catch {
        // best-effort debug only
      }
      console.log('[BrowserVM] processBatch revert:', safeStringify(result.execResult.exceptionError));
      if (returnData !== '0x') {
        console.log('  returnData:', returnData);
      }
      if (revertReason) {
        console.log('  revertReason:', revertReason);
      }
      if (claimedEntityId) {
        console.log(`[BrowserVM] Hanko entity=${claimedEntityId.slice(0, 10)}..., nonce=${nonce} expectedNext=${expectedNextNonce}`);
      }
      if (batchSummary) {
        console.log(`[BrowserVM] Batch summary: ${batchSummary}`);
      }
      const errorLabel = result.execResult.exceptionError.error || 'revert';
      const reasonSuffix = revertReason ? ` (${revertReason})` : '';
      throw new Error(`Batch processing failed: ${errorLabel}${reasonSuffix}`);
    }

    // Log raw events before parsing
    const rawLogs = result.execResult.logs || [];
    console.log(`[BrowserVM] processBatch raw logs: ${rawLogs.length}`);
    (rawLogs as EthereumLog[]).forEach((log, i) => {
      console.log(`   Log ${i}: topics=${log[1]?.length || 0}, data=${log[2]?.length || 0} bytes`);
    });

    const events = await this.emitEvents(rawLogs, bytesToHex(tx.hash()));
    console.log(`[BrowserVM] ✅ Batch processed: ${events.length} events`);
    events.forEach(e => console.log(`   - ${e.name}`));

    return events;
  }

  /** Execute one already quorum-sealed EntityProvider action. */
  async submitEntityProviderAction(
    intent: EntityProviderActionIntent,
    hankoData: string,
    expected: {
      entityId: string;
      kind: EntityProviderActionIntent['payload']['kind'];
    },
  ): Promise<EVMEvent[]> {
    if (!this.entityProviderAddress || !this.entityProviderInterface) {
      throw new Error('EntityProvider not deployed');
    }
    if (!/^0x[0-9a-f]+$/i.test(hankoData) || hankoData.length <= 2) {
      throw new Error('ENTITY_PROVIDER_ACTION_HANKO_MISSING');
    }
    assertEntityProviderActionIntent(intent, {
      chainId: this.getChainId(),
      entityProviderAddress: this.entityProviderAddress.toString(),
      depositoryAddress: this.depositoryAddress?.toString() ?? '',
      entityId: normalizeEntityId(expected.entityId),
      expectedKind: expected.kind,
    });
    const chainNonce = await this.getEntityProviderActionNonce(intent.entityId);
    if (chainNonce >= intent.actionNonce) {
      const receipt = this.getEntityProviderActionReceipt(intent.entityId, intent.actionNonce);
      if (!receipt) {
        throw new Error(
          `ENTITY_PROVIDER_ACTION_NONCE_CONSUMED_WITHOUT_RECEIPT:` +
          `${intent.entityId}:${intent.actionNonce.toString()}:${chainNonce.toString()}`,
        );
      }
      assertEntityProviderActionResolutionReceipt(intent, receipt);
      return [receipt];
    }
    if (chainNonce + 1n !== intent.actionNonce) {
      throw new Error(
        `ENTITY_PROVIDER_ACTION_CHAIN_NONCE_MISMATCH:` +
        `${intent.actionNonce.toString()}:${(chainNonce + 1n).toString()}`,
      );
    }
    const callData = intent.payload.kind === 'entityTransferTokens'
      ? this.entityProviderInterface.encodeFunctionData('entityTransferTokens', [
          intent.entityNumber,
          intent.payload.transfer.to,
          intent.payload.transfer.tokenId,
          intent.payload.transfer.amount,
          hankoData,
        ])
      : intent.payload.kind === 'releaseControlShares'
        ? this.entityProviderInterface.encodeFunctionData('releaseControlShares', [
            intent.entityNumber,
            intent.payload.release.depositoryAddress,
            intent.payload.release.controlAmount,
            intent.payload.release.dividendAmount,
            intent.payload.release.purpose,
            hankoData,
          ])
        : this.entityProviderInterface.encodeFunctionData('cancelEntityProviderAction', [
            intent.entityNumber,
            intent.payload.cancel.cancelledActionHash,
            intent.payload.cancel.cancelledActionKind,
            hankoData,
          ]);
    const { tx, result } = await this.runTxWithNonce(this.deployerAddress, (currentNonce) =>
      createLegacyTx({
        to: this.entityProviderAddress!,
        gasLimit: 10_000_000n,
        gasPrice: 10n,
        data: hexToBytes(callData as `0x${string}`),
        nonce: currentNonce,
      }, { common: this.common }).sign(this.deployerPrivKey));
    if (result.execResult.exceptionError) {
      const returnData = bytesToHex(result.execResult.returnValue || new Uint8Array());
      let reason = String(result.execResult.exceptionError.error || result.execResult.exceptionError);
      if (returnData !== '0x') {
        try {
          const parsed = this.entityProviderInterface.parseError(returnData);
          if (parsed) reason = `${parsed.name}(${parsed.args.map((arg: unknown) => String(arg)).join(',')})`;
        } catch {
          // The raw EVM error and return bytes remain in the thrown failure.
        }
      }
      throw new Error(`ENTITY_PROVIDER_ACTION_SUBMIT_FAILED:${reason}:returnData=${returnData}`);
    }
    const events = await this.emitEvents(result.execResult.logs || [], bytesToHex(tx.hash()));
    const exact = events.filter((event) =>
      event.name === 'EntityProviderActionExecuted' || event.name === 'EntityProviderActionCancelled');
    if (exact.length !== 1) {
      throw new Error(`ENTITY_PROVIDER_ACTION_RECEIPT_COUNT_INVALID:${exact.length}`);
    }
    assertEntityProviderActionResolutionReceipt(intent, exact[0]!);
    return events;
  }

  async processEntityBatch(
    entityId: string,
    batch: import('../jurisdiction/batch').JBatch,
    hankoPrivKey: Uint8Array,
    txPrivKey: Uint8Array = this.deployerPrivKey,
  ): Promise<EVMEvent[]> {
    if (!this.depositoryAddress || !this.entityProviderAddress) {
      throw new Error('Depository not deployed');
    }
    const currentEntityNonce = await this.getEntityNonce(entityId);
    const { encodedBatch, hankoData, nextNonce } = prepareSignedBatch(
      batch,
      entityId,
      hankoPrivKey,
      BigInt(this.common.chainId()),
      this.depositoryAddress.toString(),
      currentEntityNonce,
    );
    return this.processBatchWithSigner(
      encodedBatch,
      hankoData,
      nextNonce,
      txPrivKey,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //                              TIME TRAVEL (J-MACHINE STATE)
  // ═══════════════════════════════════════════════════════════════════════════

  /** Capture current EVM state root (32 bytes) - for JReplica */
  async captureStateRoot(): Promise<Uint8Array> {
    return await this.runExclusiveVmOperation(async () => this.vm.stateManager.getStateRoot());
  }

  captureChainCheckpoint(): BrowserVmChainCheckpoint {
    return {
      blockHeight: this.blockHeight,
      blockHash: this.blockHash,
      blockTimestamp: this.blockTimestamp,
      entityProviderDeploymentBlock: this.entityProviderDeploymentBlock,
      blockHashes: [...this.blockHashes.entries()],
      blockReceiptRoots: [...this.blockReceiptRoots.entries()],
      txReceipts: [...this.txReceipts.entries()].map(([hash, receipt]) => [hash, {
        ...receipt,
        logs: receipt.logs.map((log) => ({ ...log, topics: [...log.topics] })),
      }]),
    };
  }

  private async validateChainCheckpoint(
    checkpoint: BrowserVmChainCheckpoint,
  ): Promise<ValidatedBrowserVmChainCheckpoint> {
    if (!Number.isSafeInteger(checkpoint.blockHeight) || checkpoint.blockHeight < 0) {
      throw new Error(`BROWSERVM_CHECKPOINT_HEIGHT_INVALID:${String(checkpoint.blockHeight)}`);
    }
    if (!Number.isFinite(checkpoint.blockTimestamp) || checkpoint.blockTimestamp < 0) {
      throw new Error(`BROWSERVM_CHECKPOINT_TIMESTAMP_INVALID:${String(checkpoint.blockTimestamp)}`);
    }
    if (
      !Number.isSafeInteger(checkpoint.entityProviderDeploymentBlock) ||
      checkpoint.entityProviderDeploymentBlock < 1 ||
      checkpoint.entityProviderDeploymentBlock > checkpoint.blockHeight
    ) {
      throw new Error(
        `BROWSERVM_CHECKPOINT_ENTITY_PROVIDER_BLOCK_INVALID:${String(checkpoint.entityProviderDeploymentBlock)}`,
      );
    }
    const blockHash = normalizeCheckpointHash(checkpoint.blockHash, 'BROWSERVM_CHECKPOINT_HASH_INVALID');
    const blockHashes = checkpointBlockHashes(checkpoint);
    if (checkpoint.blockHeight > 0 && blockHashes.get(checkpoint.blockHeight) !== blockHash) {
      throw new Error(`BROWSERVM_CHECKPOINT_TIP_MISMATCH:${checkpoint.blockHeight}`);
    }
    const blockReceiptRoots = checkpointReceiptRoots(checkpoint);
    const txReceipts = checkpointReceipts(checkpoint, blockHashes);
    await assertCheckpointReceiptRoots(txReceipts, blockReceiptRoots);
    return { blockHashes, blockReceiptRoots, txReceipts };
  }

  private applyChainCheckpoint(
    checkpoint: BrowserVmChainCheckpoint,
    validated: ValidatedBrowserVmChainCheckpoint,
  ): void {
    this.blockHeight = checkpoint.blockHeight;
    this.blockHash = checkpoint.blockHash.toLowerCase();
    this.blockTimestamp = checkpoint.blockTimestamp;
    this.entityProviderDeploymentBlock = checkpoint.entityProviderDeploymentBlock;
    this.blockHashes = validated.blockHashes;
    this.blockReceiptRoots = validated.blockReceiptRoots;
    this.txReceipts = validated.txReceipts;
    this.activeBlock = null;
    this.activeBlockGasUsed = 0n;
  }

  async restoreChainCheckpoint(checkpoint: BrowserVmChainCheckpoint): Promise<void> {
    await this.runExclusiveVmOperation(async () => {
      const validated = await this.validateChainCheckpoint(checkpoint);
      this.applyChainCheckpoint(checkpoint, validated);
    });
  }

  /** Time travel to historical state root */
  async timeTravel(stateRoot: Uint8Array): Promise<void> {
    await this.runExclusiveVmOperation(async () => this.vm.stateManager.setStateRoot(stateRoot));
    this.log(`[BrowserVM] Time traveled to state root: ${Buffer.from(stateRoot).toString('hex').slice(0, 16)}...`);
  }

  /** Get current block number */
  getBlockNumber(): bigint {
    return BigInt(this.blockHeight);
  }

  getEntityProviderDeploymentBlock(): number {
    if (!Number.isSafeInteger(this.entityProviderDeploymentBlock) || this.entityProviderDeploymentBlock < 1) {
      throw new Error('BROWSERVM_ENTITY_PROVIDER_DEPLOYMENT_BLOCK_UNAVAILABLE');
    }
    return this.entityProviderDeploymentBlock;
  }

  getBlockTimestamp(): number {
    return this.blockTimestamp;
  }

  /** Mine a real empty jurisdiction block without fabricating a transaction. */
  async mineEmptyBlock(timestampMs = this.blockTimestamp + 1_000): Promise<number> {
    return await this.runExclusiveVmOperation(async () => {
      if (this.activeBlock) throw new Error('BROWSERVM_EMPTY_BLOCK_DURING_ACTIVE_BLOCK');
      this.createBlock(timestampMs);
      return this.blockHeight;
    });
  }

  /** Get chainId for batch hanko hashing */
  getChainId(): bigint {
    if (!this.common) return BigInt(this.configuredChainId);
    const id = (this.common as EthereumCommon & { chainId?: () => bigint | number }).chainId?.();
    if (typeof id === 'bigint') return id;
    if (typeof id === 'number') return BigInt(id);
    return BigInt(this.configuredChainId);
  }

  /** Get current entity batch nonce (Depository.entityNonces) */
  async getEntityNonce(entityId: string): Promise<bigint> {
    if (!this.depositoryAddress || !this.depositoryInterface) {
      throw new Error('Depository not deployed');
    }
    const normalizedEntityId = normalizeEntityId(entityId);
    const callData = this.depositoryInterface.encodeFunctionData('entityNonces', [normalizedEntityId]);
    const result = await this.runReadOnlyCall({
      to: this.depositoryAddress,
      caller: this.deployerAddress,
      data: hexToBytes(callData as `0x${string}`),
      gasLimit: 100000n,
    });
    if (result.execResult.exceptionError) {
      return 0n;
    }
    const decoded = this.depositoryInterface.decodeFunctionResult('entityNonces', result.execResult.returnValue);
    return BigInt(decoded[0]);
  }

  /** Current EntityProvider action nonce from the local VM contract. */
  async getEntityProviderActionNonce(entityId: string): Promise<bigint> {
    if (!this.entityProviderAddress || !this.entityProviderInterface) {
      throw new Error('EntityProvider not deployed');
    }
    const normalizedEntityId = normalizeEntityId(entityId);
    const callData = this.entityProviderInterface.encodeFunctionData('entityActionNonces', [normalizedEntityId]);
    const result = await this.runReadOnlyCall({
      to: this.entityProviderAddress,
      caller: this.deployerAddress,
      data: hexToBytes(callData as `0x${string}`),
      gasLimit: 100_000n,
    });
    if (result.execResult.exceptionError) {
      throw new Error(`BROWSERVM_ENTITY_PROVIDER_NONCE_READ_FAILED:${normalizedEntityId}`);
    }
    const decoded = this.entityProviderInterface.decodeFunctionResult(
      'entityActionNonces',
      result.execResult.returnValue,
    );
    return BigInt(decoded[0]);
  }

  hasProcessedBatch(entityId: string, batchHash: string, entityNonce: bigint): boolean {
    if (!this.depositoryAddress || !this.depositoryInterface) {
      throw new Error('Depository not deployed');
    }
    const event = this.depositoryInterface.getEvent('HankoBatchProcessed');
    if (!event) throw new Error('BROWSERVM_HANKO_BATCH_EVENT_ABI_MISSING');
    const logs = this.getLogs({
      address: this.depositoryAddress.toString(),
      topics: [
        event.topicHash,
        ethers.zeroPadValue(normalizeEntityId(entityId), 32),
        ethers.zeroPadValue(batchHash, 32),
      ],
    }).filter((log) => {
      const parsed = this.depositoryInterface!.parseLog({ topics: log.topics, data: log.data });
      return parsed?.name === 'HankoBatchProcessed' &&
        BigInt(parsed.args['nonce']) === entityNonce &&
        parsed.args['success'] === true;
    });
    if (logs.length > 1) {
      throw new Error(
        `BROWSERVM_HANKO_BATCH_RECEIPT_DUPLICATE:${entityId}:${batchHash}:${entityNonce.toString()}`,
      );
    }
    return logs.length === 1;
  }

  getEntityProviderActionReceipt(
    entityId: string,
    actionNonce: bigint,
  ): EVMEvent | null {
    if (!this.entityProviderAddress || !this.entityProviderInterface) {
      throw new Error('EntityProvider not deployed');
    }
    const logs = (['EntityProviderActionExecuted', 'EntityProviderActionCancelled'] as const)
      .flatMap((eventName) => {
        const event = this.entityProviderInterface!.getEvent(eventName);
        if (!event) throw new Error(`BROWSERVM_ENTITY_PROVIDER_ACTION_EVENT_ABI_MISSING:${eventName}`);
        return this.getLogs({
          address: this.entityProviderAddress!.toString(),
          topics: [
            event.topicHash,
            ethers.zeroPadValue(normalizeEntityId(entityId), 32),
            ethers.zeroPadValue(ethers.toBeHex(actionNonce), 32),
          ],
        });
      });
    if (logs.length > 1) {
      throw new Error(`BROWSERVM_ENTITY_PROVIDER_RECEIPT_DUPLICATE:${entityId}:${actionNonce.toString()}`);
    }
    const log = logs[0];
    if (!log) return null;
    const parsed = this.entityProviderInterface.parseLog({ topics: log.topics, data: log.data });
    if (
      !parsed ||
      (parsed.name !== 'EntityProviderActionExecuted' && parsed.name !== 'EntityProviderActionCancelled')
    ) {
      throw new Error(`BROWSERVM_ENTITY_PROVIDER_RECEIPT_DECODE_FAILED:${log.transactionHash}`);
    }
    return {
      name: parsed.name,
      args: Object.fromEntries(parsed.fragment.inputs.map((input, index) => [input.name, parsed.args[index]])),
      blockNumber: log.blockNumber,
      blockHash: log.blockHash,
      transactionHash: log.transactionHash,
      logIndex: log.logIndex,
      timestamp: this.blockTimestamp,
    };
  }

  /** Check if initialized */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Execute settlement.
   * Signature is required for state changes.
   *
   * @param leftEntity - The left entity (smaller entityId)
   * @param rightEntity - The right entity (larger entityId)
   * @param sig - Hanko signature from counterparty (required if there are changes).
   */
  async settle(
    leftEntity: string,
    rightEntity: string,
    diffs: Array<{
      tokenId: number;
      leftDiff: bigint;
      rightDiff: bigint;
      collateralDiff: bigint;
      ondeltaDiff: bigint;
    }>,
    forgiveDebtsInTokenIds: number[] = [],
    sig?: string
  ): Promise<EVMEvent[]> {
    const hasChanges = diffs.length > 0 || forgiveDebtsInTokenIds.length > 0;
    const finalSig = sig || '0x';
    if (hasChanges && finalSig === '0x') {
      throw new Error('Settlement signature required for settle');
    }

    const accountInfo = await this.getAccountInfo(leftEntity, rightEntity);
    const settlementNonce = Number(accountInfo.nonce + 1n);
    const batch = createEmptyBatch();
    batchAddSettlement(
      { batch, jurisdiction: null, lastBroadcast: 0, broadcastCount: 0, failedAttempts: 0, status: 'empty' },
      leftEntity,
      rightEntity,
      diffs,
      forgiveDebtsInTokenIds,
      finalSig,
      this.entityProviderAddress?.toString() || ethers.ZeroAddress,
      '0x',
      settlementNonce,
    );
    const signerWallet = this.getSigningWallet(leftEntity);
    return this.processEntityBatch(leftEntity, batch, ethers.getBytes(signerWallet.privateKey));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  ENTITY PROVIDER QUERIES - Real contract calls via BrowserVM
  // ═══════════════════════════════════════════════════════════════════════════

  /** Subscribe to all EVM events - j-watcher uses this for BrowserVM mode */
  /**
   * Subscribe to batched events. Callback receives ALL events from a single
   * transaction/block together, matching real blockchain behavior.
   */
  onAny(callback: (events: EVMEvent[]) => void | Promise<void>): () => void {
    this.eventCallbacks.add(callback);
    this.log(`[BrowserVM] onAny registered (${this.eventCallbacks.size} callbacks)`);
    return () => {
      this.eventCallbacks.delete(callback);
      this.log(`[BrowserVM] onAny unsubscribed (${this.eventCallbacks.size} callbacks)`);
    };
  }

  /**
   * Emit events to all registered callbacks as a BATCH.
   * All events from one transaction are sent together, matching blockchain behavior.
   */
  private async emitEvents(
    logs: EthereumLog[],
    transactionHash: string | undefined,
  ): Promise<EVMEvent[]> {
    this.log(`🔊 [BrowserVM] emitEvents ENTRY: raw logs=${logs.length}, callbacks=${this.eventCallbacks.size}`);
    if (logs.length > 0 && !transactionHash) {
      throw new Error('BROWSERVM_EVENT_TRANSACTION_HASH_MISSING');
    }
    const events = decodeBrowserVmEvents(
      logs,
      [this.depositoryInterface, this.accountInterface, this.entityProviderInterface],
      this.blockHeight,
      this.blockHash,
      this.blockTimestamp,
      transactionHash,
    );
    this.log(`🔊 [BrowserVM] emitEvents: parsed ${events.length} events`);

    // Log individual events for debugging
    for (const event of events) {
      this.log(`   📣 EVENT: ${event.name} | ${safeStringify(event.args).slice(0, 80)}`);
    }

    // Emit BATCH to each callback (not one-by-one)
    if (events.length > 0) {
      for (const cb of this.eventCallbacks) {
        await cb(events);
        this.log(`   ✓ batch of ${events.length} events fired to callback`);
      }
    }

    return events;
  }

  /** Get next available entity number from EntityProvider contract */
  async getNextEntityNumber(): Promise<number> {
    if (!this.entityProviderAddress || !this.entityProviderInterface) {
      throw new Error('EntityProvider not deployed');
    }

    // Read nextNumber public variable
    const callData = this.entityProviderInterface.encodeFunctionData('nextNumber');

    const result = await this.runReadOnlyCall({
      to: this.entityProviderAddress,
      data: hexToBytes(callData as `0x${string}`),
    });

    if (result.execResult.exceptionError) {
      console.error(`[BrowserVM] getNextEntityNumber failed: ${result.execResult.exceptionError}`);
      return 1;
    }

    const decoded = this.entityProviderInterface.decodeFunctionResult('nextNumber', result.execResult.returnValue);
    return Number(decoded[0]);
  }

  /** Get entity info by ID from EntityProvider contract */
  async getEntityInfo(entityId: string): Promise<{ exists: boolean; name?: string; currentBoardHash?: string; registrationBlock?: number }> {
    if (!this.entityProviderAddress || !this.entityProviderInterface) {
      throw new Error('EntityProvider not deployed');
    }

    // Use getEntityInfo view function
    const callData = this.entityProviderInterface.encodeFunctionData('getEntityInfo', [entityId]);

    const result = await this.runReadOnlyCall({
      to: this.entityProviderAddress,
      data: hexToBytes(callData as `0x${string}`),
    });

    if (result.execResult.exceptionError) {
      console.error(`[BrowserVM] getEntityInfo failed: ${result.execResult.exceptionError}`);
      return { exists: false };
    }

    // Decode: (bool exists, bytes32 currentBoardHash, bytes32 proposedBoardHash, uint256 registrationBlock, string name)
    const decoded = this.entityProviderInterface.decodeFunctionResult('getEntityInfo', result.execResult.returnValue);

    const nameValue = decoded[4] as string;
    const result_obj: { exists: boolean; name?: string; currentBoardHash?: string; registrationBlock?: number } = {
      exists: decoded[0] as boolean,
      currentBoardHash: decoded[1] as string,
      registrationBlock: Number(decoded[3]),
    };
    if (nameValue) {
      result_obj.name = nameValue;
    }
    return result_obj;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //                              STATE PERSISTENCE
  // ═══════════════════════════════════════════════════════════════════════════

  /** Serialize full EVM state (all trie nodes) for persistence */
  async serializeState(): Promise<BrowserVmSerializedState> {
    if (!this.initialized) throw new Error('BrowserVM not initialized');
    return await this.runExclusiveVmOperation(async () => {
      const stateRoot = await this.vm.stateManager.getStateRoot();
      const trieData = serializeBrowserVmTrieData(this.vm);

      this.log(`[BrowserVM] Serialized state: ${trieData.length} trie nodes, version=${BROWSERVM_CONTRACT_VERSION}`);

      return {
        version: BROWSERVM_CONTRACT_VERSION,
        chainId: this.configuredChainId,
        stateRoot: Buffer.from(stateRoot).toString('hex'),
        trieData,
        nonce: this.nonce.toString(),
        entityProviderDeploymentBlock: this.entityProviderDeploymentBlock,
        chain: this.captureChainCheckpoint(),
        addresses: {
          depository: this.depositoryAddress?.toString() || '',
          entityProvider: this.entityProviderAddress?.toString() || '',
        },
      };
    });
  }

  /** Restore EVM state from serialized data (for page reload) */
  async restoreState(data: BrowserVmSerializedState): Promise<void> {
    if (data.version !== BROWSERVM_CONTRACT_VERSION) {
      throw new Error(
        `BROWSERVM_STATE_VERSION_MISMATCH:${String(data.version)}:${BROWSERVM_CONTRACT_VERSION}`,
      );
    }
    const stateChainId = requireBrowserVmChainId(data.chainId, 'BROWSERVM_STATE_CHAIN_ID_INVALID');
    // The runtime's jurisdiction config is authoritative. Never adopt a chain
    // domain from persisted bytes: the same contract state restored under a
    // different block.chainid would invalidate every on-chain Hanko digest.
    if (stateChainId !== this.configuredChainId) {
      throw new Error(
        `BROWSERVM_STATE_CHAIN_ID_MISMATCH:${stateChainId}:${this.configuredChainId}`,
      );
    }
    if (!this.initialized) {
      // Need to init first to get contracts deployed structure
      await this.init({ chainId: this.configuredChainId });
    }
    await this.runExclusiveVmOperation(async () => {
      restoreBrowserVmTrieData(this.vm, data.trieData);
      await this.vm.stateManager.setStateRoot(decodeBrowserVmStateRoot(data.stateRoot));

      try {
        const nonceValue = typeof data.nonce === 'string' ? data.nonce : String(data.nonce ?? '');
        this.nonce = BigInt(nonceValue);
      } catch (error) {
        throw new Error(`BROWSERVM_NONCE_INVALID:${String(data.nonce)}`, { cause: error });
      }

      const deploymentBlock = Number(data.entityProviderDeploymentBlock ?? 0);
      if (!Number.isSafeInteger(deploymentBlock) || deploymentBlock < 1) {
        throw new Error(`BROWSERVM_ENTITY_PROVIDER_DEPLOYMENT_BLOCK_INVALID:${String(data.entityProviderDeploymentBlock)}`);
      }
      this.entityProviderDeploymentBlock = deploymentBlock;

      if (!data.chain) throw new Error('BROWSERVM_CHAIN_STATE_MISSING');
      const validated = await this.validateChainCheckpoint(data.chain);
      this.applyChainCheckpoint(data.chain, validated);

      const depositoryHex = normalizeBrowserVmAddress(data.addresses?.depository);
      if (depositoryHex) {
        this.depositoryAddress = createAddressFromString(`0x${depositoryHex}`);
      }
      const entityProviderHex = normalizeBrowserVmAddress(data.addresses?.entityProvider);
      if (entityProviderHex) {
        this.entityProviderAddress = createAddressFromString(`0x${entityProviderHex}`);
      }

      this.log(`[BrowserVM] Restored state: ${data.trieData.length} trie nodes, root ${data.stateRoot.slice(0, 16)}...`);
    });
  }

  /** Save full EVM state to localStorage */
  async saveToLocalStorage(key: string = 'xln-evm-state'): Promise<void> {
    try {
      const state = await this.serializeState();
      const json = JSON.stringify(state);
      localStorage.setItem(key, json);
      this.log(`[BrowserVM] Saved state to localStorage: ${key} (${(json.length / 1024).toFixed(1)}KB)`);
    } catch (err) {
      console.error('[BrowserVM] Failed to save state:', err);
      throw err;
    }
  }

  /** Load full EVM state from localStorage */
  async loadFromLocalStorage(key: string = 'xln-evm-state'): Promise<boolean> {
    try {
      const json = localStorage.getItem(key);
      if (!json) {
        this.log('[BrowserVM] No saved state found');
        return false;
      }

      const data = JSON.parse(json);

      // Check version - invalidate stale cache if contract ABI changed
      const cachedVersion = data.version || 1; // Pre-version data is v1
      if (cachedVersion !== BROWSERVM_CONTRACT_VERSION) {
        this.log(`[BrowserVM] ⚠️ Version mismatch: cached=${cachedVersion}, current=${BROWSERVM_CONTRACT_VERSION} - clearing stale cache`);
        this.clearLocalStorage(key);
        return false;
      }

      await this.restoreState(data);
      this.log(`[BrowserVM] Loaded state from localStorage: ${key} (v${cachedVersion})`);
      return true;
    } catch (err) {
      console.error('[BrowserVM] Failed to load state:', err);
      this.clearLocalStorage(key);
      return false;
    }
  }

  /** Clear saved state from localStorage */
  clearLocalStorage(key: string = 'xln-evm-state'): void {
    localStorage.removeItem(key);
    this.log(`[BrowserVM] Cleared saved state: ${key}`);
  }

  /** Sync all collaterals from BrowserVM for given account pairs */
  async syncAllCollaterals(
    accountPairs: Array<{ entityId: string; counterpartyId: string }>,
    tokenIds: readonly number[]
  ): Promise<Map<string, Map<number, { collateral: bigint; ondelta: bigint }>>> {
    const collaterals = new Map<string, Map<number, { collateral: bigint; ondelta: bigint }>>();
    const normalizedTokenIds = Array.from(new Set(tokenIds.filter((tokenId) => Number.isFinite(tokenId) && tokenId > 0)));

    for (const { entityId, counterpartyId } of accountPairs) {
      const accountKey = `${entityId}:${counterpartyId}`;
      for (const tokenId of normalizedTokenIds) {
        const data = await this.getCollateral(entityId, counterpartyId, tokenId);
        if (data.collateral > 0n || data.ondelta !== 0n) {
          if (!collaterals.has(accountKey)) {
            collaterals.set(accountKey, new Map());
          }
          collaterals.get(accountKey)!.set(tokenId, data);
        }
      }
    }

    this.log(`[BrowserVM] Synced collaterals for ${accountPairs.length} accounts across ${normalizedTokenIds.length} token(s)`);
    return collaterals;
  }

  /** Get current block height (incremented per J-block) */
  getBlockHeight(): number {
    return this.blockHeight;
  }

  /**
   * Build a new block header for the current J-block.
   * Used to give EVM contracts correct block.number/timestamp.
   */
  private createBlock(timestampMs: number): Block {
    const nextHeight = this.blockHeight + 1;
    const headerData = {
      parentHash: hexToBytes(this.blockHash as `0x${string}`),
      number: BigInt(nextHeight),
      timestamp: BigInt(Math.floor(timestampMs / 1000)),
      gasLimit: BLOCK_GAS_LIMIT,
      baseFeePerGas: 1n, // Low base fee for simnet
    };
    const block = createBlock({ header: headerData }, { common: this.common });
    this.blockHeight = nextHeight;
    this.blockHash = bytesToHex(block.header.hash());
    this.blockHashes.set(nextHeight, this.blockHash);
    this.blockTimestamp = timestampMs;
    this.activeBlockGasUsed = 0n;
    return block;
  }

  /** Begin a J-block (all txs share the same block header). */
  beginJurisdictionBlock(timestampMs: number): void {
    this.activeBlock = this.createBlock(timestampMs);
    this.activeBlockGasUsed = 0n;
  }

  /** End a J-block. */
  endJurisdictionBlock(): void {
    this.activeBlock = null;
    this.activeBlockGasUsed = 0n;
  }

  /** Get current block hash */
  getBlockHash(): string {
    return this.blockHash;
  }

  getBlockHashAt(blockNumber: number): string {
    if (!Number.isSafeInteger(blockNumber) || blockNumber < 1) {
      throw new Error(`BROWSERVM_BLOCK_HEIGHT_INVALID:${String(blockNumber)}`);
    }
    const blockHash = this.blockHashes.get(blockNumber);
    if (!blockHash) throw new Error(`BROWSERVM_BLOCK_HASH_UNAVAILABLE:${blockNumber}`);
    return blockHash;
  }

  /** Get transaction receipt by hash (for ethers compatibility) */
  getTransactionReceipt(txHash: string): BrowserVmStoredReceipt | null {
    return this.txReceipts.get(txHash) ?? null;
  }

  getLogs(filter?: {
    fromBlock?: number | bigint | string;
    toBlock?: number | bigint | string;
    address?: string | string[];
    topics?: Array<string | string[] | null>;
  }): Array<{
    address: string;
    topics: string[];
    data: string;
    blockNumber: number;
    blockHash: string;
    transactionHash: string;
    transactionIndex: number;
    logIndex: number;
    removed: boolean;
  }> {
    const parseBlock = (value: unknown, defaultValue: number): number => {
      if (value === undefined || value === null || value === 'latest') return defaultValue;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : defaultValue;
    };
    const fromBlock = parseBlock(filter?.fromBlock, 0);
    const toBlock = parseBlock(filter?.toBlock, Number.MAX_SAFE_INTEGER);
    const addresses = (() => {
      const raw = filter?.address;
      if (!raw) return null;
      const values = Array.isArray(raw) ? raw : [raw];
      return new Set(values.map((entry) => entry.toLowerCase()));
    })();

    const topicMatches = (topics: string[]): boolean => {
      const expected = filter?.topics;
      if (!expected?.length) return true;
      for (let i = 0; i < expected.length; i++) {
        const wanted = expected[i];
        if (wanted === null || wanted === undefined) continue;
        const actual = topics[i]?.toLowerCase();
        if (!actual) return false;
        if (Array.isArray(wanted)) {
          if (!wanted.some((topic) => topic.toLowerCase() === actual)) return false;
        } else if (wanted.toLowerCase() !== actual) {
          return false;
        }
      }
      return true;
    };

    const logs: Array<{
      address: string;
      topics: string[];
      data: string;
      blockNumber: number;
      blockHash: string;
      transactionHash: string;
      transactionIndex: number;
      logIndex: number;
      removed: boolean;
    }> = [];
    for (const receipt of this.txReceipts.values()) {
      if (receipt.blockNumber < fromBlock || receipt.blockNumber > toBlock) continue;
      for (const log of receipt.logs) {
        if (addresses && !addresses.has(log.address.toLowerCase())) continue;
        if (!topicMatches(log.topics)) continue;
        logs.push({
          ...log,
          blockHash: receipt.blockHash,
          transactionIndex: receipt.transactionIndex,
          removed: false,
        });
      }
    }
    return logs.sort((left, right) => left.blockNumber - right.blockNumber || left.logIndex - right.logIndex);
  }

  async getAuthenticatedLogsForRange(
    fromBlock: number,
    toBlock: number,
    watchedAddresses: readonly string[],
  ): Promise<AuthenticatedRpcLog[]> {
    if (!Number.isSafeInteger(fromBlock) || !Number.isSafeInteger(toBlock) || fromBlock < 1 || toBlock < fromBlock) {
      throw new Error(`BROWSERVM_RECEIPT_RANGE_INVALID:${fromBlock}:${toBlock}`);
    }
    const addresses = new Set(watchedAddresses.map(value => ethers.getAddress(value).toLowerCase()));
    if (addresses.size === 0 || addresses.size !== watchedAddresses.length) {
      throw new Error('BROWSERVM_RECEIPT_WATCH_ADDRESS_INVALID');
    }
    const authenticated: AuthenticatedRpcLog[] = [];
    for (let blockNumber = fromBlock; blockNumber <= toBlock; blockNumber += 1) {
      const receipts = this.canonicalReceiptsAt(blockNumber);
      if (receipts.length === 0) continue;
      const committedRoot = this.blockReceiptRoots.get(blockNumber);
      if (!committedRoot) throw new Error(`BROWSERVM_RECEIPT_ROOT_MISSING:${blockNumber}`);
      const computedRoot = await computeCanonicalReceiptsRoot(receipts);
      if (computedRoot !== committedRoot) {
        throw new Error(
          `BROWSERVM_RECEIPT_ROOT_CORRUPTION:${blockNumber}:${committedRoot}:${computedRoot}`,
        );
      }
      const proofs = await createCanonicalReceiptProofs(receipts, committedRoot);
      let blockLogIndex = 0;
      for (const receipt of receipts) {
        const transactionIndex = Number(receipt.transactionIndex);
        const proof = proofs.get(transactionIndex);
        if (!proof) throw new Error(`BROWSERVM_RECEIPT_PROOF_MISSING:${blockNumber}:${transactionIndex}`);
        for (let receiptLogIndex = 0; receiptLogIndex < receipt.logs.length; receiptLogIndex += 1) {
          const log = receipt.logs[receiptLogIndex]!;
          const logIndex = blockLogIndex;
          blockLogIndex += 1;
          if (!addresses.has(ethers.getAddress(log.address).toLowerCase())) continue;
          authenticated.push({
            address: log.address.toLowerCase(),
            topics: log.topics.map(topic => topic.toLowerCase()),
            data: log.data.toLowerCase(),
            blockNumber,
            blockHash: String(receipt.blockHash).toLowerCase(),
            transactionHash: String(receipt.transactionHash).toLowerCase(),
            transactionIndex,
            logIndex,
            index: logIndex,
            receiptProof: { ...proof, receiptLogIndex },
          });
        }
      }
    }
    return authenticated;
  }

  /** Set deterministic block timestamp for next tx/block */
  setBlockTimestamp(timestamp: number): void {
    if (!this.activeBlock) {
      this.blockTimestamp = timestamp;
    }
  }

  private async runReadOnlyCall(
    request: Parameters<EthereumVm['evm']['runCall']>[0],
  ): Promise<Awaited<ReturnType<EthereumVm['evm']['runCall']>>> {
    return await this.runExclusiveVmOperation(async () => {
      const stateManager = this.vm.stateManager;
      await stateManager.checkpoint();
      let result: Awaited<ReturnType<EthereumVm['evm']['runCall']>> | undefined;
      let primaryError: unknown;
      try {
        result = await this.vm.evm.runCall(request);
      } catch (error) {
        primaryError = error;
      }
      try {
        await stateManager.revert();
      } catch (revertError) {
        if (primaryError !== undefined) {
          throw new AggregateError([primaryError, revertError], 'BROWSERVM_READ_CALL_AND_REVERT_FAILED');
        }
        throw revertError;
      }
      if (primaryError !== undefined) throw primaryError;
      if (!result) throw new Error('BROWSERVM_READ_CALL_RESULT_MISSING');
      return result;
    });
  }

  private async runTxInBlock(tx: BrowserVmTx): Promise<BrowserVmRunTxResult> {
    return await this.runExclusiveVmOperation(async () => this.runTxInBlockUnlocked(tx));
  }

  private async runTxWithNonce(
    signerAddress: Address,
    buildTx: (nonce: bigint) => BrowserVmTx,
  ): Promise<{ tx: BrowserVmTx; result: BrowserVmRunTxResult }> {
    return await this.runExclusiveVmOperation(async () => {
      const account = await this.vm.stateManager.getAccount(signerAddress);
      const tx = buildTx(account?.nonce || 0n);
      return { tx, result: await this.runTxInBlockUnlocked(tx) };
    });
  }

  private async runTxInBlockUnlocked(tx: BrowserVmTx): Promise<BrowserVmRunTxResult> {
    const transactionHash = bytesToHex(tx.hash());
    if (this.txReceipts.has(transactionHash)) {
      throw new Error(`BROWSERVM_RECEIPT_DUPLICATE_TRANSACTION:${transactionHash}`);
    }
    const block = this.activeBlock ?? this.createBlock(this.blockTimestamp);
    const result = await runTx(this.vm, {
      tx,
      block,
      blockGasUsed: this.activeBlockGasUsed,
    });
    this.activeBlockGasUsed += result.totalGasSpent;
    await this.recordTransactionReceipt(
      result.execResult.logs || [],
      transactionHash,
      result.receipt,
      tx.type,
      {
        from: tx.getSenderAddress().toString(),
        to: tx.to?.toString() ?? null,
        contractAddress: !tx.to && result.createdAddress ? result.createdAddress.toString() : null,
      },
    );
    return result;
  }

  /** Check if saved state exists */
  hasSavedState(key: string = 'xln-evm-state'): boolean {
    return localStorage.getItem(key) !== null;
  }

  /** Register numbered entities via EntityProvider contract */
  async registerNumberedEntitiesBatch(boardHashes: string[]): Promise<{ entityNumbers: number[]; txHash: string }> {
    if (!this.entityProviderAddress || !this.entityProviderInterface) {
      throw new Error('EntityProvider not deployed');
    }

    // Encode contract call
    const callData = this.entityProviderInterface.encodeFunctionData('registerNumberedEntitiesBatch', [boardHashes]);
    const { tx, result } = await this.runTxWithNonce(this.deployerAddress, (currentNonce) =>
      createLegacyTx({
        to: this.entityProviderAddress!,
        gasLimit: 5000000n,
        gasPrice: 10n,
        data: hexToBytes(callData as `0x${string}`),
        nonce: currentNonce,
      }, { common: this.common }).sign(this.deployerPrivKey));

    if (result.execResult.exceptionError) {
      throw new Error(`registerNumberedEntitiesBatch failed: ${result.execResult.exceptionError}`);
    }

    // Decode return value - array of uint256 entity numbers
    const decoded = this.entityProviderInterface.decodeFunctionResult('registerNumberedEntitiesBatch', result.execResult.returnValue);
    const entityNumbers = (decoded[0] as bigint[]).map((n: bigint) => Number(n));
    const txHash = bytesToHex(tx.hash());
    await this.emitEvents(result.execResult.logs || [], txHash);

    console.log(`[BrowserVM] registerNumberedEntitiesBatch: ${boardHashes.length} entities → [${entityNumbers.join(',')}]`);
    return {
      entityNumbers,
      txHash,
    };
  }

  /**
   * Register numbered entities with explicit validator keys.
   * Creates boards with signer addresses as sole validators.
   * The provider has no Env and therefore must never resolve numeric aliases
   * through process-global key state.
   * @returns Array of assigned entity numbers
   */
  async registerEntitiesWithSigners(
    signers: Array<{ signerId: string; privateKey: string }>,
  ): Promise<number[]> {
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const boardHashes: string[] = [];

    for (const { signerId, privateKey } of signers) {
      // Get validator address from private key
      const wallet = new ethers.Wallet(privateKey);
      const validatorAddress = wallet.address;
      // Match Solidity: bytes32(uint256(uint160(address))) - zero-pad address to 32 bytes
      const validatorEntityId = ethers.zeroPadValue(validatorAddress, 32);

      // Create board with single validator
      // Board struct: { votingThreshold, entityIds[], votingPowers[], boardChangeDelay, controlChangeDelay, dividendChangeDelay }
      // NOTE: Must match Solidity's abi.encode(Board) exactly
      // Solidity memory layout: https://docs.soliditylang.org/en/latest/abi-spec.html
      const encodedBoard = abiCoder.encode(
        ['tuple(uint16,bytes32[],uint16[],uint32,uint32,uint32)'],
        [[
          1n, // votingThreshold (uint16)
          [validatorEntityId], // entityIds (bytes32[])
          [1n], // votingPowers (uint16[])
          0n, // boardChangeDelay (uint32)
          0n, // controlChangeDelay (uint32)
          0n, // dividendChangeDelay (uint32)
        ]]
      );

      const boardHash = ethers.keccak256(encodedBoard);
      boardHashes.push(boardHash);

      console.log(`[BrowserVM] Entity ${signerId}: validator=${validatorAddress}, entityId=${validatorEntityId.slice(0, 20)}...`);
      console.log(`[BrowserVM]   boardHash=${boardHash}`);
    }

    // Register all entities in batch
    const result = await this.registerNumberedEntitiesBatch(boardHashes);
    const entityNumbers = result.entityNumbers;

    // Verify registration by checking stored boardHashes
    for (let i = 0; i < entityNumbers.length; i++) {
      const entityNum = entityNumbers[i];
      if (entityNum === undefined) continue;
      const entityId = '0x' + entityNum.toString(16).padStart(64, '0');
      const signer = signers[i];
      if (!signer) throw new Error(`BROWSERVM_ENTITY_SIGNER_MISSING:index=${i}`);
      this.registerEntityWallet(entityId, signer.privateKey);
      const info = await this.getEntityInfo(entityId);
      console.log(`[BrowserVM]   Verified entity ${entityNum}: stored boardHash=${info.currentBoardHash?.slice(0, 18)}...`);
      if (info.currentBoardHash !== boardHashes[i]) {
        console.error(`[BrowserVM] ⚠️ Hash mismatch! Expected ${boardHashes[i]}, got ${info.currentBoardHash}`);
      }
    }

    return entityNumbers;
  }

}

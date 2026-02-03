/**
 * BrowserVMProvider - In-browser EVM using @ethereumjs/vm
 * Self-contained environment with Depository.sol
 *
 * Uses ethers.js Interface for ABI encoding - same pattern as mainnet evm.ts
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
import { safeStringify } from '../serialization-utils.js';
import { deriveSignerKeySync, getCachedSignerPrivateKey } from '../account-crypto.js';
import { isLeftEntity, normalizeEntityId } from '../entity-id-utils';
import { DEFAULT_TOKENS, DEFAULT_TOKEN_SUPPLY, DEFAULT_SIGNER_FAUCET, TOKEN_REGISTRATION_AMOUNT } from './default-tokens';

const BLOCK_GAS_LIMIT = 200_000_000n; // Simnet headroom for large deploys/batches

// CONTRACT_VERSION - increment when contract ABI/encoding changes to invalidate cached EVM state
// 2025-02-03: v3 - Token reference hashing + ExternalTokenToReserve struct update
const CONTRACT_VERSION = 3;

/** EVM event emitted from the BrowserVM */
export interface EVMEvent {
  name: string;
  args: Record<string, unknown>;
  blockNumber?: number;
  blockHash?: string;  // Block hash for JBlock consensus
  timestamp?: number;
}

export class BrowserVMProvider {
  private vm: any;
  private common: any;
  private accountAddress: Address | null = null;
  private depositoryAddress: Address | null = null;
  private entityProviderAddress: Address | null = null;
  private deltaTransformerAddress: Address | null = null;
  private deployerPrivKey: Uint8Array;
  private deployerAddress: Address;
  private nonce = 0n;
  private accountArtifact: any = null;
  private depositoryArtifact: any = null;
  private entityProviderArtifact: any = null;
  private deltaTransformerArtifact: any = null;
  private erc20Artifact: any = null;
  private depositoryInterface: ethers.Interface | null = null;
  private entityProviderInterface: ethers.Interface | null = null;
  private accountInterface: ethers.Interface | null = null;
  private deltaTransformerInterface: ethers.Interface | null = null;
  private erc20Interface: ethers.Interface | null = null;
  private tokenRegistry: Map<string, { address: string; name: string; symbol: string; decimals: number; tokenId: number }> = new Map();
  private fundedAddresses: Set<string> = new Set();
  private initialized = false;
  private quietLogs = false;
  private blockHeight = 0; // Track J-Machine block height
  private blockHash = '0x0000000000000000000000000000000000000000000000000000000000000000'; // Current block hash
  private prevBlockHash = '0x0000000000000000000000000000000000000000000000000000000000000000'; // Previous block hash
  private blockTimestamp = 0; // Deterministic block timestamp (set by runtime)
  private activeBlock: Block | null = null;
  // ─────────────────────────────────────────────────────────────────────────────
  // Event callbacks receive BATCHES of events (all events from one tx/block)
  // This matches real blockchain behavior where events are grouped by block
  // ─────────────────────────────────────────────────────────────────────────────
  private eventCallbacks: Set<(events: EVMEvent[]) => void> = new Set();

  // Transaction receipts for ethers compatibility
  private txReceipts: Map<string, {
    transactionHash: string;
    blockNumber: number;
    blockHash: string;
    from: string;
    to: string | null;
    contractAddress: string | null;
    status: number;
    logs: Array<{
      address: string;
      topics: string[];
      data: string;
      blockNumber: number;
      transactionHash: string;
      logIndex: number;
    }>;
  }> = new Map();

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

  private warn(...args: unknown[]): void {
    if (!this.quietLogs) {
      console.warn(...args);
    }
  }

  /** Initialize VM and deploy contracts */
  async init(): Promise<void> {
    if (this.initialized) {
      console.log('[BrowserVM] Already initialized, skipping');
      return;
    }

    // Load artifacts - browser uses fetch, CLI uses file read
    if (typeof window !== 'undefined') {
      // Browser: fetch from static/
      const [accountResp, depositoryResp, entityProviderResp, deltaTransformerResp, erc20Resp] = await Promise.all([
        fetch('/contracts/Account.json'),
        fetch('/contracts/Depository.json'),
        fetch('/contracts/EntityProvider.json'),
        fetch('/contracts/DeltaTransformer.json'),
        fetch('/contracts/ERC20Mock.json'),
      ]);

      if (!accountResp.ok) throw new Error(`Failed to load Account artifact: ${accountResp.status}`);
      if (!depositoryResp.ok) throw new Error(`Failed to load Depository artifact: ${depositoryResp.status}`);
      if (!entityProviderResp.ok) throw new Error(`Failed to load EntityProvider artifact: ${entityProviderResp.status}`);
      if (!deltaTransformerResp.ok) throw new Error(`Failed to load DeltaTransformer artifact: ${deltaTransformerResp.status}`);
      if (!erc20Resp.ok) throw new Error(`Failed to load ERC20Mock artifact: ${erc20Resp.status}`);

      this.accountArtifact = await accountResp.json();
      this.depositoryArtifact = await depositoryResp.json();
      this.entityProviderArtifact = await entityProviderResp.json();
      this.deltaTransformerArtifact = await deltaTransformerResp.json();
      this.erc20Artifact = await erc20Resp.json();
    } else {
      // CLI: read from jurisdictions/artifacts/
      const fs = await import('fs');
      const path = await import('path');
      const basePath = path.join(process.cwd(), 'jurisdictions/artifacts/contracts');

      this.accountArtifact = JSON.parse(fs.readFileSync(path.join(basePath, 'Account.sol/Account.json'), 'utf-8'));
      this.depositoryArtifact = JSON.parse(fs.readFileSync(path.join(basePath, 'Depository.sol/Depository.json'), 'utf-8'));
      this.entityProviderArtifact = JSON.parse(fs.readFileSync(path.join(basePath, 'EntityProvider.sol/EntityProvider.json'), 'utf-8'));
      this.deltaTransformerArtifact = JSON.parse(fs.readFileSync(path.join(basePath, 'DeltaTransformer.sol/DeltaTransformer.json'), 'utf-8'));
      this.erc20Artifact = JSON.parse(fs.readFileSync(path.join(basePath, 'ERC20Mock.sol/ERC20Mock.json'), 'utf-8'));
      console.log('[BrowserVM] Loaded artifacts from filesystem (CLI mode)');
    }

    // Create ethers Interfaces for ABI encoding
    this.depositoryInterface = new ethers.Interface(this.depositoryArtifact.abi);
    this.entityProviderInterface = new ethers.Interface(this.entityProviderArtifact.abi);
    this.accountInterface = new ethers.Interface(this.accountArtifact.abi);
    this.deltaTransformerInterface = new ethers.Interface(this.deltaTransformerArtifact.abi);
    this.erc20Interface = new ethers.Interface(this.erc20Artifact.abi);
    console.log('[BrowserVM] Loaded all contract artifacts (including Account library and DeltaTransformer)');

    // Create VM with evmOpts to disable contract size limit
    const common = createCustomCommon({ chainId: 1337 }, Mainnet);
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
      nonce: 0n,
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
    this.vm = null;
    this.common = null;
    this.accountAddress = null;
    this.depositoryAddress = null;
    this.entityProviderAddress = null;
    this.deltaTransformerAddress = null;
    this.nonce = 0n;
    this.tokenRegistry.clear();
    this.fundedAddresses.clear();
    await this.init();
    console.log('[BrowserVM] Reset complete - fresh contracts deployed');
  }

  /** Deploy Account library */
  private async deployAccount(): Promise<void> {
    console.log('[BrowserVM] Deploying Account library...');
    const currentNonce = await this.getCurrentNonce();

    const tx = createLegacyTx({
      gasLimit: 100000000n,
      gasPrice: 10n,
      data: this.accountArtifact.bytecode,
      nonce: currentNonce,
    }, { common: this.common }).sign(this.deployerPrivKey);

    const result = await this.runTxInBlock(tx);

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
    let linkedBytecode = this.depositoryArtifact.bytecode;
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

    // Encode constructor args: constructor(address _entityProvider)
    const { ethers } = await import('ethers');
    const constructorArgs = ethers.AbiCoder.defaultAbiCoder().encode(
      ['address'],
      [this.entityProviderAddress.toString()]
    );
    const deployData = linkedBytecode + constructorArgs.slice(2); // Remove 0x from args

    const currentNonce = await this.getCurrentNonce();

    const tx = createLegacyTx({
      gasLimit: 100000000n,
      gasPrice: 10n,
      data: deployData as `0x${string}`,
      nonce: currentNonce,
    }, { common: this.common }).sign(this.deployerPrivKey);

    const result = await this.runTxInBlock(tx);

    if (result.execResult.exceptionError) {
      console.error('[BrowserVM] Depository deployment failed:', result.execResult.exceptionError);
      throw new Error(`Depository deployment failed: ${result.execResult.exceptionError}`);
    }

    this.depositoryAddress = result.createdAddress!;
    console.log(`[BrowserVM] Depository deployed at: ${this.depositoryAddress?.toString() ?? 'null'}`);
    console.log(`[BrowserVM] Gas used: ${result.totalGasSpent}`);

    // Verify code exists
    const code = await this.vm.stateManager.getCode(this.depositoryAddress);
    if (code.length === 0) {
      throw new Error('Depository deployment failed - no code at address');
    }
  }

  /** Deploy EntityProvider contract */
  private async deployEntityProvider(): Promise<void> {
    console.log('[BrowserVM] Deploying EntityProvider...');
    const currentNonce = await this.getCurrentNonce();

    const tx = createLegacyTx({
      gasLimit: 100000000n,
      gasPrice: 10n,
      data: this.entityProviderArtifact.bytecode,
      nonce: currentNonce,
    }, { common: this.common }).sign(this.deployerPrivKey);

    const result = await this.runTxInBlock(tx);

    if (result.execResult.exceptionError) {
      console.error('[BrowserVM] EntityProvider deployment failed:', result.execResult.exceptionError);
      throw new Error(`EntityProvider deployment failed: ${result.execResult.exceptionError}`);
    }

    this.entityProviderAddress = result.createdAddress!;
    console.log(`[BrowserVM] EntityProvider deployed at: ${this.entityProviderAddress?.toString() ?? 'null'}`);
  }

  /** Deploy DeltaTransformer contract (HTLC + Swap transformer) */
  private async deployDeltaTransformer(): Promise<void> {
    console.log('[BrowserVM] Deploying DeltaTransformer...');
    const currentNonce = await this.getCurrentNonce();

    const tx = createLegacyTx({
      gasLimit: 100000000n,
      gasPrice: 10n,
      data: this.deltaTransformerArtifact.bytecode,
      nonce: currentNonce,
    }, { common: this.common }).sign(this.deployerPrivKey);

    const result = await this.runTxInBlock(tx);

    if (result.execResult.exceptionError) {
      console.error('[BrowserVM] DeltaTransformer deployment failed:', result.execResult.exceptionError);
      throw new Error(`DeltaTransformer deployment failed: ${result.execResult.exceptionError}`);
    }

    this.deltaTransformerAddress = result.createdAddress!;
    console.log(`[BrowserVM] DeltaTransformer deployed at: ${this.deltaTransformerAddress?.toString() ?? 'null'}`);

    // Update proof-builder with deployed address
    const { setDeltaTransformerAddress } = await import('../proof-builder.js');
    setDeltaTransformerAddress(this.deltaTransformerAddress?.toString() ?? '');
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

  /** Faucet: fund a signer address with ETH + default tokens */
  async fundSignerWallet(address: string, amount: bigint = DEFAULT_SIGNER_FAUCET): Promise<void> {
    if (!address) return;
    if (!this.tokenRegistry.size) {
      await this.deployDefaultTokens();
    }
    const normalized = address.toLowerCase();

    await this.ensureEthBalance(address, 1000n * 10n ** 18n);

    for (const token of this.tokenRegistry.values()) {
      const balance = await this.getErc20Balance(token.address, address);
      if (balance >= amount) continue;
      const delta = amount - balance;
      await this.transferErc20(this.deployerPrivKey, token.address, address, delta);
    }

    this.fundedAddresses.add(normalized);
    console.log(`[BrowserVM] Faucet funded ${address.slice(0, 10)}... with ${amount} of ${this.tokenRegistry.size} tokens`);
  }

  private async deployDefaultTokens(): Promise<void> {
    if (this.tokenRegistry.size > 0) return;
    if (!this.erc20Artifact || !this.erc20Interface) {
      throw new Error('ERC20 artifact not loaded');
    }
    if (!this.depositoryAddress || !this.depositoryInterface) {
      throw new Error('Depository not deployed');
    }

    for (const token of DEFAULT_TOKENS) {
      const address = await this.deployErc20Token(token.name, token.symbol, DEFAULT_TOKEN_SUPPLY);
      const tokenId = await this.registerErc20Token(address);
      this.tokenRegistry.set(token.symbol, {
        address,
        name: token.name,
        symbol: token.symbol,
        decimals: token.decimals,
        tokenId,
      });
      console.log(`[BrowserVM] Token registered: ${token.symbol} id=${tokenId} addr=${address.slice(0, 10)}...`);
    }
  }

  private async deployErc20Token(name: string, symbol: string, supply: bigint): Promise<string> {
    const currentNonce = await this.getCurrentNonce();
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const constructorData = abiCoder.encode(['string', 'string', 'uint256'], [name, symbol, supply]);
    const bytecode = `${this.erc20Artifact.bytecode}${constructorData.slice(2)}`;

    const tx = createLegacyTx({
      gasLimit: 5_000_000n,
      gasPrice: 10n,
      data: bytecode as `0x${string}`,
      nonce: currentNonce,
    }, { common: this.common }).sign(this.deployerPrivKey);

    const result = await this.runTxInBlock(tx);

    if (result.execResult.exceptionError) {
      throw new Error(`ERC20 deployment failed: ${result.execResult.exceptionError}`);
    }

    return result.createdAddress!.toString();
  }

  private async registerErc20Token(tokenAddress: string): Promise<number> {
    const packedToken = await this.packTokenReference(0, tokenAddress, 0);
    await this.approveErc20(this.deployerPrivKey, tokenAddress, this.depositoryAddress!.toString(), TOKEN_REGISTRATION_AMOUNT);

    const callData = this.depositoryInterface!.encodeFunctionData('externalTokenToReserve', [{
      entity: ethers.ZeroHash,
      contractAddress: tokenAddress,
      externalTokenId: 0,
      tokenType: 0,
      internalTokenId: 0,
      amount: TOKEN_REGISTRATION_AMOUNT,
    }]);

    const currentNonce = await this.getCurrentNonce();
    const tx = createLegacyTx({
      to: this.depositoryAddress!,
      gasLimit: 1_000_000n,
      gasPrice: 10n,
      data: hexToBytes(callData as `0x${string}`),
      nonce: currentNonce,
    }, { common: this.common }).sign(this.deployerPrivKey);

    const result = await this.runTxInBlock(tx);

    if (result.execResult.exceptionError) {
      throw new Error(`externalTokenToReserve failed: ${result.execResult.exceptionError}`);
    }

    const tokenId = await this.lookupTokenId(packedToken);
    return tokenId;
  }

  private async packTokenReference(tokenType: number, contractAddress: string, externalTokenId: number): Promise<string> {
    const callData = this.depositoryInterface!.encodeFunctionData('packTokenReference', [
      tokenType,
      contractAddress,
      externalTokenId,
    ]);

    const result = await this.vm.evm.runCall({
      to: this.depositoryAddress!,
      caller: this.deployerAddress,
      data: hexToBytes(callData as `0x${string}`),
      gasLimit: 100000n,
    });

    if (result.execResult.exceptionError) {
      throw new Error(`packTokenReference failed: ${result.execResult.exceptionError}`);
    }

    const decoded = this.depositoryInterface!.decodeFunctionResult('packTokenReference', result.execResult.returnValue);
    return decoded[0] as string;
  }

  private async lookupTokenId(packedToken: string): Promise<number> {
    const callData = this.depositoryInterface!.encodeFunctionData('tokenToId', [packedToken]);
    const result = await this.vm.evm.runCall({
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
    const result = await this.vm.evm.runCall({
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
    const account = await this.vm.stateManager.getAccount(createAddressFromString(owner));
    return account?.balance || 0n;
  }

  async getErc20Allowance(tokenAddress: string, owner: string, spender: string): Promise<bigint> {
    const callData = this.erc20Interface!.encodeFunctionData('allowance', [owner, spender]);
    const result = await this.vm.evm.runCall({
      to: createAddressFromString(tokenAddress),
      caller: this.deployerAddress,
      data: hexToBytes(callData as `0x${string}`),
      gasLimit: 100000n,
    });
    if (result.execResult.exceptionError) return 0n;
    const decoded = this.erc20Interface!.decodeFunctionResult('allowance', result.execResult.returnValue);
    return decoded[0];
  }

  async approveErc20(privKey: Uint8Array, tokenAddress: string, spender: string, amount: bigint): Promise<string> {
    const callData = this.erc20Interface!.encodeFunctionData('approve', [spender, amount]);
    const result = await this.executeTx({
      to: tokenAddress,
      data: callData,
      gasLimit: 200000n,
    }, privKey);
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
    const tokenType = options?.tokenType ?? 0;
    const externalTokenIdRaw = options?.externalTokenId ?? 0n;
    const externalTokenId = typeof externalTokenIdRaw === 'bigint' ? externalTokenIdRaw : BigInt(externalTokenIdRaw);
    const internalTokenId = options?.internalTokenId ?? 0;
    const callData = this.depositoryInterface!.encodeFunctionData('externalTokenToReserve', [{
      entity: entityId,
      contractAddress: tokenAddress,
      externalTokenId,
      tokenType,
      internalTokenId,
      amount,
    }]);

    const result = await this.executeTx({
      to: this.depositoryAddress!.toString(),
      data: callData,
      gasLimit: 1_000_000n,
    }, privKey, { emitEvents: true });

    return result.events || [];
  }

  async executeTx(
    txData: { to?: string; data?: string; gasLimit?: bigint; value?: bigint },
    privKey: Uint8Array = this.deployerPrivKey,
    options?: { emitEvents?: boolean }
  ): Promise<{ txHash: string; events?: EVMEvent[] }> {
    const fromAddress = createAddressFromPrivateKey(privKey);
    const currentNonce = await this.getNonceForAddress(fromAddress);
    const toAddress = txData.to ? createAddressFromString(txData.to) : undefined;
    const txDataObj: any = {
      gasLimit: txData.gasLimit ?? 1000000n,
      gasPrice: 10n,
      data: hexToBytes((txData.data || '0x') as `0x${string}`),
      nonce: currentNonce,
      value: txData.value ?? 0n,
    };
    if (toAddress) {
      txDataObj.to = toAddress;
    }
    const tx = createLegacyTx(txDataObj, { common: this.common }).sign(privKey);

    const result = await this.runTxInBlock(tx);

    if (result.execResult.exceptionError) {
      const errObj = result.execResult.exceptionError;
      const errStr = errObj?.error || JSON.stringify(errObj);
      // Log any events that were emitted before revert (won't persist but shows debug info)
      if (result.execResult.logs && result.execResult.logs.length > 0) {
        console.log('[BrowserVM] Events before revert:', result.execResult.logs.length);
        const events = this.parseLogs(result.execResult.logs);
        for (const ev of events) {
          console.log(`   Event: ${ev.name}`, ev.args);
        }
      }
      throw new Error(`executeTx failed: ${errStr}`);
    }

    const txHash = bytesToHex(tx.hash());
    if (options?.emitEvents) {
      const events = this.emitEvents(result.execResult.logs || []);
      return { txHash, events };
    }
    return { txHash };
  }

  async executeSignedTx(serializedTx: string): Promise<string> {
    const raw = hexToBytes(serializedTx as `0x${string}`);
    const tx = createTxFromRLP(raw, { common: this.common });
    const result = await this.runTxInBlock(tx);

    if (result.execResult.exceptionError) {
      const err = result.execResult.exceptionError;
      const errMsg = typeof err === 'object' ? (err.error || err.message || JSON.stringify(err)) : String(err);
      throw new Error(`executeSignedTx failed: ${errMsg}`);
    }

    const txHash = bytesToHex(tx.hash());
    const from = tx.getSenderAddress().toString();
    const to = tx.to?.toString() ?? null;
    const contractAddress = !to && result.createdAddress ? result.createdAddress.toString() : null;

    // Parse logs for receipt
    const rawLogs = result.execResult.logs || [];
    const logs = rawLogs.map((log: any, index: number) => {
      // log[0] is Address object or Uint8Array, log[1] is topics array, log[2] is data
      const addr = log[0];
      // Handle Address object (has toBytes method) or raw Uint8Array
      let addressHex: string;
      if (typeof addr === 'string') {
        addressHex = addr;
      } else if (addr instanceof Uint8Array) {
        addressHex = bytesToHex(addr);
      } else if (typeof addr.toBytes === 'function') {
        // ethereumjs Address object
        addressHex = bytesToHex(addr.toBytes());
      } else {
        addressHex = addr.toString();
      }
      return {
        address: addressHex,
        topics: log[1].map((t: Uint8Array) => bytesToHex(t)),
        data: bytesToHex(log[2]),
        blockNumber: this.blockHeight,
        transactionHash: txHash,
        logIndex: index,
      };
    });

    // Store receipt for getTransactionReceipt
    this.txReceipts.set(txHash, {
      transactionHash: txHash,
      blockNumber: this.blockHeight,
      blockHash: this.blockHash,
      from,
      to,
      contractAddress,
      status: 1, // Success
      logs,
    });

    return txHash;
  }

  private async getNonceForAddress(address: Address): Promise<bigint> {
    const account = await this.vm.stateManager.getAccount(address);
    return account?.nonce || 0n;
  }

  private async ensureEthBalance(address: string, minBalance: bigint): Promise<void> {
    const addr = createAddressFromString(address);
    const account = await this.vm.stateManager.getAccount(addr);
    const balance = account?.balance || 0n;
    if (balance >= minBalance) return;
    const updated = account || createAccount({ nonce: 0n, balance: minBalance });
    updated.balance = minBalance;
    await this.vm.stateManager.putAccount(addr, updated);
  }

  /** Get entity reserves for a token */
  async getReserves(entityId: string, tokenId: number): Promise<bigint> {
    if (!this.depositoryAddress || !this.depositoryInterface) {
      throw new Error('Depository not deployed');
    }

    // Use ethers Interface for ABI encoding (same as mainnet)
    const callData = this.depositoryInterface.encodeFunctionData('_reserves', [entityId, tokenId]);

    const result = await this.vm.evm.runCall({
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

    const result = await this.vm.evm.runCall({
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

  /** Get current nonce from VM state */
  private async getCurrentNonce(): Promise<bigint> {
    const account = await this.vm.stateManager.getAccount(this.deployerAddress);
    return account?.nonce || 0n;
  }

  /** Debug: Fund entity reserves (uses admin mintToReserve) - emits ReserveUpdated event */
  async debugFundReserves(entityId: string, tokenId: number, amount: bigint): Promise<EVMEvent[]> {
    if (!this.depositoryAddress || !this.depositoryInterface) {
      throw new Error('Depository not deployed');
    }

    // Use ethers Interface for ABI encoding (same as mainnet)
    // mintToReserve is the onlyAdmin function in Depository.sol
    const callData = this.depositoryInterface.encodeFunctionData('mintToReserve', [entityId, tokenId, amount]);

    // Always query nonce from VM (don't trust local counter)
    const currentNonce = await this.getCurrentNonce();

    const tx = createLegacyTx({
      to: this.depositoryAddress,
      gasLimit: 1000000n,
      gasPrice: 10n,
      data: hexToBytes(callData as `0x${string}`),
      nonce: currentNonce,
    }, { common: this.common }).sign(this.deployerPrivKey);

    const result = await this.runTxInBlock(tx);

    if (result.execResult.exceptionError) {
      throw new Error(`mintToReserve failed: ${result.execResult.exceptionError}`);
    }

    console.log(`[BrowserVM] Funded ${entityId.slice(0, 10)}... with ${amount} of token ${tokenId}`);
    console.log(`[BrowserVM] debugFundReserves: logs=${result.execResult.logs?.length || 0}`);

    // Emit events to j-watcher subscribers
    return this.emitEvents(result.execResult.logs || []);
  }

  /** Admin: Set default dispute delay (blocks) */
  async setDefaultDisputeDelay(delayBlocks: number): Promise<void> {
    if (!this.depositoryAddress || !this.depositoryInterface) {
      throw new Error('Depository not deployed');
    }

    const callData = this.depositoryInterface.encodeFunctionData('setDefaultDisputeDelay', [delayBlocks]);
    const currentNonce = await this.getCurrentNonce();
    const tx = createLegacyTx({
      to: this.depositoryAddress,
      gasLimit: 500000n,
      gasPrice: 10n,
      data: hexToBytes(callData as `0x${string}`),
      nonce: currentNonce,
    }, { common: this.common }).sign(this.deployerPrivKey);

    const result = await this.runTxInBlock(tx);
    if (result.execResult.exceptionError) {
      throw new Error(`setDefaultDisputeDelay failed: ${result.execResult.exceptionError}`);
    }
    console.log(`[BrowserVM] Default dispute delay set to ${delayBlocks} blocks`);
  }

  /** Execute R2R transfer - emits ReserveUpdated events */
  async reserveToReserve(from: string, to: string, tokenId: number, amount: bigint): Promise<EVMEvent[]> {
    if (!this.depositoryAddress || !this.depositoryInterface) {
      throw new Error('Depository not deployed');
    }

    // Use ethers Interface for ABI encoding (same as mainnet)
    const callData = this.depositoryInterface.encodeFunctionData('reserveToReserve', [from, to, tokenId, amount]);

    // Always query nonce from VM
    const currentNonce = await this.getCurrentNonce();

    const tx = createLegacyTx({
      to: this.depositoryAddress,
      gasLimit: 1000000n,
      gasPrice: 10n,
      data: hexToBytes(callData as `0x${string}`),
      nonce: currentNonce,
    }, { common: this.common }).sign(this.deployerPrivKey);

    const result = await this.runTxInBlock(tx);

    if (result.execResult.exceptionError) {
      const err = result.execResult.exceptionError;
      const errMsg = typeof err === 'object' ? (err.error || err.message || JSON.stringify(err)) : String(err);
      console.error(`[BrowserVM] R2R FAILED: from=${from}, to=${to}, tokenId=${tokenId}, amount=${amount}`);
      console.error(`[BrowserVM] R2R error details:`, err);
      throw new Error(`reserveToReserve failed: ${errMsg}`);
    }

    console.log(`[BrowserVM] R2R SUCCESS: ${amount} token${tokenId} from ${from.slice(0, 10)}... to ${to.slice(0, 10)}...`);

    // Emit events to j-watcher subscribers
    return this.emitEvents(result.execResult.logs || []);
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
    const sig = await this.signSettlement(entityId, counterpartyId, diffs, [], []);

    const callData = this.depositoryInterface.encodeFunctionData('settle', [
      leftEntity,
      rightEntity,
      diffs,
      [], // forgiveDebtsInTokenIds
      [], // insuranceRegs
      sig,
    ]);

    const currentNonce = await this.getCurrentNonce();
    const tx = createLegacyTx({
      to: this.depositoryAddress,
      gasLimit: 1000000n,
      gasPrice: 10n,
      data: hexToBytes(callData as `0x${string}`),
      nonce: currentNonce,
    }, { common: this.common }).sign(this.deployerPrivKey);

    const result = await this.runTxInBlock(tx);
    if (result.execResult.exceptionError) {
      const err = result.execResult.exceptionError;
      const errMsg = typeof err === 'object' ? (err.error || err.message || JSON.stringify(err)) : String(err);
      console.error(`[BrowserVM] R2C FAILED: entity=${entityId}, counterparty=${counterpartyId}, tokenId=${tokenId}, amount=${amount}`);
      console.error(`[BrowserVM] R2C error details:`, err);
      throw new Error(`R2C failed: ${errMsg}`);
    }
    console.log(`[BrowserVM] R2C SUCCESS: ${amount} from ${entityId.slice(0, 10)}... → account with ${counterpartyId.slice(0, 10)}...`);
    console.log(`[BrowserVM] R2C: logs=${result.execResult.logs?.length || 0}`);

    return this.emitEvents(result.execResult.logs || []);
  }

  /** Get collateral for an account */
  async getCollateral(entityId: string, counterpartyId: string, tokenId: number): Promise<{ collateral: bigint; ondelta: bigint }> {
    if (!this.depositoryAddress || !this.depositoryInterface) throw new Error('Depository not deployed');

    // Use ethers Interface for ABI encoding (same as mainnet)
    // Solidity mapping: _collaterals(bytes channelKey, uint tokenId) -> AccountCollateral
    // Need to compute channelKey first via accountKey(e1, e2), then call the mapping getter
    const channelKeyData = this.depositoryInterface.encodeFunctionData('accountKey', [entityId, counterpartyId]);
    const channelKeyResult = await this.vm.evm.runCall({
      to: this.depositoryAddress,
      caller: this.deployerAddress,
      data: hexToBytes(channelKeyData as `0x${string}`),
      gasLimit: 100000n,
    });
    if (channelKeyResult.execResult.exceptionError) return { collateral: 0n, ondelta: 0n };
    const channelKeyDecoded = this.depositoryInterface.decodeFunctionResult(
      'accountKey',
      channelKeyResult.execResult.returnValue
    );
    const channelKey = channelKeyDecoded[0];

    const callData = this.depositoryInterface.encodeFunctionData('_collaterals', [channelKey, tokenId]);

    const result = await this.vm.evm.runCall({
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

  /** MessageType enum values (must match Types.sol) */
  private static readonly MessageType = {
    CooperativeUpdate: 0,
    DisputeProof: 1,
    FinalDisputeProof: 2,
    CooperativeDisputeProof: 3,
  };

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

  /**
   * Get the wallet for an entity (for signing).
   * First checks cache, then tries to derive from entityId.
   */
  getEntityWallet(entityId: string): ethers.Wallet {
    const normalized = entityId.toLowerCase();

    // Check cache first
    const cached = this.entityWallets.get(normalized);
    if (cached) return cached;

    // Try to extract address from entityId and find matching wallet
    // entityId format: 0x000...000<address>
    const addressPart = '0x' + normalized.slice(-40);

    // Check if we have a wallet for this address
    for (const [id, wallet] of this.entityWallets) {
      if (wallet.address.toLowerCase() === addressPart.toLowerCase()) {
        this.entityWallets.set(normalized, wallet);
        return wallet;
      }
    }

    // Try to derive key using account-crypto (same derivation as scenarios)
    // For numbered entities (0x000...XXXX), signerId = '<number>' (MetaMask index)
    const entityNum = parseInt(normalized.slice(-8), 16); // Last 8 hex chars = number
    if (entityNum > 0 && entityNum < 10000) {
      const signerId = String(entityNum);
      const privateKey = getCachedSignerPrivateKey(signerId);
      if (privateKey) {
        const wallet = new ethers.Wallet(ethers.hexlify(privateKey));
        this.entityWallets.set(normalized, wallet);
        console.log(`[BrowserVM] Derived wallet for entity ${entityNum} (signerId=${signerId})`);
        return wallet;
      }
    }

    throw new Error(
      `BrowserVM missing wallet for entity ${entityId.slice(0, 20)}... ` +
      `(registerEntityWallet or importReplica with runtimeSeed-derived signer)`
    );
  }

  private getSigningWallet(entityId: string): ethers.Wallet {
    const normalized = entityId.toLowerCase();
    const cached = this.entityWallets.get(normalized);
    if (cached) return cached;

    if (this.isNumberedEntity(entityId)) {
      const entityNum = parseInt(normalized.slice(-8), 16);
      const signerId = String(entityNum);
      const privateKey = getCachedSignerPrivateKey(signerId);
      if (!privateKey) {
        throw new Error(`Cannot sign: no private key for entity ${entityNum} (signerId=${signerId})`);
      }
      const wallet = new ethers.Wallet(ethers.hexlify(privateKey));
      this.entityWallets.set(normalized, wallet);
      return wallet;
    }

    throw new Error(`Cannot sign: no wallet registered for entity ${entityId.slice(0, 20)}...`);
  }

  private isNumberedEntity(entityId: string): boolean {
    const normalized = entityId.toLowerCase();
    const entityNum = parseInt(normalized.slice(-8), 16);
    return entityNum > 0 && entityNum < 10000 &&
      normalized.startsWith('0x0000000000000000000000000000000000000000000000000000');
  }

  private buildSingleSignerHanko(entityId: string, hash: string, wallet: ethers.Wallet): string {
    const hashBytes = ethers.getBytes(hash);
    const signature = wallet.signingKey.sign(hashBytes);
    const vBit = signature.v === 28 ? 1 : 0;
    const packedSig = ethers.concat([signature.r, signature.s, ethers.toBeHex(vBit, 1)]);

    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const entityIdHex = entityId.startsWith('0x') ? entityId : `0x${entityId}`;
    const paddedEntityId = ethers.zeroPadValue(entityIdHex, 32);

    return abiCoder.encode(
      ['tuple(bytes32[],bytes,tuple(bytes32,uint256[],uint256[],uint256)[])'],
      [[
        [], // placeholders
        packedSig, // packed signatures (single signer)
        [
          [
            paddedEntityId, // entityId
            [0], // entityIndexes
            [1], // weights
            1, // threshold
          ],
        ],
      ]]
    );
  }

  /**
   * Register an existing wallet for an entityId.
   * Use when entityId was created externally but you have the key.
   */
  registerEntityWallet(entityId: string, privateKey: string): void {
    const wallet = new ethers.Wallet(privateKey);
    this.entityWallets.set(entityId.toLowerCase(), wallet);
  }

  /**
   * Get the channel key for two entities (canonical order: left < right)
   */
  private getChannelKey(leftEntity: string, rightEntity: string): string {
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
    forgiveDebtsInTokenIds: number[] = [],
    insuranceRegs: Array<{
      insured: string;
      insurer: string;
      tokenId: number;
      limit: bigint;
      expiresAt: bigint;
    }> = []
  ): Promise<string> {
    // Get current cooperativeNonce from chain
    const accountInfo = await this.getAccountInfo(initiatorEntityId, counterpartyEntityId);
    const cooperativeNonce = accountInfo.cooperativeNonce;

    // Determine canonical left/right order
    const isLeft = isLeftEntity(initiatorEntityId, counterpartyEntityId);
    const leftEntity = isLeft ? initiatorEntityId : counterpartyEntityId;
    const rightEntity = isLeft ? counterpartyEntityId : initiatorEntityId;
    const channelKey = this.getChannelKey(leftEntity, rightEntity);

    // Encode the message (must match Account.sol encoding)
    // IMPORTANT: Solidity enums are encoded as uint256, not uint8!
    // Include depositoryAddress for chain+depository binding (replay protection)
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const encodedMsg = abiCoder.encode(
      ['uint256', 'address', 'bytes', 'uint256', 'tuple(uint256,int256,int256,int256,int256)[]', 'uint256[]', 'tuple(bytes32,bytes32,uint256,uint256,uint256)[]'],
      [
        BrowserVMProvider.MessageType.CooperativeUpdate,
        this.depositoryAddress?.toString() || '0x0000000000000000000000000000000000000000',
        channelKey,
        cooperativeNonce,
        diffs.map(d => [d.tokenId, d.leftDiff, d.rightDiff, d.collateralDiff, d.ondeltaDiff]),
        forgiveDebtsInTokenIds,
        insuranceRegs.map(r => [r.insured, r.insurer, r.tokenId, r.limit, r.expiresAt]),
      ]
    );

    const hash = ethers.keccak256(encodedMsg);
    console.log(`[BrowserVM] signSettlement:`);
    console.log(`  hash: ${hash}`);
    console.log(`  channelKey: ${channelKey} (${(channelKey.length - 2) / 2} bytes)`);
    console.log(`  cooperativeNonce: ${cooperativeNonce}`);
    console.log(`  diffs: ${JSON.stringify(diffs.map(d => ({ tokenId: d.tokenId, leftDiff: d.leftDiff.toString(), rightDiff: d.rightDiff.toString(), collateralDiff: d.collateralDiff.toString(), ondeltaDiff: d.ondeltaDiff.toString() })))}`);
    console.log(`  encodedMsg length: ${(encodedMsg.length - 2) / 2} bytes`);
    console.log(`  encodedMsg first 200: ${encodedMsg.slice(0, 200)}`);
    console.log(`  MessageType value: ${BrowserVMProvider.MessageType.CooperativeUpdate}`);

    const counterpartyWallet = this.getSigningWallet(counterpartyEntityId);
    const hankoEncoded = this.buildSingleSignerHanko(counterpartyEntityId, hash, counterpartyWallet);
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
    cooperativeNonce: bigint,
    disputeNonce: bigint,
    proofbodyHash: string
  ): Promise<string> {
    const channelKey = this.getChannelKey(entityId, counterpartyEntityId);

    // IMPORTANT: Solidity enums are encoded as uint256, not uint8!
    // Include depositoryAddress for chain+depository binding (replay protection)
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const encodedMsg = abiCoder.encode(
      ['uint256', 'address', 'bytes', 'uint256', 'uint256', 'bytes32'],
      [BrowserVMProvider.MessageType.DisputeProof, this.depositoryAddress?.toString() || '0x0000000000000000000000000000000000000000', channelKey, cooperativeNonce, disputeNonce, proofbodyHash]
    );

    const hash = ethers.keccak256(encodedMsg);
    const counterpartyWallet = this.getSigningWallet(counterpartyEntityId);
    return this.buildSingleSignerHanko(counterpartyEntityId, hash, counterpartyWallet);
  }

  // ═══════════════════════════════════════════════════════════════════════════

  /** Get on-chain account info (cooperativeNonce, disputeHash, disputeTimeout) */
  async getAccountInfo(entityId: string, counterpartyId: string): Promise<{ cooperativeNonce: bigint; disputeHash: string; disputeTimeout: bigint }> {
    if (!this.depositoryAddress || !this.depositoryInterface) throw new Error('Depository not deployed');

    const channelKeyData = this.depositoryInterface.encodeFunctionData('accountKey', [entityId, counterpartyId]);
    const channelKeyResult = await this.vm.evm.runCall({
      to: this.depositoryAddress,
      caller: this.deployerAddress,
      data: hexToBytes(channelKeyData as `0x${string}`),
      gasLimit: 100000n,
    });
    if (channelKeyResult.execResult.exceptionError) {
      return { cooperativeNonce: 0n, disputeHash: '0x', disputeTimeout: 0n };
    }
    const channelKeyDecoded = this.depositoryInterface.decodeFunctionResult(
      'accountKey',
      channelKeyResult.execResult.returnValue
    );
    const channelKey = channelKeyDecoded[0];

    const callData = this.depositoryInterface.encodeFunctionData('_accounts', [channelKey]);
    const result = await this.vm.evm.runCall({
      to: this.depositoryAddress,
      caller: this.deployerAddress,
      data: hexToBytes(callData as `0x${string}`),
      gasLimit: 100000n,
    });
    if (result.execResult.exceptionError) {
      return { cooperativeNonce: 0n, disputeHash: '0x', disputeTimeout: 0n };
    }

    const decoded = this.depositoryInterface.decodeFunctionResult('_accounts', result.execResult.returnValue);
    return {
      cooperativeNonce: BigInt(decoded[0]),
      disputeHash: decoded[1],
      disputeTimeout: BigInt(decoded[2]),
    };
  }

  /** Get debts for an entity */
  async getDebts(entityId: string, tokenId: number): Promise<Array<{amount: bigint, creditor: string}>> {
    if (!this.depositoryAddress || !this.depositoryInterface) throw new Error('Depository not deployed');

    // Use ethers Interface for ABI encoding (same as mainnet)
    const callData = this.depositoryInterface.encodeFunctionData('getDebts', [entityId, tokenId]);

    const result = await this.vm.evm.runCall({
      to: this.depositoryAddress,
      caller: this.deployerAddress,
      data: hexToBytes(callData as `0x${string}`),
      gasLimit: 500000n,
    });

    if (result.execResult.exceptionError) return [];

    try {
      const decoded = this.depositoryInterface.decodeFunctionResult('getDebts', result.execResult.returnValue);
      // decoded[0] is the Debt[] array
      return decoded[0].map((d: any) => ({ amount: d.amount, creditor: d.creditor }));
    } catch {
      return [];
    }
  }

  /** Enforce debts (FIFO) */
  async enforceDebts(entityId: string, tokenId: number, maxIterations: number = 100): Promise<bigint> {
    if (!this.depositoryAddress || !this.depositoryInterface) throw new Error('Depository not deployed');

    // Use ethers Interface for ABI encoding (same as mainnet)
    const callData = this.depositoryInterface.encodeFunctionData('enforceDebts', [entityId, tokenId, maxIterations]);

    const currentNonce = await this.getCurrentNonce();
    const tx = createLegacyTx({
      to: this.depositoryAddress,
      gasLimit: 2000000n,
      gasPrice: 10n,
      data: hexToBytes(callData as `0x${string}`),
      nonce: currentNonce,
    }, { common: this.common }).sign(this.deployerPrivKey);

    const result = await this.runTxInBlock(tx);

    if (result.execResult.exceptionError) {
      console.error(`[BrowserVM] enforceDebts failed:`, result.execResult.exceptionError);
      return 0n;
    }

    try {
      const decoded = this.depositoryInterface.decodeFunctionResult('enforceDebts', result.execResult.returnValue);
      console.log(`[BrowserVM] Enforced debts for ${entityId.slice(0, 10)}..., paid: ${decoded[0]}`);
      return decoded[0];
    } catch {
      return 0n;
    }
  }

  /** Process batch (Hanko) - calls Depository.processBatch() directly (no TS logic duplication) */
  async processBatch(encodedBatch: string, entityProvider: string, hankoData: string, nonce: bigint): Promise<EVMEvent[]> {
    if (!this.depositoryAddress || !this.depositoryInterface) {
      throw new Error('Depository not deployed');
    }

    console.log(`[BrowserVM] processBatch: calling contract with hanko (nonce=${nonce})...`);

    // BrowserVM submits as admin to mirror J-machine execution (Hanko still enforced on-chain).
    // Call Depository.processBatch() - ALL logic in Solidity (single source of truth)
    const callData = this.depositoryInterface.encodeFunctionData('processBatch', [encodedBatch, entityProvider, hankoData, nonce]);

    const currentNonce = await this.getCurrentNonce();
    const tx = createLegacyTx({
      to: this.depositoryAddress,
      gasLimit: 10000000n,
      gasPrice: 10n,
      data: hexToBytes(callData as `0x${string}`),
      nonce: currentNonce,
    }, { common: this.common }).sign(this.deployerPrivKey);

    const result = await this.runTxInBlock(tx);

    if (result.execResult.exceptionError) {
      let claimedEntityId: string | null = null;
      let expectedNextNonce: bigint | null = null;
      let batchSummary: string | null = null;
      let revertReason: string | null = null;
      const returnData = bytesToHex(result.execResult.returnValue || new Uint8Array());
      try {
        const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
          ['tuple(bytes32[],bytes,tuple(bytes32,uint256[],uint256[],uint256)[])'],
          hankoData
        );
        const claims = decoded[0][2];
        if (claims.length > 0) {
          claimedEntityId = ethers.hexlify(claims[claims.length - 1][0]);
          expectedNextNonce = (await this.getEntityNonce(claimedEntityId)) + 1n;
        }
        const { decodeJBatch, summarizeBatch } = await import('../j-batch');
        const batch = decodeJBatch(encodedBatch);
        batchSummary = safeStringify(summarizeBatch(batch));
        if (returnData !== '0x') {
          try {
            const parsed = this.depositoryInterface?.parseError(returnData);
            if (parsed) {
              revertReason = `${parsed.name}(${parsed.args?.map((arg: any) => String(arg)).join(', ')})`;
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
    rawLogs.forEach((log: any, i: number) => {
      console.log(`   Log ${i}: topics=${log[1]?.length || 0}, data=${log[2]?.length || 0} bytes`);
    });

    const events = this.emitEvents(rawLogs);
    console.log(`[BrowserVM] ✅ Batch processed: ${events.length} events`);
    events.forEach(e => console.log(`   - ${e.name}`));

    return events;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //                              TIME TRAVEL (J-MACHINE STATE)
  // ═══════════════════════════════════════════════════════════════════════════

  /** Capture current EVM state root (32 bytes) - for JReplica */
  async captureStateRoot(): Promise<Uint8Array> {
    return await this.vm.stateManager.getStateRoot();
  }

  /** Time travel to historical state root */
  async timeTravel(stateRoot: Uint8Array): Promise<void> {
    await this.vm.stateManager.setStateRoot(stateRoot);
    this.log(`[BrowserVM] Time traveled to state root: ${Buffer.from(stateRoot).toString('hex').slice(0, 16)}...`);
  }

  /** Get current block number */
  getBlockNumber(): bigint {
    return BigInt(this.blockHeight);
  }

  getBlockTimestamp(): number {
    return this.blockTimestamp;
  }

  /** Get chainId for batch hanko hashing */
  getChainId(): bigint {
    if (!this.common) return 1337n;
    const id = (this.common as any).chainId?.();
    if (typeof id === 'bigint') return id;
    if (typeof id === 'number') return BigInt(id);
    return 1337n;
  }

  /** Get current entity batch nonce (Depository.entityNonces) */
  async getEntityNonce(entityId: string): Promise<bigint> {
    if (!this.depositoryAddress || !this.depositoryInterface) {
      throw new Error('Depository not deployed');
    }
    const normalizedEntityId = normalizeEntityId(entityId);
    const entityAddress = ethers.getAddress(`0x${normalizedEntityId.slice(-40)}`);
    const callData = this.depositoryInterface.encodeFunctionData('entityNonces', [entityAddress]);
    const result = await this.vm.evm.runCall({
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

  /** Check if initialized */
  isInitialized(): boolean {
    return this.initialized;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //                              INSURANCE
  // ═══════════════════════════════════════════════════════════════════════════

  /** Get all insurance lines for an entity */
  async getInsuranceLines(entityId: string): Promise<Array<{
    insurer: string;
    tokenId: number;
    remaining: bigint;
    expiresAt: bigint;
  }>> {
    if (!this.depositoryAddress || !this.depositoryInterface) {
      throw new Error('Depository not deployed');
    }

    const callData = this.depositoryInterface.encodeFunctionData('getInsuranceLines', [entityId]);

    const result = await this.vm.evm.runCall({
      to: this.depositoryAddress,
      caller: this.deployerAddress,
      data: hexToBytes(callData as `0x${string}`),
      gasLimit: 500000n,
    });

    if (result.execResult.exceptionError) {
      console.error('[BrowserVM] getInsuranceLines failed:', result.execResult.exceptionError);
      return [];
    }
    try {
      const decoded = this.depositoryInterface.decodeFunctionResult('getInsuranceLines', result.execResult.returnValue);
      return decoded[0].map((line: any) => ({
        insurer: line.insurer,
        tokenId: Number(line.tokenId),
        remaining: line.remaining,
        expiresAt: line.expiresAt,
      }));
    } catch {
      return [];
    }
  }

  /** Get available insurance coverage for entity+token */
  async getAvailableInsurance(entityId: string, tokenId: number): Promise<bigint> {
    if (!this.depositoryAddress || !this.depositoryInterface) {
      throw new Error('Depository not deployed');
    }

    const callData = this.depositoryInterface.encodeFunctionData('getAvailableInsurance', [entityId, tokenId]);

    const result = await this.vm.evm.runCall({
      to: this.depositoryAddress,
      caller: this.deployerAddress,
      data: hexToBytes(callData as `0x${string}`),
      gasLimit: 100000n,
    });

    if (result.execResult.exceptionError) {
      console.error('[BrowserVM] getAvailableInsurance failed:', result.execResult.exceptionError);
      return 0n;
    }

    try {
      const decoded = this.depositoryInterface.decodeFunctionResult('getAvailableInsurance', result.execResult.returnValue);
      return decoded[0];
    } catch {
      return 0n;
    }
  }

  /**
   * Execute settle with insurance registration.
   * Signature is required for any state changes.
   *
   * @param leftEntity - The left entity (smaller entityId)
   * @param rightEntity - The right entity (larger entityId)
   * @param sig - Hanko signature from counterparty (required if there are changes).
   */
  async settleWithInsurance(
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
    insuranceRegs: Array<{
      insured: string;
      insurer: string;
      tokenId: number;
      limit: bigint;
      expiresAt: bigint;
    }> = [],
    sig?: string
  ): Promise<any[]> {
    if (!this.depositoryAddress || !this.depositoryInterface) {
      throw new Error('Depository not deployed');
    }

    const hasChanges = diffs.length > 0 || forgiveDebtsInTokenIds.length > 0 || insuranceRegs.length > 0;
    let finalSig = sig || '';
    console.log(`[BrowserVM] settleWithInsurance: input sig length=${sig?.length || 0}, diffs=${diffs.length}`);
    if (hasChanges && (!finalSig || finalSig === '0x')) {
      throw new Error('Settlement signature required for settleWithInsurance');
    }
    if (!finalSig) {
      finalSig = '0x';
    }

    console.log(`[BrowserVM] settle call params:`);
    console.log(`  leftEntity: ${leftEntity}`);
    console.log(`  rightEntity: ${rightEntity}`);
    console.log(`  diffs: ${JSON.stringify(diffs.map(d => ({ tokenId: d.tokenId, leftDiff: d.leftDiff.toString(), rightDiff: d.rightDiff.toString(), collateralDiff: d.collateralDiff.toString(), ondeltaDiff: d.ondeltaDiff.toString() })))}`);
    console.log(`  finalSig length: ${finalSig.length}`);

    const callData = this.depositoryInterface.encodeFunctionData('settle', [
      leftEntity,
      rightEntity,
      diffs,
      forgiveDebtsInTokenIds,
      insuranceRegs,
      finalSig,
    ]);
    console.log(`[BrowserVM] settle calldata length: ${(callData.length - 2) / 2} bytes`);
    console.log(`[BrowserVM] settle calldata selector: ${callData.slice(0, 10)}`);

    // Debug: verify calldata can be decoded back
    try {
      const decoded = this.depositoryInterface.decodeFunctionData('settle', callData);
      console.log(`[BrowserVM] Calldata decode check: decoded ${decoded.length} params`);
      console.log(`  [0] leftEntity: ${decoded[0]}`);
      console.log(`  [1] rightEntity: ${decoded[1]}`);
      console.log(`  [2] diffs count: ${decoded[2].length}`);
      console.log(`  [5] sig length: ${decoded[5].length} bytes`);
      if (decoded[2].length > 0) {
        const d = decoded[2][0];
        console.log(`  [2][0] diff: tokenId=${d[0]}, leftDiff=${d[1]}, rightDiff=${d[2]}, collateralDiff=${d[3]}, ondeltaDiff=${d[4]}`);
      }
      // Debug: Dump first 200 bytes of sig
      const sigHex = decoded[5] as string;
      console.log(`  [5] sig first 200 chars: ${sigHex.slice(0, 200)}`);
    } catch (e: any) {
      console.error(`[BrowserVM] Calldata decode ERROR: ${e.message}`);
    }

    // Try with different gas limits to isolate the gas hog
    const gasLimit = finalSig.length > 100 ? 30000000n : 2000000n;  // More gas for Hanko
    console.log(`[BrowserVM] Using gas limit: ${gasLimit}`);
    const currentNonce = await this.getCurrentNonce();
    const tx = createLegacyTx({
      to: this.depositoryAddress,
      gasLimit,
      gasPrice: 10n,
      data: hexToBytes(callData as `0x${string}`),
      nonce: currentNonce,
    }, { common: this.common }).sign(this.deployerPrivKey);

    const result = await this.runTxInBlock(tx);

    if (result.execResult.exceptionError) {
      console.error('[BrowserVM] settle failed:', result.execResult.exceptionError);
      console.error('[BrowserVM] returnValue length:', result.execResult.returnValue?.length || 0);
      console.error('[BrowserVM] gasUsed:', result.execResult.executionGasUsed?.toString());
      console.error('[BrowserVM] exceptionError type:', typeof result.execResult.exceptionError);
      if (result.execResult.exceptionError.error) {
        console.error('[BrowserVM] exceptionError.error:', result.execResult.exceptionError.error);
      }

      // Log any events that were emitted before revert (helps debugging)
      const logsBeforeRevert = result.execResult.logs || [];
      if (logsBeforeRevert.length > 0) {
        console.log('[BrowserVM] Events before revert:', logsBeforeRevert.length);
        const events = this.parseLogs(logsBeforeRevert);
        for (const ev of events) {
          console.log(`   Event: ${ev.name}`, JSON.stringify(ev.args, (k, v) => typeof v === 'bigint' ? v.toString() : v));
        }
      } else {
        console.log('[BrowserVM] No events emitted before revert');
      }

      // Try to decode revert reason
      if (result.execResult.returnValue && result.execResult.returnValue.length > 0) {
        const returnData = bytesToHex(result.execResult.returnValue);
        console.error('[BrowserVM] Revert data:', returnData);

        // Try to decode as Error(string) or custom error
        try {
          if (returnData.startsWith('0x08c379a0')) {
            // Error(string) selector
            const errorMsg = ethers.AbiCoder.defaultAbiCoder().decode(['string'], '0x' + returnData.slice(10))[0];
            console.error('[BrowserVM] Revert reason:', errorMsg);
          } else if (returnData.startsWith('0x')) {
            // Could be custom error
            const selectors: Record<string, string> = {
              '0xb2f59f24': 'E1 - Invalid operation',
              '0xf7d3f792': 'E2 - Nonce mismatch',
              '0x735e8e8e': 'E3 - Overflow',
              '0xa3f72b95': 'E4 - Invalid signature',
            };
            const errorSel = returnData.slice(0, 10);
            if (selectors[errorSel]) {
              console.error('[BrowserVM] Custom error:', selectors[errorSel]);
            }
          }
        } catch { /* ignore decode errors */ }
      }

      return [];
    }

    // Parse and emit logs to j-watcher subscribers
    const logs = this.emitEvents(result.execResult.logs || []);

    const insuranceCount = insuranceRegs.length;
    console.log(`[BrowserVM] Settle completed: ${diffs.length} diffs, ${insuranceCount} insurance regs`);

    return logs;
  }

  /** Parse EVM logs into decoded events with block info for JBlock consensus.
   *  Checks both Depository and Account library interfaces since library events
   *  (like Account.AccountSettled) have different topic signatures.
   */
  private parseLogs(logs: any[]): EVMEvent[] {
    // Collect all interfaces that can parse events
    const interfaces = [
      this.depositoryInterface,
      this.accountInterface,
    ].filter((iface): iface is ethers.Interface => iface !== null);

    if (interfaces.length === 0) return [];

    const decoded: EVMEvent[] = [];
    for (const log of logs) {
      const topics = log[1].map((t: Uint8Array) => bytesToHex(t));
      const data = bytesToHex(log[2]);

      // Try each interface until one successfully parses the log
      for (const iface of interfaces) {
        try {
          const parsed = iface.parseLog({ topics, data });
          if (parsed) {
            decoded.push({
              name: parsed.name,
              args: Object.fromEntries(
                parsed.fragment.inputs.map((input, i) => [input.name, parsed.args[i]])
              ),
              blockNumber: this.blockHeight,
              blockHash: this.blockHash,
              timestamp: this.blockTimestamp,
            });
            break; // Found a match, move to next log
          }
        } catch {
          // This interface can't parse this log, try next
        }
      }
    }
    return decoded;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  ENTITY PROVIDER QUERIES - Real contract calls via BrowserVM
  // ═══════════════════════════════════════════════════════════════════════════

  /** Subscribe to all EVM events - j-watcher uses this for BrowserVM mode */
  /**
   * Subscribe to batched events. Callback receives ALL events from a single
   * transaction/block together, matching real blockchain behavior.
   */
  onAny(callback: (events: EVMEvent[]) => void): () => void {
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
  private emitEvents(logs: any[]): EVMEvent[] {
    this.log(`🔊 [BrowserVM] emitEvents ENTRY: raw logs=${logs.length}, callbacks=${this.eventCallbacks.size}`);
    const events = this.parseLogs(logs);
    this.log(`🔊 [BrowserVM] emitEvents: parsed ${events.length} events`);

    // Log individual events for debugging
    for (const event of events) {
      this.log(`   📣 EVENT: ${event.name} | ${safeStringify(event.args).slice(0, 80)}`);
    }

    // Emit BATCH to each callback (not one-by-one)
    if (events.length > 0) {
      for (const cb of this.eventCallbacks) {
        try {
          cb(events);
          this.log(`   ✓ batch of ${events.length} events fired to callback`);
        } catch (err) {
          console.error(`   ❌ cb error:`, err);
        }
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

    const result = await this.vm.evm.runCall({
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

    const result = await this.vm.evm.runCall({
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
  async serializeState(): Promise<{ version: number; stateRoot: string; trieData: Array<[string, string]>; nonce: string; addresses: { depository: string; entityProvider: string } }> {
    if (!this.initialized) throw new Error('BrowserVM not initialized');

    const stateRoot = await this.vm.stateManager.getStateRoot();

    // Access internal trie database
    const trie = (this.vm.stateManager as any)._trie;
    const db = trie.database().db;

    const getTrieMap = (store: any): Map<any, any> | null => {
      if (store instanceof Map) return store;
      if (store && store._database instanceof Map) return store._database;
      if (store && store.db instanceof Map) return store.db;
      return null;
    };

    // Serialize all key-value pairs from the trie database
    const trieData: Array<[string, string]> = [];
    const trieMap = getTrieMap(db);
    if (!trieMap) {
      throw new Error('BrowserVM serializeState: unsupported trie db');
    }
    const normalizeHex = (hex: string): string => {
      const raw = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
      return raw.length % 2 === 1 ? `0${raw}` : raw;
    };
    for (const [key, value] of trieMap.entries()) {
      const keyHexRaw = typeof key === 'string'
        ? key
        : Buffer.from(key).toString('hex');
      const valueHexRaw = typeof value === 'string'
        ? value
        : Buffer.from(value).toString('hex');
      const keyHex = normalizeHex(keyHexRaw);
      const valueHex = normalizeHex(valueHexRaw);
      trieData.push([keyHex, valueHex]);
    }

    this.log(`[BrowserVM] Serialized state: ${trieData.length} trie nodes, version=${CONTRACT_VERSION}`);

    return {
      version: CONTRACT_VERSION,
      stateRoot: Buffer.from(stateRoot).toString('hex'),
      trieData,
      nonce: this.nonce.toString(),
      addresses: {
        depository: this.depositoryAddress?.toString() || '',
        entityProvider: this.entityProviderAddress?.toString() || '',
      },
    };
  }

  /** Restore EVM state from serialized data (for page reload) */
  async restoreState(data: { stateRoot: string; trieData: Array<[string, string]>; nonce: string; addresses: { depository: string; entityProvider: string } }): Promise<void> {
    if (!this.initialized) {
      // Need to init first to get contracts deployed structure
      await this.init();
    }

    const normalizeHex = (value: unknown): string | null => {
      if (value === null || value === undefined) return null;
      if (typeof value === 'string') {
        const raw = value.startsWith('0x') ? value.slice(2) : value;
        if (raw.length === 0) return '';
        const normalized = raw.length % 2 === 1 ? `0${raw}` : raw;
        return /^[0-9a-fA-F]+$/.test(normalized) ? normalized : null;
      }
      if (value instanceof ArrayBuffer) {
        return Buffer.from(new Uint8Array(value)).toString('hex');
      }
      if (value instanceof Uint8Array) {
        return Buffer.from(value).toString('hex');
      }
      if (Array.isArray(value)) {
        try {
          return Buffer.from(value).toString('hex');
        } catch {
          return null;
        }
      }
      if (typeof value === 'object') {
        const maybeBuffer = value as { type?: string; data?: unknown };
        if (maybeBuffer.type === 'Buffer' && Array.isArray(maybeBuffer.data)) {
          try {
            return Buffer.from(maybeBuffer.data).toString('hex');
          } catch {
            return null;
          }
        }
      }
      return null;
    };

    const normalizeAddress = (value: unknown): string | null => {
      const hex = normalizeHex(value);
      if (hex === null) return null;
      const trimmed = hex.length > 40 ? hex.slice(-40) : hex.padStart(40, '0');
      if (trimmed.length !== 40) return null;
      return trimmed;
    };

    const hexToBytesSafe = (hex: string): Uint8Array => {
      if (hex.length === 0) return new Uint8Array();
      return hexToBytes(`0x${hex}`);
    };

    // Restore trie database entries
    const trie = (this.vm.stateManager as any)._trie;
    const db = trie.database().db;
    const getTrieMap = (store: any): Map<any, any> | null => {
      if (store instanceof Map) return store;
      if (store && store._database instanceof Map) return store._database;
      if (store && store.db instanceof Map) return store.db;
      return null;
    };

    const trieMap = getTrieMap(db);
    if (!trieMap) {
      throw new Error('BrowserVM restoreState: unsupported trie db');
    }
    trieMap.clear();
    for (const entry of data.trieData || []) {
      const keyHex = normalizeHex(entry?.[0]);
      const valueHex = normalizeHex(entry?.[1]);
      if (keyHex === null || valueHex === null) {
        throw new Error('BrowserVM restoreState: invalid trie entry');
      }
      // MapDB for MPT uses hex-string keys; keep key as string, values as bytes.
      trieMap.set(keyHex, hexToBytesSafe(valueHex));
    }

    // Restore state root
    const stateRootHex = normalizeHex(data.stateRoot);
    if (!stateRootHex) {
      throw new Error('BrowserVM restoreState: invalid stateRoot');
    }
    const paddedStateRoot = stateRootHex.padStart(64, '0');
    const stateRoot = hexToBytes(`0x${paddedStateRoot}`);
    await this.vm.stateManager.setStateRoot(stateRoot);

    // Restore nonce
    try {
      const nonceValue = typeof data.nonce === 'string' ? data.nonce : String(data.nonce ?? '0');
      this.nonce = BigInt(nonceValue);
    } catch {
      this.nonce = 0n;
    }

    const depositoryHex = normalizeAddress(data.addresses?.depository);
    if (depositoryHex) {
      this.depositoryAddress = createAddressFromString(`0x${depositoryHex}`);
    }
    const entityProviderHex = normalizeAddress(data.addresses?.entityProvider);
    if (entityProviderHex) {
      this.entityProviderAddress = createAddressFromString(`0x${entityProviderHex}`);
    }

    this.log(`[BrowserVM] Restored state: ${data.trieData.length} trie nodes, root ${data.stateRoot.slice(0, 16)}...`);
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
      if (cachedVersion !== CONTRACT_VERSION) {
        this.log(`[BrowserVM] ⚠️ Version mismatch: cached=${cachedVersion}, current=${CONTRACT_VERSION} - clearing stale cache`);
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
    tokenId: number
  ): Promise<Map<string, Map<number, { collateral: bigint; ondelta: bigint }>>> {
    const collaterals = new Map<string, Map<number, { collateral: bigint; ondelta: bigint }>>();

    for (const { entityId, counterpartyId } of accountPairs) {
      const accountKey = `${entityId}:${counterpartyId}`;
      const data = await this.getCollateral(entityId, counterpartyId, tokenId);

      if (data.collateral > 0n || data.ondelta !== 0n) {
        if (!collaterals.has(accountKey)) {
          collaterals.set(accountKey, new Map());
        }
        collaterals.get(accountKey)!.set(tokenId, data);
      }
    }

    this.log(`[BrowserVM] Synced collaterals for ${accountPairs.length} accounts`);
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
    this.prevBlockHash = this.blockHash;
    this.blockHeight = nextHeight;
    this.blockHash = bytesToHex(block.header.hash());
    this.blockTimestamp = timestampMs;
    return block;
  }

  /** Begin a J-block (all txs share the same block header). */
  beginJurisdictionBlock(timestampMs: number): void {
    this.activeBlock = this.createBlock(timestampMs);
  }

  /** End a J-block. */
  endJurisdictionBlock(): void {
    this.activeBlock = null;
  }

  /** Get current block hash */
  getBlockHash(): string {
    return this.blockHash;
  }

  /** Get transaction receipt by hash (for ethers compatibility) */
  getTransactionReceipt(txHash: string): {
    transactionHash: string;
    blockNumber: number;
    blockHash: string;
    from: string;
    to: string | null;
    contractAddress: string | null;
    status: number;
    logs: Array<{
      address: string;
      topics: string[];
      data: string;
      blockNumber: number;
      transactionHash: string;
      logIndex: number;
    }>;
  } | null {
    return this.txReceipts.get(txHash) ?? null;
  }

  /** Set deterministic block timestamp for next tx/block */
  setBlockTimestamp(timestamp: number): void {
    if (!this.activeBlock) {
      this.blockTimestamp = timestamp;
    }
  }

  private async runTxInBlock(tx: any): Promise<any> {
    const block = this.activeBlock ?? this.createBlock(this.blockTimestamp);
    // Skip nonce validation for simnet - ethereumjs stateManager has caching issues
    // that cause nonce mismatches between getAccount reads and actual VM state
    return runTx(this.vm, { tx, block, skipNonce: true });
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
    const currentNonce = await this.getCurrentNonce();

    const tx = createLegacyTx({
      to: this.entityProviderAddress,
      gasLimit: 5000000n,
      gasPrice: 10n,
      data: hexToBytes(callData as `0x${string}`),
      nonce: currentNonce,
    }, { common: this.common }).sign(this.deployerPrivKey);

    const result = await this.runTxInBlock(tx);

    if (result.execResult.exceptionError) {
      throw new Error(`registerNumberedEntitiesBatch failed: ${result.execResult.exceptionError}`);
    }

    // Decode return value - array of uint256 entity numbers
    const decoded = this.entityProviderInterface.decodeFunctionResult('registerNumberedEntitiesBatch', result.execResult.returnValue);
    const entityNumbers = (decoded[0] as bigint[]).map((n: bigint) => Number(n));

    console.log(`[BrowserVM] registerNumberedEntitiesBatch: ${boardHashes.length} entities → [${entityNumbers.join(',')}]`);
    return {
      entityNumbers,
      txHash: '0x' + 'browservm-register-batch'.padStart(64, '0'),
    };
  }

  /**
   * Register numbered entities with their validator signerIds.
   * Creates boards with signer addresses as sole validators.
   * @param signerIds Array of signerIds (e.g., ['1', '2', '3'])
   * @returns Array of assigned entity numbers
   */
  async registerEntitiesWithSigners(signerIds: string[]): Promise<number[]> {
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const boardHashes: string[] = [];

    for (const signerId of signerIds) {
      const privateKey = getCachedSignerPrivateKey(signerId);
      if (!privateKey) {
        throw new Error(`No private key for signerId ${signerId} - register signer keys (vault seed or registerSignerKey) before entity registration`);
      }

      // Get validator address from private key
      const wallet = new ethers.Wallet(ethers.hexlify(privateKey));
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
      const info = await this.getEntityInfo(entityId);
      console.log(`[BrowserVM]   Verified entity ${entityNum}: stored boardHash=${info.currentBoardHash?.slice(0, 18)}...`);
      if (info.currentBoardHash !== boardHashes[i]) {
        console.error(`[BrowserVM] ⚠️ Hash mismatch! Expected ${boardHashes[i]}, got ${info.currentBoardHash}`);
      }
    }

    return entityNumbers;
  }

}

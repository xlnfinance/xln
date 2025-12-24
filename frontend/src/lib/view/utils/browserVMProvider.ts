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
import { createLegacyTx } from '@ethereumjs/tx';
import { createAddressFromPrivateKey, hexToBytes, createAccount, bytesToHex } from '@ethereumjs/util';
import type { Address } from '@ethereumjs/util';
import { Common, Hardfork, Chain } from '@ethereumjs/common';
import { ethers } from 'ethers';
import { safeStringify } from '$lib/utils/safeStringify';

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
  private deployerPrivKey: Uint8Array;
  private deployerAddress: Address;
  private nonce = 0n;
  private accountArtifact: any = null;
  private depositoryArtifact: any = null;
  private entityProviderArtifact: any = null;
  private depositoryInterface: ethers.Interface | null = null;
  private entityProviderInterface: ethers.Interface | null = null;
  private initialized = false;
  private blockHeight = 0; // Track J-Machine block height
  private blockHash = '0x0000000000000000000000000000000000000000000000000000000000000000'; // Current block hash
  private prevBlockHash = '0x0000000000000000000000000000000000000000000000000000000000000000'; // Previous block hash
  // ─────────────────────────────────────────────────────────────────────────────
  // Event callbacks receive BATCHES of events (all events from one tx/block)
  // This matches real blockchain behavior where events are grouped by block
  // ─────────────────────────────────────────────────────────────────────────────
  private eventCallbacks: Set<(events: EVMEvent[]) => void> = new Set();

  constructor() {
    // Hardhat default account #0
    this.deployerPrivKey = hexToBytes('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
    this.deployerAddress = createAddressFromPrivateKey(this.deployerPrivKey);
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
      const [accountResp, depositoryResp, entityProviderResp] = await Promise.all([
        fetch('/contracts/Account.json'),
        fetch('/contracts/Depository.json'),
        fetch('/contracts/EntityProvider.json'),
      ]);

      if (!accountResp.ok) throw new Error(`Failed to load Account artifact: ${accountResp.status}`);
      if (!depositoryResp.ok) throw new Error(`Failed to load Depository artifact: ${depositoryResp.status}`);
      if (!entityProviderResp.ok) throw new Error(`Failed to load EntityProvider artifact: ${entityProviderResp.status}`);

      this.accountArtifact = await accountResp.json();
      this.depositoryArtifact = await depositoryResp.json();
      this.entityProviderArtifact = await entityProviderResp.json();
    } else {
      // CLI: read from jurisdictions/artifacts/
      const fs = await import('fs');
      const path = await import('path');
      const basePath = path.join(process.cwd(), 'jurisdictions/artifacts/contracts');

      this.accountArtifact = JSON.parse(fs.readFileSync(path.join(basePath, 'Account.sol/Account.json'), 'utf-8'));
      this.depositoryArtifact = JSON.parse(fs.readFileSync(path.join(basePath, 'Depository.sol/Depository.json'), 'utf-8'));
      this.entityProviderArtifact = JSON.parse(fs.readFileSync(path.join(basePath, 'EntityProvider.sol/EntityProvider.json'), 'utf-8'));
      console.log('[BrowserVM] Loaded artifacts from filesystem (CLI mode)');
    }

    // Create ethers Interfaces for ABI encoding
    this.depositoryInterface = new ethers.Interface(this.depositoryArtifact.abi);
    this.entityProviderInterface = new ethers.Interface(this.entityProviderArtifact.abi);
    console.log('[BrowserVM] Loaded all contract artifacts');

    // Create VM with evmOpts to disable contract size limit
    this.vm = await createVM({
      evmOpts: {
        allowUnlimitedContractSize: true, // Disable EIP-170 24KB limit for simnet
      },
    });
    this.common = this.vm.common;
    console.log('[BrowserVM] Unlimited contract size enabled for simnet');

    // Fund deployer
    const deployerAccount = createAccount({
      nonce: 0n,
      balance: 10000000000000000000000n, // 10000 ETH
    });
    await this.vm.stateManager.putAccount(this.deployerAddress, deployerAccount);
    console.log(`[BrowserVM] Deployer funded: ${this.deployerAddress.toString()}`);

    // Deploy contracts in order: Account (library) → Depository (with linking) → EntityProvider
    await this.deployAccount();
    await this.deployDepository();
    await this.deployEntityProvider();

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
    this.nonce = 0n;
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

    const result = await runTx(this.vm, { tx });
    this.incrementBlock(); // Transaction mined successfully

    if (result.execResult.exceptionError) {
      console.error('[BrowserVM] Account deployment failed:', result.execResult.exceptionError);
      throw new Error(`Account deployment failed: ${result.execResult.exceptionError}`);
    }

    this.accountAddress = result.createdAddress!;
    console.log(`[BrowserVM] Account library deployed at: ${this.accountAddress.toString()}`);
  }

  /** Deploy Depository contract with Account library linking */
  private async deployDepository(): Promise<void> {
    console.log('[BrowserVM] Deploying Depository with Account library linking...');

    if (!this.accountAddress) {
      throw new Error('Account library must be deployed first');
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

    const currentNonce = await this.getCurrentNonce();

    const tx = createLegacyTx({
      gasLimit: 100000000n,
      gasPrice: 10n,
      data: linkedBytecode,
      nonce: currentNonce,
    }, { common: this.common }).sign(this.deployerPrivKey);

    const result = await runTx(this.vm, { tx });
    this.incrementBlock(); // Transaction mined successfully

    if (result.execResult.exceptionError) {
      console.error('[BrowserVM] Depository deployment failed:', result.execResult.exceptionError);
      throw new Error(`Depository deployment failed: ${result.execResult.exceptionError}`);
    }

    this.depositoryAddress = result.createdAddress!;
    console.log(`[BrowserVM] Depository deployed at: ${this.depositoryAddress.toString()}`);
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

    const result = await runTx(this.vm, { tx });
    this.incrementBlock(); // Transaction mined successfully

    if (result.execResult.exceptionError) {
      console.error('[BrowserVM] EntityProvider deployment failed:', result.execResult.exceptionError);
      throw new Error(`EntityProvider deployment failed: ${result.execResult.exceptionError}`);
    }

    this.entityProviderAddress = result.createdAddress!;
    console.log(`[BrowserVM] EntityProvider deployed at: ${this.entityProviderAddress.toString()}`);
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

  /** Debug: Fund entity reserves (uses mintToReserve in testMode) - emits ReserveUpdated event */
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

    const result = await runTx(this.vm, { tx });
    this.incrementBlock(); // Transaction mined successfully

    if (result.execResult.exceptionError) {
      throw new Error(`mintToReserve failed: ${result.execResult.exceptionError}`);
    }

    console.log(`[BrowserVM] Funded ${entityId.slice(0, 10)}... with ${amount} of token ${tokenId}`);
    console.log(`[BrowserVM] debugFundReserves: logs=${result.execResult.logs?.length || 0}`);

    // Emit events to j-watcher subscribers
    return this.emitEvents(result.execResult.logs || []);
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

    const result = await runTx(this.vm, { tx });
    this.incrementBlock(); // Transaction mined successfully

    if (result.execResult.exceptionError) {
      throw new Error(`reserveToReserve failed: ${result.execResult.exceptionError}`);
    }

    console.log(`[BrowserVM] Transferred ${amount} from ${from.slice(0, 10)}... to ${to.slice(0, 10)}...`);

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
   */
  async reserveToCollateralDirect(entityId: string, counterpartyId: string, tokenId: number, amount: bigint): Promise<EVMEvent[]> {
    if (!this.depositoryAddress || !this.depositoryInterface) throw new Error('Depository not deployed');

    // Use settle() with appropriate diffs to achieve R2C effect
    // settleDiffs: { tokenId, leftDiff, rightDiff, collateralDiff, ondeltaDiff }
    const isLeft = BigInt(entityId) < BigInt(counterpartyId);
    const leftEntity = isLeft ? entityId : counterpartyId;
    const rightEntity = isLeft ? counterpartyId : entityId;

    // R2C: Reduce entity's reserve, increase collateral + ondelta
    // If entity is LEFT: leftDiff = -amount, collateralDiff = +amount, ondeltaDiff = +amount
    // If entity is RIGHT: rightDiff = -amount, collateralDiff = +amount, ondeltaDiff = -amount
    const diffs = [{
      tokenId,
      leftDiff: isLeft ? -BigInt(amount) : 0n,
      rightDiff: isLeft ? 0n : -BigInt(amount),
      collateralDiff: BigInt(amount),
      ondeltaDiff: isLeft ? BigInt(amount) : -BigInt(amount),
    }];

    const callData = this.depositoryInterface.encodeFunctionData('settle', [
      leftEntity,
      rightEntity,
      diffs,
      [], // forgiveDebtsInTokenIds
      [], // insuranceRegs
      '0x', // sig (testMode skips verification)
    ]);

    const currentNonce = await this.getCurrentNonce();
    const tx = createLegacyTx({
      to: this.depositoryAddress,
      gasLimit: 1000000n,
      gasPrice: 10n,
      data: hexToBytes(callData as `0x${string}`),
      nonce: currentNonce,
    }, { common: this.common }).sign(this.deployerPrivKey);

    const result = await runTx(this.vm, { tx });
    if (result.execResult.exceptionError) {
      throw new Error(`R2C failed: ${result.execResult.exceptionError}`);
    }
    this.incrementBlock();
    console.log(`[BrowserVM] R2C: ${amount} from ${entityId.slice(0, 10)}... → account with ${counterpartyId.slice(0, 10)}...`);
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
    const channelKey = channelKeyResult.execResult.returnValue;

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

    const result = await runTx(this.vm, { tx });
    this.incrementBlock(); // Transaction mined successfully
    if (result.execResult.exceptionError) {
      console.error(`[BrowserVM] enforceDebts failed:`, result.execResult.exceptionError);
      return 0n;
    }
    this.incrementBlock();

    try {
      const decoded = this.depositoryInterface.decodeFunctionResult('enforceDebts', result.execResult.returnValue);
      console.log(`[BrowserVM] Enforced debts for ${entityId.slice(0, 10)}..., paid: ${decoded[0]}`);
      return decoded[0];
    } catch {
      return 0n;
    }
  }

  /** Process a full batch - executes R2R, R2C, and settlements */
  async processBatch(entityId: string, batch: {
    reserveToReserve?: Array<{toEntity: string, tokenId: number, amount: bigint}>,
    reserveToCollateral?: Array<{counterparty: string, tokenId: number, amount: bigint}>,
    settlements?: Array<{leftEntity: string, rightEntity: string, diffs: any[]}>,
  }): Promise<EVMEvent[]> {
    if (!this.depositoryAddress) throw new Error('Depository not deployed');

    const allEvents: EVMEvent[] = [];

    // Execute R2R (Reserve to Reserve) transfers OR mints
    if (batch.reserveToReserve) {
      for (const r2r of batch.reserveToReserve) {
        // Use "toEntity" field (converted from receivingEntity by j-batch.ts)
        console.log(`[BrowserVM] R2R: entityId=${entityId?.slice(0,10)}, toEntity=${r2r.toEntity?.slice(0,10)}, token=${r2r.tokenId}, amount=${r2r.amount}`);

        // If toEntity = entityId, this is a MINT (no sender)
        // Otherwise it's a transfer FROM entityId TO toEntity
        if (r2r.toEntity === entityId) {
          // MINT: Call debugFundReserves (mints from Depository)
          console.log(`[BrowserVM] MINT detected (toEntity === entityId)`);
          const events = await this.debugFundReserves(r2r.toEntity, r2r.tokenId, r2r.amount);
          allEvents.push(...events);
        } else {
          // R2R: Transfer from entityId to toEntity
          console.log(`[BrowserVM] R2R transfer`);
          const events = await this.reserveToReserve(entityId, r2r.toEntity, r2r.tokenId, r2r.amount);
          allEvents.push(...events);
        }
      }
    }

    // Execute R2C (Reserve to Collateral) deposits
    if (batch.reserveToCollateral) {
      for (const r2c of batch.reserveToCollateral) {
        const events = await this.reserveToCollateralDirect(entityId, r2c.counterparty, r2c.tokenId, r2c.amount);
        allEvents.push(...events);
      }
    }

    // Execute settlements
    if (batch.settlements) {
      for (const settle of batch.settlements) {
        const result = await this.settleWithInsurance(settle.leftEntity, settle.rightEntity, settle.diffs);
        if (result.logs) {
          allEvents.push(...result.logs);
        }
      }
    }

    console.log(`[BrowserVM] Batch processed for ${entityId.slice(0, 10)}...: ${allEvents.length} events`);
    return allEvents;
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
    console.log(`[BrowserVM] Time traveled to state root: ${Buffer.from(stateRoot).toString('hex').slice(0, 16)}...`);
  }

  /** Get current block number */
  getBlockNumber(): bigint {
    return this.vm.blockchain?.currentBlock?.header?.number || 0n;
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
    this.incrementBlock();

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
    this.incrementBlock();

    try {
      const decoded = this.depositoryInterface.decodeFunctionResult('getAvailableInsurance', result.execResult.returnValue);
      return decoded[0];
    } catch {
      return 0n;
    }
  }

  /** Execute settle with insurance registration */
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
    sig: string = '0x'
  ): Promise<{ success: boolean; logs: any[] }> {
    if (!this.depositoryAddress || !this.depositoryInterface) {
      throw new Error('Depository not deployed');
    }

    const callData = this.depositoryInterface.encodeFunctionData('settle', [
      leftEntity,
      rightEntity,
      diffs,
      forgiveDebtsInTokenIds,
      insuranceRegs,
      sig,
    ]);

    const currentNonce = await this.getCurrentNonce();
    const tx = createLegacyTx({
      to: this.depositoryAddress,
      gasLimit: 2000000n,
      gasPrice: 10n,
      data: hexToBytes(callData as `0x${string}`),
      nonce: currentNonce,
    }, { common: this.common }).sign(this.deployerPrivKey);

    const result = await runTx(this.vm, { tx });
    this.incrementBlock(); // Transaction mined successfully

    if (result.execResult.exceptionError) {
      console.error('[BrowserVM] settle failed:', result.execResult.exceptionError);
      return { success: false, logs: [] };
    }

    // Parse and emit logs to j-watcher subscribers
    const logs = this.emitEvents(result.execResult.logs || []);

    const insuranceCount = insuranceRegs.length;
    console.log(`[BrowserVM] Settle completed: ${diffs.length} diffs, ${insuranceCount} insurance regs`);

    return { success: true, logs };
  }

  /** Parse EVM logs into decoded events with block info for JBlock consensus */
  private parseLogs(logs: any[]): EVMEvent[] {
    if (!this.depositoryInterface) return [];

    const decoded: EVMEvent[] = [];
    for (const log of logs) {
      try {
        const topics = log[1].map((t: Uint8Array) => bytesToHex(t));
        const data = bytesToHex(log[2]);
        const parsed = this.depositoryInterface.parseLog({ topics, data });
        if (parsed) {
          decoded.push({
            name: parsed.name,
            args: Object.fromEntries(
              parsed.fragment.inputs.map((input, i) => [input.name, parsed.args[i]])
            ),
            blockNumber: this.blockHeight,
            blockHash: this.blockHash,
            timestamp: Date.now(),
          });
        }
      } catch {
        // Skip unparseable logs
      }
    }
    return decoded;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  ENTITY PROVIDER STUBS - Used by JurisdictionPanel
  // ═══════════════════════════════════════════════════════════════════════════

  /** Subscribe to all EVM events - j-watcher uses this for BrowserVM mode */
  /**
   * Subscribe to batched events. Callback receives ALL events from a single
   * transaction/block together, matching real blockchain behavior.
   */
  onAny(callback: (events: EVMEvent[]) => void): () => void {
    this.eventCallbacks.add(callback);
    console.log(`[BrowserVM] onAny registered (${this.eventCallbacks.size} callbacks)`);
    return () => {
      this.eventCallbacks.delete(callback);
      console.log(`[BrowserVM] onAny unsubscribed (${this.eventCallbacks.size} callbacks)`);
    };
  }

  /**
   * Emit events to all registered callbacks as a BATCH.
   * All events from one transaction are sent together, matching blockchain behavior.
   */
  private emitEvents(logs: any[]): EVMEvent[] {
    console.log(`🔊 [BrowserVM] emitEvents ENTRY: raw logs=${logs.length}, callbacks=${this.eventCallbacks.size}`);
    const events = this.parseLogs(logs);
    console.log(`🔊 [BrowserVM] emitEvents: parsed ${events.length} events`);

    // Log individual events for debugging
    for (const event of events) {
      console.log(`   📣 EVENT: ${event.name} | ${safeStringify(event.args).slice(0, 80)}`);
    }

    // Emit BATCH to each callback (not one-by-one)
    if (events.length > 0) {
      for (const cb of this.eventCallbacks) {
        try {
          cb(events);
          console.log(`   ✓ batch of ${events.length} events fired to callback`);
        } catch (err) {
          console.error(`   ❌ cb error:`, err);
        }
      }
    }

    return events;
  }

  /** Get next available entity number */
  async getNextEntityNumber(): Promise<number> {
    // TODO: Read from EntityProvider contract when implemented
    return 1;
  }

  /** Get entity info by ID */
  async getEntityInfo(entityId: string): Promise<{ exists: boolean; name?: string; quorum?: string[]; threshold?: number }> {
    // TODO: Read from EntityProvider contract when implemented
    return { exists: false };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //                              STATE PERSISTENCE
  // ═══════════════════════════════════════════════════════════════════════════

  /** Serialize full EVM state (all trie nodes) for persistence */
  async serializeState(): Promise<{ stateRoot: string; trieData: Array<[string, string]>; nonce: string; addresses: { depository: string; entityProvider: string } }> {
    if (!this.initialized) throw new Error('BrowserVM not initialized');

    const stateRoot = await this.vm.stateManager.getStateRoot();

    // Access internal trie database
    const trie = (this.vm.stateManager as any)._trie;
    const db = trie.database().db;

    // Serialize all key-value pairs from the trie database
    const trieData: Array<[string, string]> = [];
    if (db instanceof Map) {
      for (const [key, value] of db.entries()) {
        trieData.push([
          Buffer.from(key).toString('hex'),
          Buffer.from(value).toString('hex'),
        ]);
      }
    }

    console.log(`[BrowserVM] Serialized state: ${trieData.length} trie nodes`);

    return {
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

    // Restore trie database entries
    const trie = (this.vm.stateManager as any)._trie;
    const db = trie.database().db;

    if (db instanceof Map) {
      db.clear();
      for (const [keyHex, valueHex] of data.trieData) {
        db.set(
          hexToBytes(`0x${keyHex}`),
          hexToBytes(`0x${valueHex}`),
        );
      }
    }

    // Restore state root
    const stateRoot = hexToBytes(`0x${data.stateRoot}`);
    await this.vm.stateManager.setStateRoot(stateRoot);

    // Restore nonce
    this.nonce = BigInt(data.nonce);

    console.log(`[BrowserVM] Restored state: ${data.trieData.length} trie nodes, root ${data.stateRoot.slice(0, 16)}...`);
  }

  /** Save full EVM state to localStorage */
  async saveToLocalStorage(key: string = 'xln-evm-state'): Promise<void> {
    try {
      const state = await this.serializeState();
      const json = JSON.stringify(state);
      localStorage.setItem(key, json);
      console.log(`[BrowserVM] Saved state to localStorage: ${key} (${(json.length / 1024).toFixed(1)}KB)`);
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
        console.log('[BrowserVM] No saved state found');
        return false;
      }

      const data = JSON.parse(json);
      await this.restoreState(data);
      console.log(`[BrowserVM] Loaded state from localStorage: ${key}`);
      return true;
    } catch (err) {
      console.error('[BrowserVM] Failed to load state:', err);
      return false;
    }
  }

  /** Clear saved state from localStorage */
  clearLocalStorage(key: string = 'xln-evm-state'): void {
    localStorage.removeItem(key);
    console.log(`[BrowserVM] Cleared saved state: ${key}`);
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

    console.log(`[BrowserVM] Synced collaterals for ${accountPairs.length} accounts`);
    return collaterals;
  }

  /** Get current block height (incremented with each successful transaction) */
  getBlockHeight(): number {
    return this.blockHeight;
  }

  /**
   * Increment block height and compute new block hash.
   * Block hash = keccak256(prevBlockHash + blockHeight + timestamp)
   * This mimics ETH block structure for JBlock consensus.
   */
  private incrementBlock(): void {
    this.prevBlockHash = this.blockHash;
    this.blockHeight++;
    // Compute deterministic block hash using ethers.js keccak256
    const packed = ethers.solidityPacked(
      ['bytes32', 'uint256', 'uint256'],
      [this.prevBlockHash, this.blockHeight, Date.now()]
    );
    this.blockHash = ethers.keccak256(packed);
  }

  /** Get current block hash */
  getBlockHash(): string {
    return this.blockHash;
  }

  /** Check if saved state exists */
  hasSavedState(key: string = 'xln-evm-state'): boolean {
    return localStorage.getItem(key) !== null;
  }
}

// Singleton instance
export const browserVMProvider = new BrowserVMProvider();

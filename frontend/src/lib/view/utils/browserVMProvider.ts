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

/** EVM event emitted from the BrowserVM */
export interface EVMEvent {
  name: string;
  args: Record<string, unknown>;
  blockNumber?: number;
  timestamp?: number;
}

export class BrowserVMProvider {
  private vm: any;
  private common: any;
  private depositoryAddress: Address | null = null;
  private deployerPrivKey: Uint8Array;
  private deployerAddress: Address;
  private nonce = 0n;
  private depositoryArtifact: any = null;
  private depositoryInterface: ethers.Interface | null = null;
  private initialized = false;

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

    // Load artifact from static/ (can't import JSON from /public in vite)
    const response = await fetch('/contracts/Depository.json');
    if (!response.ok) {
      throw new Error(`Failed to load Depository artifact: ${response.status}`);
    }
    this.depositoryArtifact = await response.json();

    // Create ethers Interface for ABI encoding (same as evm.ts mainnet pattern)
    this.depositoryInterface = new ethers.Interface(this.depositoryArtifact.abi);
    console.log('[BrowserVM] Initializing with ABI interface...');

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

    // Deploy Depository
    await this.deployDepository();

    this.initialized = true;
    console.log('[BrowserVM] Initialization complete');
  }

  /** Deploy Depository contract */
  private async deployDepository(): Promise<void> {
    console.log('[BrowserVM] Deploying Depository...');
    console.log('[BrowserVM] Bytecode length:', this.depositoryArtifact.bytecode?.length || 0);

    // Query nonce from VM state
    const currentNonce = await this.getCurrentNonce();

    const tx = createLegacyTx({
      gasLimit: 100000000n,
      gasPrice: 10n,
      data: this.depositoryArtifact.bytecode,
      nonce: currentNonce,
    }, { common: this.common }).sign(this.deployerPrivKey);

    const result = await runTx(this.vm, { tx });

    if (result.execResult.exceptionError) {
      console.error('[BrowserVM] Deployment exception:', result.execResult.exceptionError);
      console.error('[BrowserVM] Result:', JSON.stringify({
        gasUsed: result.totalGasSpent?.toString(),
        returnValue: result.execResult.returnValue?.length,
        logs: result.execResult.logs?.length
      }));
      throw new Error(`Deployment failed: ${result.execResult.exceptionError}`);
    }

    this.depositoryAddress = result.createdAddress!;
    console.log(`[BrowserVM] Deployed at: ${this.depositoryAddress.toString()}`);
    console.log(`[BrowserVM] Gas used: ${result.totalGasSpent}`);

    // Verify code exists
    const code = await this.vm.stateManager.getCode(this.depositoryAddress);
    if (code.length === 0) {
      throw new Error('Contract deployment failed - no code at address');
    }
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

  /** Debug: Fund entity reserves */
  async debugFundReserves(entityId: string, tokenId: number, amount: bigint): Promise<void> {
    if (!this.depositoryAddress || !this.depositoryInterface) {
      throw new Error('Depository not deployed');
    }

    // Use ethers Interface for ABI encoding (same as mainnet)
    const callData = this.depositoryInterface.encodeFunctionData('debugFundReserves', [entityId, tokenId, amount]);

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

    if (result.execResult.exceptionError) {
      throw new Error(`debugFundReserves failed: ${result.execResult.exceptionError}`);
    }

    console.log(`[BrowserVM] Funded ${entityId.slice(0, 10)}... with ${amount} of token ${tokenId}`);
  }

  /** Execute R2R transfer */
  async reserveToReserve(from: string, to: string, tokenId: number, amount: bigint): Promise<void> {
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

    if (result.execResult.exceptionError) {
      throw new Error(`reserveToReserve failed: ${result.execResult.exceptionError}`);
    }

    console.log(`[BrowserVM] Transferred ${amount} from ${from.slice(0, 10)}... to ${to.slice(0, 10)}...`);
  }

  /** Get contract address */
  getDepositoryAddress(): string {
    return this.depositoryAddress?.toString() || '0x0';
  }

  /** Prefund account (R2C - Reserve to Collateral) */
  async prefundAccount(entityId: string, counterpartyId: string, tokenId: number, amount: bigint): Promise<void> {
    if (!this.depositoryAddress || !this.depositoryInterface) throw new Error('Depository not deployed');

    // Use ethers Interface for ABI encoding (same as mainnet)
    // Note: prefundAccount(bytes32 counterpartyEntity, uint tokenId, uint amount)
    const callData = this.depositoryInterface.encodeFunctionData('prefundAccount', [counterpartyId, tokenId, amount]);

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
      throw new Error(`prefundAccount failed: ${result.execResult.exceptionError}`);
    }
    console.log(`[BrowserVM] Prefunded ${amount} from ${entityId.slice(0, 10)}... to account with ${counterpartyId.slice(0, 10)}...`);
  }

  /** Get collateral for an account */
  async getCollateral(entityId: string, counterpartyId: string, tokenId: number): Promise<bigint> {
    if (!this.depositoryAddress || !this.depositoryInterface) throw new Error('Depository not deployed');

    // Use ethers Interface for ABI encoding (same as mainnet)
    const callData = this.depositoryInterface.encodeFunctionData('_collateral', [entityId, counterpartyId, tokenId]);

    const result = await this.vm.evm.runCall({
      to: this.depositoryAddress,
      caller: this.deployerAddress,
      data: hexToBytes(callData as `0x${string}`),
      gasLimit: 100000n,
    });

    if (result.execResult.exceptionError) return 0n;
    const returnData = result.execResult.returnValue;
    if (!returnData || returnData.length === 0) return 0n;

    const decoded = this.depositoryInterface.decodeFunctionResult('_collateral', returnData);
    return decoded[0];
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

  /** Process a full batch */
  async processBatch(entityId: string, batch: {
    reserveToReserve?: Array<{toEntity: string, tokenId: number, amount: bigint}>,
    reserveToCollateral?: Array<{counterparty: string, tokenId: number, amount: bigint}>,
    settlements?: Array<{leftEntity: string, rightEntity: string, diffs: any[]}>,
  }): Promise<boolean> {
    if (!this.depositoryAddress) throw new Error('Depository not deployed');

    // For simplicity, execute individual operations
    // In production, encode full Batch struct and call processBatch

    if (batch.reserveToReserve) {
      for (const r2r of batch.reserveToReserve) {
        await this.reserveToReserve(entityId, r2r.toEntity, r2r.tokenId, r2r.amount);
      }
    }

    console.log(`[BrowserVM] Batch processed for ${entityId.slice(0, 10)}...`);
    return true;
  }

  /** Get VM state snapshot (for time machine) */
  async getStateSnapshot(): Promise<{
    accounts: Map<string, {balance: bigint, nonce: bigint}>,
    depositoryState: any
  }> {
    // Snapshot VM state for time travel
    const snapshot = {
      accounts: new Map<string, {balance: bigint, nonce: bigint}>(),
      depositoryState: {
        address: this.depositoryAddress?.toString(),
        // Add more state as needed
      }
    };

    // Get deployer account state
    const deployerAcc = await this.vm.stateManager.getAccount(this.deployerAddress);
    if (deployerAcc) {
      snapshot.accounts.set(this.deployerAddress.toString(), {
        balance: deployerAcc.balance,
        nonce: deployerAcc.nonce
      });
    }

    return snapshot;
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

    if (result.execResult.exceptionError) {
      console.error('[BrowserVM] settle failed:', result.execResult.exceptionError);
      return { success: false, logs: [] };
    }

    // Parse logs
    const logs = this.parseLogs(result.execResult.logs || []);

    const insuranceCount = insuranceRegs.length;
    console.log(`[BrowserVM] Settle completed: ${diffs.length} diffs, ${insuranceCount} insurance regs`);

    return { success: true, logs };
  }

  /** Parse EVM logs into decoded events */
  private parseLogs(logs: any[]): any[] {
    if (!this.depositoryInterface) return [];

    const decoded: any[] = [];
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

  /** Subscribe to all EVM events */
  onAny(callback: (event: EVMEvent) => void): () => void {
    // TODO: Implement event subscription when needed
    console.log('[BrowserVM] onAny stub - event subscription not yet implemented');
    return () => {}; // Return empty unsubscribe function
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

  /** Get EntityProvider contract address */
  getEntityProviderAddress(): string {
    // TODO: Return actual EntityProvider address when deployed
    return '0x0000000000000000000000000000000000000000';
  }
}

// Singleton instance
export const browserVMProvider = new BrowserVMProvider();

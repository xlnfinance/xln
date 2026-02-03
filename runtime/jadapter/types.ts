/**
 * JAdapter Types
 * @license AGPL-3.0
 */

import type { Provider, Signer } from 'ethers';
import type { Account } from '../../jurisdictions/typechain-types/Account';
import type { Depository } from '../../jurisdictions/typechain-types/Depository';
import type { EntityProvider } from '../../jurisdictions/typechain-types/EntityProvider';
import type { DeltaTransformer } from '../../jurisdictions/typechain-types/DeltaTransformer';
import type { JReplica, BrowserVMState } from '../types';

export type JAdapterMode = 'browservm' | 'anvil' | 'rpc';

export interface JAdapterConfig {
  mode: JAdapterMode;
  chainId: number;
  rpcUrl?: string;                    // Required for anvil/rpc
  stateFile?: string;                 // Anvil: --load-state, BrowserVM: import path
  privateKey?: string;                // Signer key (default: hardhat #0)
  fromReplica?: JReplica;             // Sync addresses from existing replica
  browserVMState?: BrowserVMState;    // Import BrowserVM state directly
}

export interface JAdapterAddresses {
  account: string;
  depository: string;
  entityProvider: string;
  deltaTransformer: string;
}

export interface JEvent {
  name: string;
  args: Record<string, unknown>;
  blockNumber: number;
  blockHash: string;
  transactionHash: string;
}

export type JEventCallback = (event: JEvent) => void;
export type SnapshotId = string;

export interface JAdapter {
  readonly mode: JAdapterMode;
  readonly chainId: number;
  readonly provider: Provider;
  readonly signer: Signer;

  // Typechain contracts
  readonly account: Account;
  readonly depository: Depository;
  readonly entityProvider: EntityProvider;
  readonly deltaTransformer: DeltaTransformer;
  readonly addresses: JAdapterAddresses;

  // Lifecycle
  deployStack(): Promise<void>;
  snapshot(): Promise<SnapshotId>;
  revert(snapshotId: SnapshotId): Promise<void>;
  dumpState(): Promise<BrowserVMState | string>;
  loadState(state: BrowserVMState | string): Promise<void>;

  // Events
  on(eventName: string, callback: JEventCallback): () => void;
  onAny(callback: JEventCallback): () => void;
  processBlock(): Promise<JEvent[]>;

  // Reads
  getReserves(entityId: string, tokenId: number): Promise<bigint>;
  getCollateral(entity1: string, entity2: string, tokenId: number): Promise<bigint>;
  getEntityNonce(entityId: string): Promise<bigint>;
  isEntityRegistered(entityId: string): Promise<boolean>;

  // Writes - Core Operations
  processBatch(encodedBatch: string, hankoData: string, nonce: bigint): Promise<JBatchReceipt>;
  settle(
    leftEntity: string,
    rightEntity: string,
    diffs: SettlementDiff[],
    forgiveDebtsInTokenIds?: number[],
    insuranceRegs?: InsuranceReg[],
    sig?: string
  ): Promise<JTxReceipt>;

  // Writes - Entity Management
  registerNumberedEntity(boardHash: string): Promise<{ entityNumber: number; txHash: string }>;
  registerNumberedEntitiesBatch(boardHashes: string[]): Promise<{ entityNumbers: number[]; txHash: string }>;
  getNextEntityNumber(): Promise<number>;

  // Writes - Testing/Debug (may be no-op on mainnet)
  debugFundReserves(entityId: string, tokenId: number, amount: bigint): Promise<JEvent[]>;
  reserveToReserve(from: string, to: string, tokenId: number, amount: bigint): Promise<JEvent[]>;

  // Writes - Deposits (user deposits ERC20 to their entity reserves)
  externalTokenToReserve(
    signerPrivateKey: Uint8Array,
    entityId: string,
    tokenAddress: string,
    amount: bigint
  ): Promise<JEvent[]>;

  // BrowserVM-specific (returns null for RPC mode)
  getBrowserVM(): BrowserVMProvider | null;
  setBlockTimestamp(timestamp: number): void;

  // Cleanup
  close(): Promise<void>;
}

// Settlement diff structure matching Depository contract
export interface SettlementDiff {
  tokenId: number;
  leftDiff: bigint;
  rightDiff: bigint;
  collateralDiff: bigint;
  ondeltaDiff?: bigint;
}

// Insurance registration structure
export interface InsuranceReg {
  insured: string;
  insurer: string;
  tokenId: number;
  limit: bigint;
  expiresAt: bigint;
}

// Receipt for processBatch
export interface JBatchReceipt {
  txHash: string;
  blockNumber: number;
  events: JEvent[];
}

// Receipt for general transactions
export interface JTxReceipt {
  txHash: string;
  blockNumber: number;
}

// Forward declare BrowserVMProvider (avoid circular import)
export interface BrowserVMProvider {
  processBatch(encodedBatch: string, entityProvider: string, hankoData: string, nonce: bigint): Promise<any[]>;
  setBlockTimestamp(timestamp: number): void;
  getDepositoryAddress(): string;
  getEntityProviderAddress(): string;
  getAccountAddress(): string;
  debugFundReserves(entityId: string, tokenId: number, amount: bigint): Promise<any[]>;
  reserveToReserve(from: string, to: string, tokenId: number, amount: bigint): Promise<any[]>;
  getNextEntityNumber(): Promise<number>;
  registerNumberedEntitiesBatch(boardHashes: string[]): Promise<{ entityNumbers: number[]; txHash: string }>;
  serializeState(): Promise<any>;
  restoreState(state: any): Promise<void>;
  onAny(callback: (events: any[]) => void): () => void;
  getCollateral(entityId: string, counterpartyId: string, tokenId: number): Promise<{ collateral: bigint; ondelta: bigint }>;
  getReserves(entityId: string, tokenId: number): Promise<bigint>;
  getEntityNonce(entityId: string): Promise<bigint>;
  signSettlement(
    initiatorEntityId: string,
    counterpartyEntityId: string,
    diffs: SettlementDiff[],
    forgiveDebtsInTokenIds?: number[],
    insuranceRegs?: InsuranceReg[]
  ): Promise<string>;
  settleWithInsurance(
    leftEntity: string,
    rightEntity: string,
    diffs: SettlementDiff[],
    forgiveDebtsInTokenIds?: number[],
    insuranceRegs?: InsuranceReg[],
    sig?: string
  ): Promise<any[]>;
}

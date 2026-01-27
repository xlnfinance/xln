/**
 * EVM Interface - Unified abstraction for BrowserVM and RPC backends
 *
 * Design principle: Expose typed contracts, not wrapper methods.
 * Runtime uses the same API regardless of backend.
 *
 * Usage:
 *   const evm = env.evms.get('simnet');
 *   const reserves = await evm.depository._reserves(entityId, tokenId);
 *   evm.depository.on('AccountSettled', (left, right, ...) => { ... });
 */

import type { Depository } from './typechain/Depository';
import type { ethers } from 'ethers';

/**
 * Contract-like interface for Depository
 * BrowserEVM implements this by wrapping BrowserVMProvider
 * RpcEVM implements this with real ethers.Contract
 */
export interface DepositoryContract {
  // ─── Read Methods (view) ───
  _reserves(entityId: string, tokenId: number): Promise<bigint>;
  _collaterals(accountKey: string, tokenId: number): Promise<{ collateral: bigint; ondelta: bigint }>;
  _accounts(accountKey: string): Promise<{ cooperativeNonce: bigint; disputeHash: string; disputeTimeout: bigint }>;
  entityNonces(address: string): Promise<bigint>;
  accountKey(e1: string, e2: string): Promise<string>;

  // ─── Write Methods (nonpayable) ───
  processBatch(
    encodedBatch: string,
    entityProvider: string,
    hankoData: string,
    nonce: bigint
  ): Promise<{ hash: string; wait: () => Promise<{ blockNumber: number; gasUsed: bigint }> }>;

  settle(
    leftEntity: string,
    rightEntity: string,
    diffs: Array<{ tokenId: number; leftDiff: bigint; rightDiff: bigint; collateralDiff: bigint; ondeltaDiff: bigint }>,
    forgiveDebtsInTokenIds: number[],
    insuranceRegs: Array<{ insured: string; insurer: string; tokenId: number; limit: bigint; expiresAt: bigint }>,
    sig: string
  ): Promise<{ hash: string; wait: () => Promise<any> }>;

  reserveToReserve(
    fromEntity: string,
    toEntity: string,
    tokenId: number,
    amount: bigint
  ): Promise<{ hash: string; wait: () => Promise<any> }>;

  // ─── Events ───
  on(event: 'AccountSettled', listener: (left: string, right: string, tokenId: bigint, ...args: any[]) => void): void;
  on(event: 'ReserveUpdated', listener: (entity: string, tokenId: bigint, newBalance: bigint, ...args: any[]) => void): void;
  on(event: 'HankoBatchProcessed', listener: (entity: string, nonce: bigint, ...args: any[]) => void): void;
  on(event: string, listener: (...args: any[]) => void): void;

  off(event: string, listener: (...args: any[]) => void): void;
  removeAllListeners(event?: string): void;

  // ─── Address ───
  readonly address: string;
}

/**
 * Contract-like interface for EntityProvider
 */
export interface EntityProviderContract {
  // ─── Read Methods ───
  entities(entityId: string): Promise<{ boardHash: string; status: number; activationTime: bigint }>;
  nameToNumber(name: string): Promise<bigint>;
  numberToName(entityNumber: bigint): Promise<string>;
  nextNumber(): Promise<bigint>;

  // ─── Write Methods ───
  registerNumberedEntity(boardHash: string): Promise<{ hash: string; wait: () => Promise<any> }>;
  registerNumberedEntitiesBatch(boardHashes: string[]): Promise<{ hash: string; wait: () => Promise<any> }>;
  assignName(name: string, entityNumber: bigint): Promise<{ hash: string; wait: () => Promise<any> }>;

  // ─── Events ───
  on(event: 'EntityRegistered', listener: (entityId: string, entityNumber: bigint, ...args: any[]) => void): void;
  on(event: string, listener: (...args: any[]) => void): void;

  off(event: string, listener: (...args: any[]) => void): void;
  removeAllListeners(event?: string): void;

  // ─── Address ───
  readonly address: string;
}

/**
 * EVM - Unified interface for jurisdiction machine
 *
 * Can be BrowserVM (in-memory, for tests) or RPC (real chain).
 * Runtime code is identical for both.
 */
export interface EVM {
  /** EVM type identifier */
  readonly type: 'browser' | 'rpc';

  /** Human-readable name (e.g., 'simnet', 'base-sepolia', 'base-mainnet') */
  readonly name: string;

  /** Chain ID */
  readonly chainId: number;

  /** Typed Depository contract */
  readonly depository: DepositoryContract;

  /** Typed EntityProvider contract */
  readonly entityProvider: EntityProviderContract;

  /** Current block number */
  getBlockNumber(): Promise<number>;

  /** Initialize (deploy contracts for browser, connect for RPC) */
  init(): Promise<void>;

  // ─── Test-only methods (optional) ───

  /** Debug: Fund entity reserves (BrowserVM only) */
  debugFundReserves?(entityId: string, tokenId: number, amount: bigint): Promise<void>;

  /** Time travel to state root (BrowserVM only) */
  timeTravel?(stateRoot: Uint8Array): Promise<void>;

  /** Capture current state root (BrowserVM only) */
  captureStateRoot?(): Promise<Uint8Array>;

  /** Serialize full state (for snapshots) */
  serialize?(): Promise<any>;

  /** Restore from serialized state */
  restore?(state: any): Promise<void>;
}

/**
 * Configuration for creating an EVM instance
 */
export type EVMConfig =
  | {
      type: 'browser';
      name: string;
      // Auto-deploys contracts, prefunds test tokens
    }
  | {
      type: 'rpc';
      name: string;
      rpcUrl: string;
      chainId: number;
      depositoryAddress: string;
      entityProviderAddress: string;
      signer: ethers.Signer;
    };

/**
 * Create an EVM instance
 */
export async function createEVM(config: EVMConfig): Promise<EVM> {
  if (config.type === 'browser') {
    const { BrowserEVMAdapter } = await import('./evms/browser-evm-adapter');
    return BrowserEVMAdapter.create(config.name);
  } else {
    const { RpcEVMAdapter } = await import('./evms/rpc-evm-adapter');
    return RpcEVMAdapter.connect(config);
  }
}

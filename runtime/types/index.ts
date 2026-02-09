/**
 * XLN Type Definitions - Barrel re-export
 *
 * All types split into domain modules:
 *   core.ts         — Result, ConsensusConfig, Hanko*, HashToSign
 *   account.ts      — AccountMachine, AccountFrame, AccountInput, AccountTx, Delta
 *   entity.ts       — EntityState, EntityReplica, EntityInput, EntityTx, ProposedEntityFrame
 *   jurisdiction.ts — JReplica, JTx, JurisdictionEvent, JBlockObservation
 *   env.ts          — Env, EnvSnapshot, RuntimeInput, RuntimeTx, logging
 *   settlement.ts   — SettlementWorkspace, SettlementDiff, HtlcLock, SwapOffer, HtlcRoute
 *   governance.ts   — Proposal, ProposalAction, VoteData
 */

// Core
export type { Result } from './core';
export { Ok, Err, isOk, isErr } from './core';
export type { ConsensusConfig, JurisdictionConfig } from './core';
export type { HankoBytes, HankoClaim, HankoString, HashType, HashToSign } from './core';
export { type EntityType } from './core';

// Account
export type {
  Delta,
  DerivedDelta,
  ProposalState,
  AccountMachine,
  AccountFrame,
  AccountInputProposal,
  AccountInputAck,
  AccountInputSettlement,
  AccountInput,
  AccountTx,
  AccountEvent,
} from './account';

// Entity
export type {
  EntityState,
  EntityTx,
  EntityInput,
  RoutedEntityInput,
  EntityOutput,
  ProposedEntityFrame,
  EntityReplica,
} from './entity';

// Jurisdiction
export type {
  JurisdictionEvent,
  JurisdictionEventData,
  JBlockObservation,
  JBlockFinalized,
  JInput,
  JTx,
  JReplica,
} from './jurisdiction';
export { JBLOCK_LIVENESS_INTERVAL } from './jurisdiction';

// Env / Runtime
export type {
  LogLevel,
  LogCategory,
  FrameLogEntry,
  BrowserVMState,
  RuntimeInput,
  RuntimeTx,
  Env,
  EnvSnapshot,
  RuntimeSnapshot,
} from './env';

// Settlement
export type {
  SettlementDiff,
  SettlementWorkspace,
  HtlcLock,
  SwapOffer,
  HtlcRoute,
  SwapBookEntry,
  LockBookEntry,
} from './settlement';
export { createSettlementDiff } from './settlement';

// Governance
export type { Proposal, ProposalAction, VoteData } from './governance';

// ═══════════════════════════════════════════════════════════════
// PROFILE & NAME RESOLUTION TYPES (used by name-resolution.ts)
// ═══════════════════════════════════════════════════════════════

/**
 * Entity profile stored in gossip layer
 */
export interface EntityProfile {
  entityId: string;
  name: string; // Human-readable name e.g., "Alice Corp", "Bob's DAO"
  avatar?: string; // Custom avatar URL (fallback to generated identicon)
  bio?: string; // Short description
  website?: string; // Optional website URL
  lastUpdated: number; // Timestamp of last update
  hankoSignature: string; // Signature proving entity ownership
}

/**
 * Profile update transaction data
 */
export interface ProfileUpdateTx {
  name?: string;
  avatar?: string;
  bio?: string;
  website?: string;
}

/**
 * Name index for autocomplete
 */
export interface NameIndex {
  [name: string]: string; // name -> entityId mapping
}

/**
 * Autocomplete search result
 */
export interface NameSearchResult {
  entityId: string;
  name: string;
  avatar: string;
  relevance: number; // Search relevance score 0-1
}

// ═══════════════════════════════════════════════════════════════
// XLNOMY TYPES (Topology/Jurisdiction system - legacy)
// ═══════════════════════════════════════════════════════════════

export type TopologyType = 'star' | 'mesh' | 'tiered' | 'correspondent' | 'hybrid';

export interface TopologyLayer {
  name: string;
  yPosition: number;
  entityCount: number;
  xzSpacing: number;
  color: string;
  size: number;
  emissiveIntensity: number;
  initialReserves: bigint;
  canMintMoney: boolean;
}

export interface ConnectionRules {
  allowedPairs: Array<{ from: string; to: string }>;
  allowDirectInterbank: boolean;
  requireHubRouting: boolean;
  maxHops: number;
  defaultCreditLimits: Map<string, bigint>;
}

export interface XlnomyTopology {
  type: TopologyType;
  layers: TopologyLayer[];
  rules: ConnectionRules;
  crisisThreshold: number;
  crisisMode: 'star' | 'mesh';
}

export interface Xlnomy {
  name: string;
  evmType: 'browservm' | 'reth' | 'erigon' | 'monad';
  blockTimeMs: number;
  topology?: XlnomyTopology;
  jMachine: {
    position: { x: number; y: number; z: number };
    capacity: number;
    jHeight: number;
    mempool: any[];
  };
  contracts: {
    entityProviderAddress: string;
    depositoryAddress: string;
    deltaTransformerAddress?: string;
  };
  evm: JurisdictionEVM;
  entities: string[];
  created: number;
  version: string;
}

export interface JurisdictionEVM {
  type: 'browservm' | 'reth' | 'erigon' | 'monad';
  deployContract(bytecode: string, args?: any[]): Promise<string>;
  call(to: string, data: string, from?: string): Promise<string>;
  send(to: string, data: string, value?: bigint): Promise<string>;
  getBlock(): Promise<number>;
  getBalance(address: string): Promise<bigint>;
  serialize(): Promise<XlnomySnapshot>;
  getEntityProviderAddress(): string;
  getDepositoryAddress(): string;
  captureStateRoot?(): Promise<Uint8Array>;
  timeTravel?(stateRoot: Uint8Array): Promise<void>;
  getBlockNumber?(): bigint;
}

export interface XlnomySnapshot {
  name: string;
  version: string;
  created: number;
  evmType: 'browservm' | 'reth' | 'erigon' | 'monad';
  blockTimeMs: number;
  jMachine: {
    position: { x: number; y: number; z: number };
    capacity: number;
    jHeight: number;
  };
  contracts: {
    entityProviderAddress: string;
    depositoryAddress: string;
    deltaTransformerAddress?: string;
  };
  evmState: {
    rpcUrl?: string;
    vmState?: any;
  };
  entities: string[];
  runtimeState?: {
    replicas: any;
    history: import('./env').EnvSnapshot[];
  };
}

// Dead types preserved for backwards compat (never imported by consensus)
// AccountDelta, AssetBalance, AccountSnapshot, AccountTxInput,
// HankoVerificationResult, HankoMergeResult, HankoContext, ENC
// — all removed. They were never imported anywhere.

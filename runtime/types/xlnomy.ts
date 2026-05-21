import type { EnvSnapshot } from '../types';

// === XLNOMY (JURISDICTION) SYSTEM ===

/**
 * Economic Topology Types
 * Defines how central bank, commercial banks, and customers interact
 */
export type TopologyType = 'star' | 'mesh' | 'tiered' | 'correspondent' | 'hybrid';

export interface TopologyLayer {
  name: string;              // "Federal Reserve", "Tier 1 Banks", "Customers"
  yPosition: number;         // Vertical position in 3D space
  entityCount: number;       // How many entities in this layer
  xzSpacing: number;         // Horizontal spread between entities

  // Visual properties
  color: string;             // Hex color (#FFD700 for Fed)
  size: number;              // Size multiplier (10.0 for Fed, 1.0 for banks, 0.5 for customers)
  emissiveIntensity: number; // Glow intensity

  // Economic properties
  initialReserves: bigint;   // Starting balance
  canMintMoney: boolean;     // Only central bank = true
}

export interface ConnectionRules {
  // Who can create accounts with whom
  allowedPairs: Array<{ from: string; to: string }>;

  // Routing
  allowDirectInterbank: boolean;  // Banks can trade P2P?
  requireHubRouting: boolean;     // All payments through central hub?
  maxHops: number;                // Max routing path length

  // Credit limits (per layer pair)
  defaultCreditLimits: Map<string, bigint>;
}

export interface XlnomyTopology {
  type: TopologyType;
  layers: TopologyLayer[];
  rules: ConnectionRules;

  // Crisis management (for HYBRID)
  crisisThreshold: number;        // 0.20 = reserves < 20% deposits triggers crisis
  crisisMode: 'star' | 'mesh';    // Morph to this during crisis
}

/**
 * Xlnomy = J-Machine (court/jurisdiction) + Entities + Contracts
 * Self-contained economy where J-Machine IS the jurisdiction
 */
export interface Xlnomy {
  name: string; // e.g., "Simnet", "GameEconomy"
  evmType: 'browservm' | 'reth' | 'erigon' | 'monad';
  blockTimeMs: number; // Block time in milliseconds (1000ms default)

  // NEW: Economic topology configuration
  topology?: XlnomyTopology;

  // J-Machine = Jurisdiction machine (court that entities anchor to)
  jMachine: {
    position: { x: number; y: number; z: number }; // Visual position (0, 100, 0)
    capacity: number; // Broadcast threshold (default: 3)
    jHeight: number; // Current block height in jurisdiction
    mempool: unknown[]; // Pending transactions in J-Machine queue
  };

  // Deployed contracts
  contracts: {
    entityProviderAddress: string;
    depositoryAddress: string;
    deltaTransformerAddress?: string;
  };

  // EVM instance (BrowserVM in-browser, or Reth/Erigon RPC)
  evm: JurisdictionEVM;

  // Entity registry
  entities: string[]; // Entity IDs registered in this Xlnomy

  // Metadata
  created: number; // Timestamp
  version: string; // e.g., "1.0.0"
}

/**
 * Abstract jurisdiction EVM (BrowserVM or RPC to Reth/Erigon/Monad)
 * Allows swapping execution layer without changing runtime code
 */
export interface JurisdictionEVM {
  type: 'browservm' | 'reth' | 'erigon' | 'monad';

  // Contract deployment
  deployContract(bytecode: string, args?: unknown[]): Promise<string>;

  // Contract calls
  call(to: string, data: string, from?: string): Promise<string>;
  send(to: string, data: string, value?: bigint): Promise<string>;

  // State queries
  getBlock(): Promise<number>;
  getBalance(address: string): Promise<bigint>;

  // Serialization for persistence
  serialize(): Promise<XlnomySnapshot>;

  // Address getters
  getEntityProviderAddress(): string;
  getDepositoryAddress(): string;

  // Time travel (optional - only BrowserVM supports this)
  captureStateRoot?(): Promise<Uint8Array>;
  timeTravel?(stateRoot: Uint8Array): Promise<void>;
  getBlockNumber?(): bigint;
}

/**
 * Persisted Xlnomy snapshot (stored in Level/IndexedDB)
 * Can be exported as JSON and shared/imported
 */
export interface XlnomySnapshot {
  name: string;
  version: string;
  created: number;
  evmType: 'browservm' | 'reth' | 'erigon' | 'monad';
  blockTimeMs: number;

  // J-Machine config
  jMachine: {
    position: { x: number; y: number; z: number };
    capacity: number;
    jHeight: number;
  };

  // Deployed contracts
  contracts: {
    entityProviderAddress: string;
    depositoryAddress: string;
    deltaTransformerAddress?: string;
  };

  // EVM-specific state
  evmState: {
    rpcUrl?: string; // If RPC EVM (Reth/Erigon/Monad)
    vmState?: unknown; // If BrowserVM - serialized @ethereumjs/vm state
  };

  // Entity registry
  entities: string[];

  // Runtime state (replicas + history)
  runtimeState?: {
    replicas: unknown; // Serialized Map<string, EntityReplica>
    history: EnvSnapshot[];
  };
}

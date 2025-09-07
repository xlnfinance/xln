// Core XLN Types for Svelte Migration
export interface XLNEnvironment {
  replicas: Map<string, EntityReplica>;
  history: Snapshot[];
  height: number;
  serverInput: ServerInput;
  serverOutputs: EntityOutput[];
}

export interface EntityReplica {
  entityId: string;
  signerId: string;
  state: EntityState;
  mempool: EntityTx[];
  isProposer: boolean;
  proposal?: Frame;
  lockedFrame?: Frame;
  blockHeight: number;
}

export interface AssetBalance {
  symbol: string;
  amount: bigint;
  decimals: number;
  contractAddress?: string;
}

export interface EntityState {
  height: number;
  timestamp: number;
  nonces: Map<string, number>;
  messages: string[];
  proposals: Map<string, Proposal>;
  config: EntityConfig;
  reserves: Map<string, AssetBalance>;
}

export interface EntityConfig {
  validators: string[];
  weights: number[];
  threshold: number;
  shares: Record<string, bigint>;
  mode: string;
  jurisdiction?: JurisdictionConfig;
}

export interface JurisdictionConfig {
  name: string;
  address: string;
  chainId: number;
  entityProviderAddress: string;
  depositoryAddress: string;
}

export interface Proposal {
  id: string;
  proposer: string;
  action: ProposalAction;
  votes: Map<string, VoteData>;
  status: 'pending' | 'executed' | 'failed';
  height: number;
}

export interface ProposalAction {
  type: string;
  data: {
    message: string;
  };
}

export interface VoteData {
  choice: 'yes' | 'no' | 'abstain';
  comment?: string;
}

export interface EntityTx {
  type: 'chat' | 'propose' | 'vote';
  data: any;
}

export interface Frame {
  id: string;
  height: number;
  timestamp: number;
  hash: string;
  txs: EntityTx[];
  signatures: Map<string, string>;
}

export interface ServerInput {
  serverTxs: ServerTx[];
  entityInputs: EntityInput[];
}

export interface ServerTx {
  type: string;
  entityId: string;
  signerId: string;
  data: any;
}

export interface EntityInput {
  entityId: string;
  signerId: string;
  entityTxs: EntityTx[];
  destinations?: string[];
  precommits?: Map<string, string>;
  proposedFrame?: Frame;
}

export interface EntityOutput {
  entityId: string;
  signerId: string;
  entityTxs: EntityTx[];
  destinations: string[];
  precommits?: Map<string, string>;
  proposedFrame?: Frame;
}

export interface Snapshot {
  timestamp: number;
  height: number;
  replicas: Map<string, EntityReplica>;
  serverInput: ServerInput;
  serverOutputs: EntityOutput[];
  description: string;
}

// UI-specific types
export interface Tab {
  id: string;
  title: string;
  jurisdiction: string;
  signer: string;
  entityId: string;
  isActive: boolean;
}

export interface ComponentState {
  [componentId: string]: boolean; // expanded/collapsed state
}

export interface Settings {
  theme: 'dark' | 'light';
  dropdownMode: 'signer-first' | 'entity-first';
  serverDelay: number;
  componentStates: ComponentState;
}

export interface TimeState {
  currentTimeIndex: number;
  maxTimeIndex: number;
  isLive: boolean;
}

// Form types
export interface EntityFormData {
  entityType: 'lazy' | 'numbered' | 'named';
  entityName: string;
  jurisdiction: string;
  validators: ValidatorData[];
  threshold: number;
}

export interface ValidatorData {
  name: string;
  weight: number;
}

// Jurisdiction types
export interface JurisdictionStatus {
  port: number;
  name: string;
  connected: boolean;
  chainId?: number;
  blockNumber?: number;
  contractAddress?: string;
  nextEntityNumber?: number;
  entities: EntityInfo[];
  lastUpdate: Date;
}

export interface EntityInfo {
  id: string;
  name: string;
  type: 'lazy' | 'numbered' | 'named';
  boardHash: string;
}

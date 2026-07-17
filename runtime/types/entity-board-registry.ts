export type CertifiedBoardSource =
  | 'FoundationBootstrapped'
  | 'EntityRegistered'
  | 'BoardActivated';

/**
 * The only board authority committed by Entity consensus. The registry root is
 * scoped to the exact chain + Depository + EntityProvider stack by every key.
 * Patricia nodes are immutable runtime/storage objects and are deliberately not
 * duplicated inside each Entity state.
 */
export type CertifiedBoardRegistryState = {
  stackKey: string;
  boardRegistryRoot: string;
  finalizedJHeight: number;
  finalizedJBlockHash: string;
  eventHistoryRoot: string;
};

export type CertifiedBoardRecord = {
  stackKey: string;
  entityId: string;
  boardHash: string;
  /** Monotonic activation epoch; registrations start at zero. */
  boardEpoch: number;
  previousBoardHash: string;
  /** Exclusive Unix-second validity boundary; zero means no previous board. */
  previousBoardValidUntil: number;
  activatedAtJHeight: number;
  logIndex: number;
  blockHash: string;
  transactionHash: string;
  source: CertifiedBoardSource;
};

export type CertifiedBoardLeafNode = {
  version: 1;
  type: 'leaf';
  key: string;
  record: CertifiedBoardRecord;
};

export type CertifiedBoardBranchNode = {
  version: 1;
  type: 'branch';
  /** Most-significant-bit index in [0, 255]. Child branch bits strictly rise. */
  bit: number;
  left: string;
  right: string;
};

export type CertifiedBoardPatriciaNode = CertifiedBoardLeafNode | CertifiedBoardBranchNode;
export type CertifiedBoardNodeStore = Map<string, CertifiedBoardPatriciaNode>;

/** Root-to-leaf proof. A divergent terminal leaf is an authenticated absence. */
export type CertifiedBoardProof = {
  version: 1;
  stackKey: string;
  entityId: string;
  nodes: CertifiedBoardPatriciaNode[];
};

/**
 * Source authority bound into an output. The receiver compares this complete
 * record with its own current Entity-certified registry record. Global J-head
 * movement cannot stale an unchanged board, while any rotation does.
 */
export type CertifiedBoardAuthorityBinding = {
  version: 4;
  stackKey: string;
  record: CertifiedBoardRecord;
};

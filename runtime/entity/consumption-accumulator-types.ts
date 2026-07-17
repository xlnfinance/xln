export type ConsumptionAccumulatorState = Readonly<{
  version: 2;
  root: string;
  /** Number of source→target relationship frontiers, never output count. */
  count: bigint;
}>;

export type ConsumptionQuarantineEvidence = Readonly<{
  sequence: bigint;
  conflictingSemanticHash: string;
  conflictingOutputHash: string;
  conflictingOutputHanko: string;
}>;

export type ConsumptionFrontierValue = Readonly<{
  version: 1;
  lastContiguousSeq: bigint;
  lastSemanticHash: string;
  /** Number of contiguous outputs applied for this lifetime relationship. */
  count: bigint;
  /** Exact accepted certificate evidence retained for current-sequence equivocation. */
  lastOutputHash: string;
  lastOutputHanko: string;
  quarantine?: ConsumptionQuarantineEvidence;
}>;

export type ConsumptionLeafNode = Readonly<{
  version: 2;
  type: 'leaf';
  key: string;
  value: ConsumptionFrontierValue;
}>;

export type ConsumptionBranchNode = Readonly<{
  version: 2;
  type: 'branch';
  bit: number;
  left: string;
  right: string;
}>;

export type ConsumptionNode = ConsumptionLeafNode | ConsumptionBranchNode;
export type ConsumptionNodeStore = ReadonlyMap<string, ConsumptionNode>;
export type ConsumptionNodeEntry = Readonly<{ hash: string; node: ConsumptionNode }>;
export type ConsumptionProof = Readonly<{ version: 2; nodes: readonly ConsumptionNode[] }>;

/** Stable semantic identity; frame/board certificates are deliberately outside it. */
export type ConsumptionOutputIdentity = Readonly<{
  targetEntityId: string;
  sourceEntityId: string;
  lane: 'generic' | 'account-frame' | 'account-ack' | 'account-dispute' | 'account-settlement';
  sequence: number | bigint;
  semanticHash: string;
  outputHash: string;
  outputHanko: string;
}>;

export type ConsumptionProofResult =
  | Readonly<{ status: 'member'; value: ConsumptionFrontierValue }>
  | Readonly<{ status: 'absent'; terminalKey?: string }>;

export type ConsumptionApplyStatus =
  | 'inserted'
  | 'advanced'
  | 'idempotent'
  | 'stale'
  | 'gap'
  | 'quarantined';

export type ConsumptionApplyResult = Readonly<{
  status: ConsumptionApplyStatus;
  state: ConsumptionAccumulatorState;
  newNodes: readonly ConsumptionNodeEntry[];
  /** Prior-root path nodes no longer reachable from the new root. */
  replacedNodeHashes: readonly string[];
}>;

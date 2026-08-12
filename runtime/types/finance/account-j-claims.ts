export type AccountJClaimSide = 'left' | 'right';

export type AccountJClaimAccumulatorState = Readonly<{
  version: 1;
  root: string;
  count: bigint;
}>;

export type AccountJClaimDomain = Readonly<{
  chainId: number;
  depositoryAddress: string;
  leftEntity: string;
  rightEntity: string;
}>;

export type AccountJClaimRecord = Readonly<{
  version: 1;
  accountKey: string;
  side: AccountJClaimSide;
  jHeight: number;
  jBlockHash: string;
  eventsHash: string;
}>;

export type AccountJClaimLeafNode = Readonly<{
  version: 1;
  type: 'leaf';
  key: string;
  record: AccountJClaimRecord;
}>;

export type AccountJClaimBranchNode = Readonly<{
  version: 1;
  type: 'branch';
  bit: number;
  left: string;
  right: string;
}>;

export type AccountJClaimNode = AccountJClaimLeafNode | AccountJClaimBranchNode;
export type AccountJClaimNodeStore = Pick<ReadonlyMap<string, AccountJClaimNode>, 'get'>;
export type AccountJClaimNodeEntry = Readonly<{ hash: string; node: AccountJClaimNode }>;
export type AccountJClaimProof = Readonly<{ version: 1; nodes: readonly AccountJClaimNode[] }>;

export type AccountJClaimProofResult =
  | Readonly<{ status: 'member'; record: AccountJClaimRecord }>
  | Readonly<{ status: 'absent'; terminalKey?: string }>;

export type AccountJClaimMutationResult = Readonly<{
  status: 'inserted' | 'idempotent' | 'deleted';
  state: AccountJClaimAccumulatorState;
  newNodes: readonly AccountJClaimNodeEntry[];
  replacedNodeHashes: readonly string[];
}>;

export type AccountJClaimNodeChanges = Readonly<{
  newNodes: readonly AccountJClaimNodeEntry[];
  replacedNodeHashes: readonly string[];
}>;

export type AccountJClaimPruneResult = AccountJClaimNodeChanges & Readonly<{
  state: AccountJClaimAccumulatorState;
  removed: readonly AccountJClaimRecord[];
  retained: readonly AccountJClaimRecord[];
}>;

export type FrozenFileBaseline = {
  path: string;
  mode: '100644' | '100755';
  contentHash: string;
  leafHash: string;
  frozenAtRelease: string;
  reason: string;
};

export type FrozenApproval = {
  path: string;
  oldContentHash: string;
  newContentHash: string;
  oldLeafHash: string;
  newLeafHash: string;
  release: string;
  approvedAt: string;
  comment: string;
};

export type FrozenCoreManifest = {
  schemaVersion: 1;
  algorithm: 'sha256';
  rootHash: string;
  files: FrozenFileBaseline[];
  approvals: FrozenApproval[];
};

export type FrozenTreeNode = {
  kind: 'directory' | 'file';
  name: string;
  path: string;
  hash: string;
  children?: FrozenTreeNode[];
};

export type FrozenFileState = FrozenFileBaseline & {
  expectedContentHash: string;
  expectedLeafHash: string;
  status: 'UNCHANGED' | 'APPROVED CHANGE' | 'MODIFIED';
  approvalComment: string | null;
  mutableDependencies: string[];
};

export type FrozenCoreSnapshot = {
  schemaVersion: 1;
  algorithm: 'sha256';
  status: 'UNCHANGED' | 'APPROVED CHANGE';
  rootHash: string;
  expectedRootHash: string;
  files: FrozenFileState[];
  tree: FrozenTreeNode;
  mutableDependencies: Array<{ source: string; dependency: string }>;
};

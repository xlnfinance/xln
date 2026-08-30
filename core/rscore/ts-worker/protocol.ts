import type {
  AccountPeerInput,
  AccountReplica,
  AccountTx,
} from '../../types/account';
import type {
  HandleAccountInputResult,
  ProposeAccountFrameResult,
} from '../../account/consensus/types';
import type { JReplica } from '../../types/jurisdiction-runtime';
import type { AccountJClaimNode } from '../../types/finance/account-j-claims';
import type { PersistentRadixNodeCommitment } from '../../protocol/state/persistent-radix-value-map';
import type { OpCounterSnapshot } from '../../support/performance/op-counters';

export type TsAccountWorkerOptions = Readonly<{
  ownerEntityId: string;
  workerCount: number;
  /** Complete 4096-entry logical-shard -> physical-worker assignment. */
  logicalShardToWorker?: readonly number[];
  accounts: ReadonlyMap<string, AccountReplica>;
  jReplicas?: ReadonlyMap<string, JReplica>;
  jClaimNodes?: ReadonlyMap<string, AccountJClaimNode>;
  /** Deterministic board authority known at worker startup, keyed by Entity id. */
  settlementBoardAuthorities?: ReadonlyMap<string, string>;
}>;

export type TsApplyAccountInputsRequest = Readonly<{
  frameId: string;
  expectedAccountsRoot: string;
  entityTimestamp: number;
  finalizedJHeight: number;
  inputs: readonly Readonly<{
    accountId: string;
    input: AccountPeerInput;
    /** Canonical Entity-created shell for an inbound Account genesis. */
    initialAccount?: Record<string, unknown>;
  }>[];
}>;

export type TsProposeAccountFramesRequest = Readonly<{
  frameId: string;
  timestamp: number;
  jHeight: number;
  txs: readonly Readonly<{
    accountId: string;
    txs: readonly AccountTx[];
  }>[];
  proposalAccountIds: readonly string[];
}>;

export type TsAccountWorkerEffect =
  | Readonly<{
      phase: 'inbound';
      order: number;
      accountId: string;
      result: HandleAccountInputResult;
    }>
  | Readonly<{
      phase: 'outbound-enqueue';
      order: number;
      accountId: string;
      result: HandleAccountInputResult;
    }>
  | Readonly<{
      phase: 'outbound-proposal';
      order: number;
      accountId: string;
      result: ProposeAccountFrameResult;
    }>;

export type TsAccountWorkerSubroot = Readonly<{
  shardId: number;
  node: PersistentRadixNodeCommitment | null;
}>;

/** Final touched Account values for one completed inbound→outbound Entity stage. */
export type TsAccountWorkerPostAccount = Readonly<{
  accountId: string;
  account: Record<string, unknown>;
  entityAccountLeaf: string;
}>;

export type TsAccountWorkerPhaseMetrics = Readonly<{
  workerIndex: number;
  operations: number;
  elapsedUs: number;
  heapUsedBytes: number;
  requestBytes: number;
  responseBytes: number;
  /** Coordinator-side IPC telemetry for this worker's round trip. */
  encodeMs: number;
  decodeMs: number;
  roundTripMs: number;
  /** Worker busy time; wait is queue/IPC idle inside the round trip. */
  workMs: number;
  waitMs: number;
  transitionMs: number;
  proposalMs: number;
  rootMs: number;
  materializeMs: number;
  workerEncodeMs: number;
  threadCpuUserMs: number;
  threadCpuSystemMs: number;
  /** Ordered transition rows executed in each touched logical shard. */
  shardRows: readonly (readonly [shardId: number, rows: number])[];
  operationsProfile: OpCounterSnapshot;
}>;

export type TsAccountWorkerBatchResult = Readonly<{
  accountsRoot: string;
  effects: readonly TsAccountWorkerEffect[];
  changedSubroots: readonly TsAccountWorkerSubroot[];
  /** Outbound only; inbound never copies Account documents back to the coordinator. */
  postAccounts?: readonly TsAccountWorkerPostAccount[];
  workers: readonly TsAccountWorkerPhaseMetrics[];
  ipc: Readonly<{
    requestBytes: number;
    responseBytes: number;
  }>;
  /** Coordinator-side phase cost split, measured — never extrapolated. */
  timings: Readonly<{
    /** Msgpack encode of outbound request payloads. */
    encodeMs: number;
    /** Msgpack decode of inbound worker responses. */
    decodeMs: number;
    /** Radix fold + ordinal restore + aggregate of worker results. */
    foldMs: number;
    /** Coordinator wall time to encode and post every worker request. */
    dispatchMs: number;
    /** Wall time from final post until all required workers responded. */
    joinMs: number;
  }>;
}>;

export type TsAccountWorkerInitialization = Readonly<{
  accounts: number;
  logicalShards: number;
  workers: number;
  accountsRoot: string;
  requestBytes: number;
  responseBytes: number;
}>;

export type TsAccountWorkerInitPayload = Readonly<{
  workerIndex: number;
  workerCount: number;
  ownedShardIds: readonly number[];
  ownerEntityId: string;
  accounts: readonly (readonly [accountId: string, account: Record<string, unknown>])[];
  jReplicas: readonly (readonly [string, JReplica])[];
  jClaimNodes: readonly (readonly [string, AccountJClaimNode])[];
  settlementBoardAuthorities: readonly (readonly [string, string])[];
}>;

export type TsAccountWorkerInboundPayload = Readonly<{
  phase: 'inbound';
  frameId: string;
  restorePrevious: boolean;
  entityTimestamp: number;
  finalizedJHeight: number;
  inputs: readonly Readonly<{
    order: number;
    accountId: string;
    input: AccountPeerInput;
    initialAccount?: Record<string, unknown>;
  }>[];
}>;

export type TsAccountWorkerOutboundPayload = Readonly<{
  phase: 'outbound';
  frameId: string;
  restorePrevious: boolean;
  timestamp: number;
  jHeight: number;
  txs: readonly Readonly<{
    order: number;
    accountId: string;
    txs: readonly AccountTx[];
  }>[];
  proposals: readonly Readonly<{
    order: number;
    accountId: string;
  }>[];
}>;

export type TsAccountWorkerPhasePayload =
  | TsAccountWorkerInboundPayload
  | TsAccountWorkerOutboundPayload;

export type TsAccountWorkerPhaseResult = Readonly<{
  workerIndex: number;
  effects: readonly TsAccountWorkerEffect[];
  subroots: readonly TsAccountWorkerSubroot[];
  postAccounts?: readonly TsAccountWorkerPostAccount[];
  operations: number;
  shardRows: readonly (readonly [shardId: number, rows: number])[];
  operationsProfile: OpCounterSnapshot;
  elapsedUs: number;
  heapUsedBytes: number;
  timings: Readonly<{
    transitionUs: number;
    proposalUs: number;
    rootUs: number;
    materializeUs: number;
  }>;
  threadCpuUserUs: number;
  threadCpuSystemUs: number;
}>;

export type TsAccountWorkerInitResult = Readonly<{
  workerIndex: number;
  accountCount: number;
  subroots: readonly TsAccountWorkerSubroot[];
  heapUsedBytes: number;
}>;

export type TsAccountWorkerRequestEnvelope = Readonly<{
  requestId: number;
  kind: 'init' | 'phase';
  payload: ArrayBuffer;
}>;

export type TsAccountWorkerResponseEnvelope =
  | Readonly<{
      requestId: number;
      kind: 'result';
      payload: ArrayBuffer;
      encodeUs: number;
    }>
  | Readonly<{
      requestId: number;
      kind: 'fatal';
      error: string;
      stack?: string;
    }>;

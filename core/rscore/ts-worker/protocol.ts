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
  entityTimestamp: number;
  finalizedJHeight: number;
  inputs: readonly Readonly<{
    accountId: string;
    input: AccountPeerInput;
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
  checkpointDue: boolean;
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

/** Portable dirty Account document. Present only on an explicitly due checkpoint. */
type TsAccountWorkerCheckpointAccountChange = Readonly<{
  accountId: string;
  account: Record<string, unknown>;
}>;

export type TsAccountWorkerCheckpointChanges = Readonly<{
  accounts: readonly TsAccountWorkerCheckpointAccountChange[];
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
  checkpointMs: number;
  workerEncodeMs: number;
  threadCpuUserMs: number;
  threadCpuSystemMs: number;
}>;

export type TsAccountWorkerBatchResult = Readonly<{
  accountsRoot: string;
  effects: readonly TsAccountWorkerEffect[];
  changedSubroots: readonly TsAccountWorkerSubroot[];
  checkpointChanges?: TsAccountWorkerCheckpointChanges;
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
  entityTimestamp: number;
  finalizedJHeight: number;
  inputs: readonly Readonly<{
    order: number;
    accountId: string;
    input: AccountPeerInput;
  }>[];
}>;

export type TsAccountWorkerOutboundPayload = Readonly<{
  phase: 'outbound';
  frameId: string;
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
  checkpointDue: boolean;
}>;

export type TsAccountWorkerPhasePayload =
  | TsAccountWorkerInboundPayload
  | TsAccountWorkerOutboundPayload;

export type TsAccountWorkerPhaseResult = Readonly<{
  workerIndex: number;
  effects: readonly TsAccountWorkerEffect[];
  subroots: readonly TsAccountWorkerSubroot[];
  checkpointChanges?: TsAccountWorkerCheckpointChanges;
  operations: number;
  elapsedUs: number;
  heapUsedBytes: number;
  timings: Readonly<{
    transitionUs: number;
    proposalUs: number;
    rootUs: number;
    checkpointUs: number;
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

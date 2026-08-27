import type { RuntimeActivityEvent, RuntimeActivityFilters } from '../../storage/views/activity-types';
import type { PersistedAccountSwapHistoryPage } from '../../storage/queries/history';
import type { CrossJurisdictionSwapRoute } from '../../types/cross-jurisdiction';
import type { RuntimeInput } from '../../runtime/types';
import type { XlnProtocolVersion } from '../../protocol/version';
import type { SettlementEvidenceRequest } from './control/settlement-evidence';
import type {
  NumberedRegistrationCommand,
  NumberedRegistrationCommandResult,
} from '../../runtime/registration/numbered-registration-driver';

export type {
  NumberedRegistrationCommand,
  NumberedRegistrationCommandResult,
} from '../../runtime/registration/numbered-registration-driver';

type RuntimeAdapterMode = 'embedded' | 'remote';
export type RuntimeAdapterStatus = 'connected' | 'connecting' | 'disconnected' | 'error';
export type RuntimeAdapterAuthLevel = 'inspect' | 'admin';
export type RuntimeAdapterAuthRole = RuntimeAdapterAuthLevel | 'read' | 'full';
export type RuntimeAdapterCommandLaneKind = 'owner' | 'capability';
type RuntimeAdapterOwnerBindingSigner = (input: {
  runtimeId: string;
  challenge: string;
  capability: string;
}) => Promise<string | null> | string | null;

export type RuntimeAdapterConfig = {
  mode: RuntimeAdapterMode;
  runtimeId?: string;
  wsUrl?: string;
  authKey?: string;
  seed?: string;
  reconnectMaxMs?: number;
  requestTimeoutMs?: number;
  /** Memory-only signer supplied by an unlocked vault; never serialize it. */
  ownerBindingSigner?: RuntimeAdapterOwnerBindingSigner;
};

export type RuntimeAdapterReadQuery = {
  atHeight?: number;
  heights?: number[] | string;
  cursor?: string;
  limit?: number;
  entityId?: string;
  accountId?: string;
  accountsPage?: number;
  booksPage?: number;
  accountsCursor?: string;
  booksCursor?: string;
  accountsLimit?: number;
  booksLimit?: number;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  kind?: RuntimeActivityFilters['kind'];
  types?: string[] | string;
  q?: string;
  query?: string;
  fromTimestamp?: number;
  toTimestamp?: number;
  beforeHeight?: number;
  scanLimit?: number;
  fromHeight?: number;
  toHeight?: number;
  eventNames?: string[] | string;
  sourceEntityId?: string;
  targetEntityId?: string;
  tokenId?: number;
  amount?: string;
};

export type RuntimeAdapterFrameLog = {
  id: number;
  timestamp: number;
  level: string;
  category: string;
  message: string;
  entityId?: string;
  data?: Record<string, unknown>;
};

export type RuntimeAdapterFrameReceipt = {
  height: number;
  timestamp: number;
  logs: RuntimeAdapterFrameLog[];
};

export type RuntimeAdapterFrameReceiptResponse = {
  fromHeight: number;
  toHeight: number;
  returned: number;
  receipts: RuntimeAdapterFrameReceipt[];
};

export type RuntimeAdapterPaymentRoute = {
  path: string[];
  hops: Array<{
    from: string;
    to: string;
    fee: string;
    feePPM: number;
  }>;
  totalFee: string;
  senderAmount: string;
  recipientAmount: string;
  probability: number;
};

export type RuntimeAdapterPaymentRoutesResponse = {
  routes: RuntimeAdapterPaymentRoute[];
};

export type RuntimeAdapterActivityPage = {
  ok: true;
  runtimeId?: string | undefined;
  latestHeight: number;
  fromHeight: number;
  toHeight: number;
  scannedFrames: number;
  returned: number;
  limit: number;
  scanLimit: number;
  nextBeforeHeight: number | null;
  filters: RuntimeActivityFilters;
  events: RuntimeActivityEvent[];
};

/** Paged lifecycle projection rebuilt from certified Account-frame history only. */
export type RuntimeAdapterSwapHistoryPage = PersistedAccountSwapHistoryPage;

export type RuntimeAdapterSolvencySummary = {
  ok: true;
  height: number;
  entityCount: number;
  accountViews: number;
  assets: Array<{
    stackId: string;
    chainId: number;
    depositoryAddress: string;
    tokenId: number;
    reserves: bigint;
    confirmedCollateral: bigint;
    /** reserves + collateral: the side of the conservation law a Runtime owns. */
    internalValue: bigint;
    /** Authoritative Depository total, when the caller supplied one. */
    expectedInternalValue: bigint | null;
    delta: bigint | null;
    /** null means not checked - never "checked and fine". */
    isValid: boolean | null;
  }>;
  isValid: boolean | null;
};

type RuntimeAdapterTimelineFrame = {
  runtimeId: string;
  height: number;
  timestamp: number;
  stateHash: string;
  materialized: boolean;
  graphChanged: boolean;
};

export type RuntimeAdapterTimelineIndexPage = {
  runtimeId: string;
  latestHeight: number;
  entries: RuntimeAdapterTimelineFrame[];
  scannedHeights: number;
  nextBeforeHeight: number | null;
};

export type RuntimeAdapterSendResult = {
  height: number;
  status?: 'pending' | 'observed';
  commandSequence?: number;
};

export type RuntimeAdapterSendOptions = { commandId?: string; commandSequence?: number };

export type RuntimeAdapterCrossJurisdictionIntentResult = {
  delivered: true;
};

export type RuntimeAdapterControlAction = 'verify-chain' | SettlementEvidenceRequest;

/** Exact secret input sent only to the selected trusted node's admin channel. */
export type RuntimeAdapterBrainVaultInput = Readonly<{
  specId: string;
  name: string;
  passphrase: string;
  shardInput: number;
  workers: number;
}>;

export type RuntimeAdapterBrainVaultProgress = Readonly<{
  completed: number;
  total: number;
  elapsedMs: number;
  lastShardMs: number;
  workers: number;
}>;

/** Public receipt returned after the node durably installs its local signer. */
export type RuntimeAdapterBrainVaultResult = Readonly<{
  specId: string;
  backend: 'native-node';
  shardCount: number;
  factor: number;
  workers: number;
  derivationTimeMs: number;
  ethereumAddress: string;
  entityId: string;
  created: boolean;
  height: number;
}>;

/** Secret recovery export, available only through a separate explicit action. */
export type RuntimeAdapterBrainVaultRecovery = Readonly<{ mnemonic24: string }>;

export type RuntimeAdapterBrainVaultOptions = Readonly<{
  signal?: AbortSignal;
  onProgress?: (progress: RuntimeAdapterBrainVaultProgress) => void;
}>;

export interface RuntimeAdapter {
  readonly mode: RuntimeAdapterMode;
  readonly runtimeId: string;
  readonly serverFingerprint: string | null;
  readonly status: RuntimeAdapterStatus;
  readonly currentHeight: number;
  readonly nextCommandSequence: number | null;
  readonly commandLaneKind: RuntimeAdapterCommandLaneKind | null;
  readonly authLevel: RuntimeAdapterAuthLevel | null;
  readonly commandReady: boolean;
  readonly commandReadyReason: string | null;

  connect(config: RuntimeAdapterConfig): Promise<void>;
  disconnect(): void;
  ensureOwnerCommandLane(): Promise<void>;

  read<T = unknown>(path: string, query?: RuntimeAdapterReadQuery): Promise<T>;
  send(input: RuntimeInput, options?: RuntimeAdapterSendOptions): Promise<RuntimeAdapterSendResult>;
  submitCrossJurisdictionIntent(
    route: CrossJurisdictionSwapRoute,
  ): Promise<RuntimeAdapterCrossJurisdictionIntentResult>;
  registerNumberedEntities(
    input: NumberedRegistrationCommand,
  ): Promise<NumberedRegistrationCommandResult>;
  deriveBrainVault(
    input: RuntimeAdapterBrainVaultInput,
    options?: RuntimeAdapterBrainVaultOptions,
  ): Promise<RuntimeAdapterBrainVaultResult>;
  revealBrainVaultMnemonic(): Promise<RuntimeAdapterBrainVaultRecovery>;
  control<T = unknown>(action: RuntimeAdapterControlAction): Promise<T>;
  onChange(cb: (height: number) => void): () => void;
  onStatus(cb: (status: RuntimeAdapterStatus) => void): () => void;
}

export type RuntimeAdapterErrorCode =
  | 'E_UNAUTHORIZED'
  | 'E_NOT_FOUND'
  | 'E_BAD_PATH'
  | 'E_BAD_QUERY'
  | 'E_RATE_LIMITED'
  | 'E_COMMAND_PENDING'
  | 'E_INTERNAL';

export type RuntimeAdapterErrorPayload = {
  code: RuntimeAdapterErrorCode;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
};

export type RuntimeAdapterRequest =
  | { v: XlnProtocolVersion; id: string; op: 'auth'; key?: string; challenge: string; ownerSignature?: string }
  | { v: XlnProtocolVersion; id: string; op: 'read'; path: string; query?: RuntimeAdapterReadQuery }
  | { v: XlnProtocolVersion; id: string; op: 'send'; commandId: string; commandSequence: number; input: RuntimeInput }
  | { v: XlnProtocolVersion; id: string; op: 'control'; action: RuntimeAdapterControlAction }
  | { v: XlnProtocolVersion; id: string; op: 'brainvault-derive'; jobId: string; input: RuntimeAdapterBrainVaultInput }
  | { v: XlnProtocolVersion; id: string; op: 'brainvault-cancel'; jobId: string }
  | { v: XlnProtocolVersion; id: string; op: 'brainvault-reveal' }
  | { v: XlnProtocolVersion; id: string; op: 'numbered-registration'; input: NumberedRegistrationCommand }
  | { v: XlnProtocolVersion; id: string; op: 'cross-j-intent'; route: CrossJurisdictionSwapRoute };

export type RuntimeAdapterResponse =
  | { v: XlnProtocolVersion; inReplyTo: string; ok: true; payload: unknown }
  | { v: XlnProtocolVersion; inReplyTo: string; ok: false; error: RuntimeAdapterErrorPayload };

export type RuntimeAdapterPush =
  | {
      v: XlnProtocolVersion;
      op: 'tick';
      height: number;
      commandReady: boolean;
      commandReadyReason: string | null;
    }
  | {
      v: XlnProtocolVersion;
      op: 'brainvault-progress';
      jobId: string;
      progress: RuntimeAdapterBrainVaultProgress;
    };

export type RuntimeAdapterEntitySummary = {
  entityId: string;
  runtimeId?: string;
  signerId?: string;
  label: string;
  height: number;
  isHub?: boolean;
  jurisdiction?: {
    name?: string;
    address?: string;
    chainId?: number | string;
    depositoryAddress?: string;
    entityProviderAddress?: string;
  };
};

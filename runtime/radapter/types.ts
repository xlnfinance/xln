import type { RuntimeActivityEvent, RuntimeActivityFilters } from '../api/activity-history';
import type { CrossJurisdictionSwapRoute, RuntimeInput } from '../types';
import type { XlnProtocolVersion } from '../protocol/version';
import type { RuntimeIngressReceipt } from '../server/ingress-receipts';

export type RuntimeAdapterMode = 'embedded' | 'remote';
export type RuntimeAdapterStatus = 'connected' | 'connecting' | 'disconnected' | 'error';
export type RuntimeAdapterAuthLevel = 'inspect' | 'admin';
export type RuntimeAdapterAuthRole = RuntimeAdapterAuthLevel | 'read' | 'full';
export type RuntimeAdapterCommandLaneKind = 'owner' | 'capability';
export type RuntimeAdapterOwnerBindingSigner = (input: {
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
    pendingCollateral: bigint;
    delta: bigint;
    isValid: boolean;
  }>;
  isValid: boolean;
};

export type RuntimeAdapterTimelineFrame = {
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
  receipt?: RuntimeIngressReceipt;
  statusUrl?: string;
};

export type RuntimeAdapterSendOptions = { commandId?: string; commandSequence?: number };

export type RuntimeAdapterCrossJurisdictionIntentResult = {
  delivered: true;
};

export type RuntimeAdapterControlAction = 'verify-chain';

export interface RuntimeAdapter {
  readonly mode: RuntimeAdapterMode;
  readonly runtimeId: string;
  readonly serverFingerprint: string | null;
  readonly status: RuntimeAdapterStatus;
  readonly currentHeight: number;
  readonly nextCommandSequence: number | null;
  readonly commandLaneKind: RuntimeAdapterCommandLaneKind | null;
  readonly authLevel: RuntimeAdapterAuthLevel | null;

  connect(config: RuntimeAdapterConfig): Promise<void>;
  disconnect(): void;
  ensureOwnerCommandLane(): Promise<void>;

  read<T = unknown>(path: string, query?: RuntimeAdapterReadQuery): Promise<T>;
  send(input: RuntimeInput, options?: RuntimeAdapterSendOptions): Promise<RuntimeAdapterSendResult>;
  submitCrossJurisdictionIntent(
    route: CrossJurisdictionSwapRoute,
  ): Promise<RuntimeAdapterCrossJurisdictionIntentResult>;
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
  | { v: XlnProtocolVersion; id: string; op: 'cross-j-intent'; route: CrossJurisdictionSwapRoute };

export type RuntimeAdapterResponse =
  | { v: XlnProtocolVersion; inReplyTo: string; ok: true; payload: unknown }
  | { v: XlnProtocolVersion; inReplyTo: string; ok: false; error: RuntimeAdapterErrorPayload };

export type RuntimeAdapterPush = {
  v: XlnProtocolVersion;
  op: 'tick';
  height: number;
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

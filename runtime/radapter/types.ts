import type { RuntimeActivityEvent, RuntimeActivityFilters } from '../activity-history';
import type { RuntimeInput } from '../types';
import type { RuntimeIngressReceipt } from '../server/ingress-receipts';

export type RuntimeAdapterMode = 'embedded' | 'remote';
export type RuntimeAdapterStatus = 'connected' | 'connecting' | 'disconnected' | 'error';
export type RuntimeAdapterAuthLevel = 'inspect' | 'admin';
export type RuntimeAdapterAuthRole = RuntimeAdapterAuthLevel | 'read' | 'full';

export type RuntimeAdapterConfig = {
  mode: RuntimeAdapterMode;
  runtimeId?: string;
  wsUrl?: string;
  authKey?: string;
  seed?: string;
  reconnectMaxMs?: number;
  requestTimeoutMs?: number;
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
  m1: bigint;
  m2: bigint;
  m3: bigint;
  total: bigint;
  delta: bigint;
  isValid: boolean;
};

export type RuntimeAdapterSendResult = {
  height: number;
  receipt?: RuntimeIngressReceipt;
  statusUrl?: string;
};

export interface RuntimeAdapter {
  readonly mode: RuntimeAdapterMode;
  readonly runtimeId: string;
  readonly status: RuntimeAdapterStatus;
  readonly currentHeight: number;
  readonly authLevel: RuntimeAdapterAuthLevel | null;

  connect(config: RuntimeAdapterConfig): Promise<void>;
  disconnect(): void;

  read<T = unknown>(path: string, query?: RuntimeAdapterReadQuery): Promise<T>;
  send(input: RuntimeInput): Promise<RuntimeAdapterSendResult>;
  onChange(cb: (height: number) => void): () => void;
  onStatus(cb: (status: RuntimeAdapterStatus) => void): () => void;
}

export type RuntimeAdapterErrorCode =
  | 'E_UNAUTHORIZED'
  | 'E_NOT_FOUND'
  | 'E_BAD_PATH'
  | 'E_BAD_QUERY'
  | 'E_RATE_LIMITED'
  | 'E_INTERNAL';

export type RuntimeAdapterErrorPayload = {
  code: RuntimeAdapterErrorCode;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
};

export type RuntimeAdapterRequest =
  | { v: 1; id: string; op: 'auth'; key?: string }
  | { v: 1; id: string; op: 'read'; path: string; query?: RuntimeAdapterReadQuery }
  | { v: 1; id: string; op: 'send'; input: RuntimeInput };

export type RuntimeAdapterResponse =
  | { v: 1; inReplyTo: string; ok: true; payload: unknown }
  | { v: 1; inReplyTo: string; ok: false; error: RuntimeAdapterErrorPayload };

export type RuntimeAdapterPush = {
  v: 1;
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

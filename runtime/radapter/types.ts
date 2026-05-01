import type { RuntimeInput } from '../types';

export type RuntimeAdapterMode = 'embedded' | 'remote';
export type RuntimeAdapterStatus = 'connected' | 'connecting' | 'disconnected' | 'error';
export type RuntimeAdapterAuthLevel = 'inspect' | 'admin';
export type RuntimeAdapterAuthRole = RuntimeAdapterAuthLevel | 'read' | 'full';

export type RuntimeAdapterConfig = {
  mode: RuntimeAdapterMode;
  wsUrl?: string;
  authKey?: string;
  seed?: string;
  reconnectMaxMs?: number;
  requestTimeoutMs?: number;
};

export type RuntimeAdapterReadQuery = {
  atHeight?: number;
  cursor?: string;
  limit?: number;
  entityId?: string;
  accountsCursor?: string;
  booksCursor?: string;
  accountsLimit?: number;
  booksLimit?: number;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
};

export interface RuntimeAdapter {
  readonly mode: RuntimeAdapterMode;
  readonly status: RuntimeAdapterStatus;
  readonly currentHeight: number;
  readonly authLevel: RuntimeAdapterAuthLevel | null;

  connect(config: RuntimeAdapterConfig): Promise<void>;
  disconnect(): void;

  read<T = unknown>(path: string, query?: RuntimeAdapterReadQuery): Promise<T>;
  send(input: RuntimeInput): Promise<{ height: number }>;
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
  label: string;
  height: number;
};

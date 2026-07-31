import type { EntityTx } from '../../types/entity-tx';
import type { FrameLogEntry } from '../../types/logging';
import type { JInput } from '../../jurisdiction/machine/input';
import type { RuntimeTx } from '../../runtime/types';

export type ActivityKind = 'onchain' | 'offchain';
export type ActivityType =
  | 'payment'
  | 'swap'
  | 'cross_swap'
  | 'htlc'
  | 'settlement'
  | 'account'
  | 'j_event'
  | 'j_batch'
  | 'system'
  | 'error';
export type ActivityDirection = 'in' | 'out' | 'neutral';
export type ActivitySource = 'runtime_input' | 'runtime_log' | 'j_input';

export type RuntimeActivityFilters = {
  entityId?: string | undefined;
  kind?: ActivityKind | 'all' | undefined;
  types?: string[] | undefined;
  query?: string | undefined;
  fromTimestamp?: number | undefined;
  toTimestamp?: number | undefined;
};

export type RuntimeActivityEvent = {
  id: string;
  runtimeId?: string | undefined;
  height: number;
  timestamp: number;
  kind: ActivityKind;
  type: ActivityType;
  source: ActivitySource;
  direction: ActivityDirection;
  title: string;
  subtitle: string;
  status: string;
  entityId?: string | undefined;
  counterpartyId?: string | undefined;
  tokenId?: number | undefined;
  amount?: string | undefined;
  quoteTokenId?: number | undefined;
  quoteAmount?: string | undefined;
  orderId?: string | undefined;
  hash?: string | undefined;
  rawType: string;
};

/**
 * Minimal persisted facts needed to rebuild the disposable Activity view.
 * This is projection input, not canonical machine State.
 */
export type PersistedActivityJournal = {
  height: number;
  timestamp: number;
  runtimeInput?: {
    runtimeTxs?: RuntimeTx[];
    entityInputs: Array<{ entityId: string; entityTxs?: EntityTx[] }>;
    jInputs?: JInput[];
  };
  logs?: FrameLogEntry[];
};

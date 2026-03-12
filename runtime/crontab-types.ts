export type CrontabTaskMethod = 'checkAccountTimeouts' | 'hubRebalance';

export type CrontabTaskParam = string | number | boolean;

export interface CrontabTaskState {
  method: CrontabTaskMethod;
  intervalMs: number;
  lastRun: number;
  enabled: boolean;
  params: Record<string, CrontabTaskParam>;
}

export type ScheduledHookType =
  | 'htlc_timeout'
  | 'dispute_deadline'
  | 'htlc_secret_ack_timeout'
  | 'settlement_window'
  | 'watchdog'
  | 'hub_rebalance_kick';

type ScheduledHookBase<TType extends ScheduledHookType, TData extends Record<string, unknown>> = {
  id: string;
  triggerAt: number;
  type: TType;
  data: TData;
};

export type HtlcTimeoutHook = ScheduledHookBase<'htlc_timeout', {
  accountId: string;
  lockId: string;
}>;

export type DisputeDeadlineHook = ScheduledHookBase<'dispute_deadline', {
  accountId: string;
}>;

export type HtlcSecretAckTimeoutHook = ScheduledHookBase<'htlc_secret_ack_timeout', {
  hashlock: string;
  counterpartyEntityId: string;
  inboundLockId: string;
}>;

export type SettlementWindowHook = ScheduledHookBase<'settlement_window', Record<string, never>>;

export type WatchdogHook = ScheduledHookBase<'watchdog', Record<string, never>>;

export type HubRebalanceKickHook = ScheduledHookBase<'hub_rebalance_kick', {
  reason: string;
  counterpartyId: string;
}>;

export type ScheduledHook =
  | HtlcTimeoutHook
  | DisputeDeadlineHook
  | HtlcSecretAckTimeoutHook
  | SettlementWindowHook
  | WatchdogHook
  | HubRebalanceKickHook;

export interface CrontabState {
  tasks: Map<CrontabTaskMethod, CrontabTaskState>;
  hooks: Map<string, ScheduledHook>;
}

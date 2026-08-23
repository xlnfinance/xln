import type { EntityCandidateEffect, EntityState, HashToSign } from '../types';

/**
 * One isolated Entity reducer pass only needs the candidate State and its id.
 * Replica-local mempool, signatures, encryption keys, and delivery metadata
 * intentionally remain outside deterministic scheduling.
 */
export type EntityTransitionContext = {
  entityId: string;
  state: EntityState;
};

export type CrontabTaskMethod = 'hubRebalance';

type CrontabTaskParam = string | number | boolean;

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
  | 'hub_rebalance_kick'
  | 'board_hanko_refresh'
  | 'counterparty_board_hanko_refresh_deadline'
  | 'cross_j_orderbook_sweep';

type ScheduledHookBase<TType extends ScheduledHookType, TData extends Record<string, unknown>> = {
  id: string;
  triggerAt: number;
  type: TType;
  data: TData;
};

type HtlcTimeoutHook = ScheduledHookBase<'htlc_timeout', {
  accountId: string;
  lockId: string;
}>;

type DisputeDeadlineHook = ScheduledHookBase<'dispute_deadline', {
  accountId: string;
}>;

type HtlcSecretAckTimeoutHook = ScheduledHookBase<'htlc_secret_ack_timeout', {
  hashlock: string;
  counterpartyEntityId: string;
  inboundLockId: string;
}>;

type SettlementWindowHook = ScheduledHookBase<'settlement_window', Record<string, never>>;

type WatchdogHook = ScheduledHookBase<'watchdog', Record<string, never>>;

type HubRebalanceKickHook = ScheduledHookBase<'hub_rebalance_kick', {
  reason: string;
  counterpartyId: string;
}>;

type BoardHankoRefreshHook = ScheduledHookBase<'board_hanko_refresh', {
  activationJHeight: number;
  activationLogIndex: number;
  afterCounterpartyId: string;
}>;

type CounterpartyBoardHankoRefreshDeadlineHook = ScheduledHookBase<'counterparty_board_hanko_refresh_deadline', {
  accountId: string;
  activationJHeight: number;
  activationLogIndex: number;
}>;

type CrossJurisdictionOrderbookSweepHook = ScheduledHookBase<'cross_j_orderbook_sweep', {
  reason: string;
}>;

export type ScheduledHook =
  | HtlcTimeoutHook
  | DisputeDeadlineHook
  | HtlcSecretAckTimeoutHook
  | SettlementWindowHook
  | WatchdogHook
  | HubRebalanceKickHook
  | BoardHankoRefreshHook
  | CounterpartyBoardHankoRefreshDeadlineHook
  | CrossJurisdictionOrderbookSweepHook;

export interface CrontabState {
  tasks: Map<CrontabTaskMethod, CrontabTaskState>;
  hooks: Map<string, ScheduledHook>;
}

/** Mutable effect sinks shared by one isolated Entity crontab pass. */
export type CrontabExecutionContext = {
  manualBroadcastInInput: boolean;
  hashesToSign?: HashToSign[];
  accountChanges: Set<string>;
  candidateEffects?: EntityCandidateEffect[];
};

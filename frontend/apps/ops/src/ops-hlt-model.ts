import {
  HLT_DASHBOARD_DEFAULTS,
  previewHltDashboard,
  type HltDashboardConfig,
  type HltDashboardMode,
  type HltDashboardPreview,
} from '../../../../core/qa/hlt/hlt-dashboard-preview';
import type { HltDashboardPayload } from '../../../packages/runtime-client/src/qa-hlt';

export type OpsHltTab = 'control' | 'progress';
export type OpsHltPhase = 'build' | 'replay';
export type OpsHltReplayMode = 'max' | 'fixed' | 'sweep';

export type OpsHltControlState = Readonly<{
  users: number;
  ratePerUserPerSecond: number;
  durationSeconds: number;
  hubs: string;
  mode: HltDashboardMode;
  profile: boolean;
  paymentAmountMin: number;
  paymentAmountMax: number;
  replayMode: OpsHltReplayMode;
  replayRates: string;
}>;

export type OpsHltStartRequest = Readonly<{
  users: number;
  runtimesPerProcess: number;
  rate: number;
  duration: number;
  hubs: string;
  mode: HltDashboardMode;
  profile: boolean;
  paymentMin: string;
  paymentMax: string;
  phase: OpsHltPhase;
  replayMode: OpsHltReplayMode;
  replayRates: string;
}>;

export const OPS_HLT_DEFAULT_CONTROLS: OpsHltControlState = {
  users: HLT_DASHBOARD_DEFAULTS.users,
  ratePerUserPerSecond: HLT_DASHBOARD_DEFAULTS.ratePerUserPerSecond,
  durationSeconds: HLT_DASHBOARD_DEFAULTS.durationSeconds,
  hubs: HLT_DASHBOARD_DEFAULTS.hubs,
  mode: HLT_DASHBOARD_DEFAULTS.mode,
  profile: HLT_DASHBOARD_DEFAULTS.profile,
  paymentAmountMin: Number(HLT_DASHBOARD_DEFAULTS.paymentAmountMin),
  paymentAmountMax: Number(HLT_DASHBOARD_DEFAULTS.paymentAmountMax),
  replayMode: 'max',
  replayRates: '250,500,750,1000,1500,2000',
};

export const readOpsHltMode = (value: string): HltDashboardMode => {
  if (value === 'payments' || value === 'same' || value === 'mixed' || value === 'cross') return value;
  throw new Error(`OPS_HLT_MODE_INVALID:${value}`);
};

export const readOpsHltReplayMode = (value: string): OpsHltReplayMode => {
  if (value === 'max' || value === 'fixed' || value === 'sweep') return value;
  throw new Error(`OPS_HLT_REPLAY_MODE_INVALID:${value}`);
};

export const readOpsHltHubs = (value: string): string => {
  if (value === 'H1' || value === 'H1,H2' || value === 'H1,H2,H3') return value;
  throw new Error(`OPS_HLT_HUBS_INVALID:${value}`);
};

const positiveInteger = (value: number, code: string): number => {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(code);
  return value;
};

export const buildOpsHltConfig = (controls: OpsHltControlState): HltDashboardConfig => {
  const paymentMin = BigInt(positiveInteger(controls.paymentAmountMin, 'OPS_HLT_PAYMENT_MIN_INVALID'));
  const paymentMax = BigInt(positiveInteger(controls.paymentAmountMax, 'OPS_HLT_PAYMENT_MAX_INVALID'));
  if (paymentMax < paymentMin) throw new Error('OPS_HLT_PAYMENT_RANGE_INVALID');
  return {
    users: positiveInteger(controls.users, 'OPS_HLT_USERS_INVALID'),
    runtimesPerProcess: HLT_DASHBOARD_DEFAULTS.runtimesPerProcess,
    ratePerUserPerSecond: positiveInteger(controls.ratePerUserPerSecond, 'OPS_HLT_RATE_INVALID'),
    durationSeconds: positiveInteger(controls.durationSeconds, 'OPS_HLT_DURATION_INVALID'),
    mix: controls.mode === 'same' ? '1:0' : '0:1',
    hubs: controls.hubs,
    marketMakers: HLT_DASHBOARD_DEFAULTS.marketMakers,
    mode: controls.mode,
    profile: controls.profile,
    paymentAmountMin: paymentMin,
    paymentAmountMax: paymentMax,
  };
};

export const previewOpsHlt = (controls: OpsHltControlState): HltDashboardPreview =>
  previewHltDashboard(buildOpsHltConfig(controls));

export const buildOpsHltStartRequest = (
  controls: OpsHltControlState,
  phase: OpsHltPhase,
): OpsHltStartRequest => {
  const config = buildOpsHltConfig(controls);
  return {
    users: config.users,
    runtimesPerProcess: config.runtimesPerProcess,
    rate: config.ratePerUserPerSecond,
    duration: config.durationSeconds,
    hubs: config.hubs,
    mode: config.mode,
    profile: config.profile,
    paymentMin: String(config.paymentAmountMin),
    paymentMax: String(config.paymentAmountMax),
    phase,
    replayMode: controls.replayMode,
    replayRates: controls.replayRates,
  };
};

export const opsHltVerdict = (snapshot: HltDashboardPayload | null): Readonly<{
  status: 'IDLE' | 'RUNNING' | 'PASS' | 'FAIL';
  detail: string;
}> => {
  if (!snapshot) return { status: 'IDLE', detail: 'No HLT evidence loaded' };
  if (snapshot.run.active) return { status: 'RUNNING', detail: snapshot.run.phase === 'replay' ? 'Replaying H1 inputs' : 'Recording a live isolated shard' };
  if (snapshot.run.status === 'red' || snapshot.run.error) return { status: 'FAIL', detail: snapshot.run.error ?? 'Latest run failed' };
  if (snapshot.payment || snapshot.swap || snapshot.replay) return { status: 'PASS', detail: 'Latest HLT evidence decoded and available' };
  return { status: 'IDLE', detail: 'No completed result is available yet' };
};

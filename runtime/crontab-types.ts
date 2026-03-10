export type CrontabTaskMethod = 'checkAccountTimeouts' | 'hubRebalance';

export type CrontabTaskParam = string | number | boolean;

export interface CrontabTaskState {
  method: CrontabTaskMethod;
  intervalMs: number;
  lastRun: number;
  enabled: boolean;
  params: Record<string, CrontabTaskParam>;
}

export interface ScheduledHook {
  id: string;
  triggerAt: number;
  type: string;
  data: Record<string, unknown>;
}

export interface CrontabState {
  tasks: Map<CrontabTaskMethod, CrontabTaskState>;
  hooks: Map<string, ScheduledHook>;
}

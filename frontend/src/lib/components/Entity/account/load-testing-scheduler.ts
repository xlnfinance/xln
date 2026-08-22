export type LoadTestLane = 'pay' | 'swap';

export type LoadTestAttemptResult = Readonly<{
  status: 'submitted' | 'skipped' | 'failed';
  stpPrevented?: boolean;
  reason?: string;
}>;

export type LoadTestLaneMetrics = {
  attempted: number;
  submitted: number;
  skipped: number;
  failed: number;
  stpPrevented: number;
};

export type LoadTestMetrics = Record<LoadTestLane, LoadTestLaneMetrics>;

export type LoadTestSchedulerSnapshot = Readonly<{
  running: boolean;
  elapsedSeconds: number;
  metrics: LoadTestMetrics;
  lastResult: Readonly<Record<LoadTestLane, string>>;
}>;

export type LoadTestSchedulerConfig = Readonly<{
  durationMinutes: number;
  pay: Readonly<{ enabled: boolean; rate: number }>;
  swap: Readonly<{ enabled: boolean; rate: number }>;
}>;

type SchedulerDeps = Readonly<{
  now: () => number;
  random: () => number;
  setTimer: (run: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  attempt: (lane: LoadTestLane) => Promise<LoadTestAttemptResult>;
  onSnapshot: (snapshot: LoadTestSchedulerSnapshot) => void;
}>;

const emptyLaneMetrics = (): LoadTestLaneMetrics => ({
  attempted: 0,
  submitted: 0,
  skipped: 0,
  failed: 0,
  stpPrevented: 0,
});

const requireRate = (rate: number, lane: LoadTestLane): number => {
  if (!Number.isFinite(rate) || rate < 0.1 || rate > 100) {
    throw new Error(`LOAD_TEST_${lane.toUpperCase()}_RATE_INVALID:${rate}`);
  }
  return rate;
};

const laneIntervalMs = (config: LoadTestSchedulerConfig, lane: LoadTestLane): number =>
  1_000 / requireRate(config[lane].rate, lane);

const nextDelayMs = (intervalMs: number, random: () => number): number => {
  const jitter = Math.min(250, intervalMs * 0.25);
  return Math.max(1, intervalMs + (random() * 2 - 1) * jitter);
};

export class LoadTestScheduler {
  readonly #deps: SchedulerDeps;
  #config: LoadTestSchedulerConfig | null = null;
  #startedAt = 0;
  #stopsAt = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #running = false;
  #nextAt: Record<LoadTestLane, number> = { pay: 0, swap: 0 };
  #inFlight: Record<LoadTestLane, boolean> = { pay: false, swap: false };
  #metrics: LoadTestMetrics = { pay: emptyLaneMetrics(), swap: emptyLaneMetrics() };
  #lastResult: Record<LoadTestLane, string> = { pay: '', swap: '' };

  constructor(deps: SchedulerDeps) {
    this.#deps = deps;
  }

  start(config: LoadTestSchedulerConfig): void {
    if (this.#running) return;
    if (!Number.isInteger(config.durationMinutes) || config.durationMinutes < 1 || config.durationMinutes > 100) {
      throw new Error(`LOAD_TEST_DURATION_INVALID:${config.durationMinutes}`);
    }
    if (!config.pay.enabled && !config.swap.enabled) throw new Error('LOAD_TEST_NO_LANE_ENABLED');
    if (config.pay.enabled) requireRate(config.pay.rate, 'pay');
    if (config.swap.enabled) requireRate(config.swap.rate, 'swap');
    this.#config = config;
    this.#running = true;
    this.#startedAt = this.#deps.now();
    this.#stopsAt = this.#startedAt + config.durationMinutes * 60_000;
    this.#metrics = { pay: emptyLaneMetrics(), swap: emptyLaneMetrics() };
    this.#lastResult = { pay: '', swap: '' };
    for (const lane of ['pay', 'swap'] as const) {
      this.#inFlight[lane] = false;
      this.#nextAt[lane] = config[lane].enabled
        ? this.#startedAt + this.#deps.random() * Math.min(500, laneIntervalMs(config, lane))
        : Number.POSITIVE_INFINITY;
    }
    this.#emit();
    this.#schedule(0);
  }

  stop(): void {
    if (!this.#running) return;
    this.#running = false;
    if (this.#timer) this.#deps.clearTimer(this.#timer);
    this.#timer = null;
    this.#emit();
  }

  #schedule(delayMs: number): void {
    if (!this.#running) return;
    if (this.#timer) this.#deps.clearTimer(this.#timer);
    this.#timer = this.#deps.setTimer(() => this.#tick(), Math.max(0, delayMs));
  }

  #tick(): void {
    if (!this.#running || !this.#config) return;
    const now = this.#deps.now();
    if (now >= this.#stopsAt) {
      this.stop();
      return;
    }
    for (const lane of ['pay', 'swap'] as const) {
      if (!this.#config[lane].enabled || now < this.#nextAt[lane]) continue;
      const intervalMs = laneIntervalMs(this.#config, lane);
      this.#nextAt[lane] = now + nextDelayMs(intervalMs, this.#deps.random);
      this.#metrics[lane].attempted += 1;
      if (this.#inFlight[lane]) {
        this.#record(lane, { status: 'skipped', reason: 'Previous command is still submitting' });
        continue;
      }
      this.#inFlight[lane] = true;
      void this.#deps.attempt(lane)
        .then(result => this.#record(lane, result))
        .catch(error => this.#record(lane, {
          status: 'failed',
          reason: error instanceof Error ? error.message : String(error),
        }))
        .finally(() => {
          this.#inFlight[lane] = false;
          this.#emit();
        });
    }
    this.#emit();
    const nextDue = Math.min(this.#nextAt.pay, this.#nextAt.swap, this.#stopsAt);
    this.#schedule(Math.min(250, Math.max(1, nextDue - now)));
  }

  #record(lane: LoadTestLane, result: LoadTestAttemptResult): void {
    const metrics = this.#metrics[lane];
    if (result.status === 'submitted') metrics.submitted += 1;
    else if (result.status === 'skipped') metrics.skipped += 1;
    else metrics.failed += 1;
    if (result.stpPrevented) metrics.stpPrevented += 1;
    this.#lastResult[lane] = result.reason ?? result.status;
  }

  #emit(): void {
    const elapsedSeconds = this.#startedAt > 0
      ? Math.max(0, Math.floor((Math.min(this.#deps.now(), this.#stopsAt || Number.POSITIVE_INFINITY) - this.#startedAt) / 1_000))
      : 0;
    this.#deps.onSnapshot({
      running: this.#running,
      elapsedSeconds,
      metrics: {
        pay: { ...this.#metrics.pay },
        swap: { ...this.#metrics.swap },
      },
      lastResult: { ...this.#lastResult },
    });
  }
}

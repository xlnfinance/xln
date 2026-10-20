import { expect, test } from 'bun:test';
import {
  LoadTestScheduler,
  type LoadTestAttemptResult,
  type LoadTestSchedulerSnapshot,
} from '../../../../frontend/src/lib/components/Entity/account/load-testing-scheduler';

const config = { durationMinutes: 1, pay: { enabled: true, rate: 100 }, swap: { enabled: false, rate: 1 } };

test('Stop retains pending admission and forbids a second run until it drains', async () => {
  const started = Promise.withResolvers<AbortSignal>();
  const pending = Promise.withResolvers<LoadTestAttemptResult>();
  const drained = Promise.withResolvers<LoadTestSchedulerSnapshot>();
  let stopped = false;
  let calls = 0;
  const scheduler = new LoadTestScheduler({
    now: Date.now,
    random: () => 0,
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: timer => clearTimeout(timer),
    attempt: async (_lane, signal) => {
      calls++;
      started.resolve(signal);
      return pending.promise;
    },
    onSnapshot: snapshot => {
      if (stopped && snapshot.metrics.pay.submitted === 1) drained.resolve(snapshot);
    },
  });
  try {
    scheduler.start(config);
    const signal = await started.promise;
    scheduler.stop();
    stopped = true;
    expect(signal.aborted).toBe(true);
    expect(() => scheduler.start(config)).toThrow('LOAD_TEST_DRAIN_PENDING');
    expect(calls).toBe(1);
    pending.resolve({ status: 'submitted' });
    const final = await drained.promise;
    expect(final.running).toBe(false);
    expect(final.draining).toBe(false);
    expect(final.metrics.pay.submitted).toBe(1);
    expect(() => scheduler.start(config)).not.toThrow();
  } finally {
    scheduler.stop();
    pending.resolve({ status: 'submitted' });
  }
});

/**
 * F: feedback latency. T = sum(stage minutes) / prod(p_stage), p Laplace-smoothed over the 21 days before the
 * measured commit; F = 90 * logScore(T, 5 min, 480 min). Stages: check, full unit, lock-ahb, E2E payment.
 * Skips count as failures. Needs the local ledger; without it F is unknown and scores 0.
 */
import { FEEDBACK_WINDOW_DAYS, type Ledger, type StageSample } from '../ledger';
import { DAY_MS, gap, laplace, logScore, median, round, type Axis } from '../model';
import type { Repo } from '../repo';

const E2E_PAYMENT_SPEC = /e2e-payment-smoke|tests\/e2e-payment\.spec/;

type Stage = Readonly<{ minutes: number; p: number; n: number }>;

const stageOf = (samples: readonly StageSample[], minutes: number): Stage => ({
  minutes,
  p: laplace(samples.filter(sample => sample.ok).length, samples.length),
  n: samples.length,
});

/** check = check:src wall (green runs) plus the check:short contract-drift wall that precedes it. */
const checkStage = (ledger: Ledger): Stage => {
  const green = ledger.logs.check.filter(sample => sample.ok).map(sample => sample.minutes);
  const short = ledger.logs.checkShortMinutes.length > 0 ? median(ledger.logs.checkShortMinutes) : 0;
  return stageOf(ledger.logs.check, median(green) + short);
};

const paymentStage = (repo: Repo, ledger: Ledger): Stage => {
  const since = repo.commitTimeMs - FEEDBACK_WINDOW_DAYS * DAY_MS;
  const runs = ledger.runs.filter(
    run => run.createdAt >= since && run.shards === 1 && run.files.some(file => E2E_PAYMENT_SPEC.test(file)),
  );
  const samples = runs.map(run => ({ ok: run.status === 'passed', minutes: (run.totalMs ?? Number.NaN) / 60_000 }));
  return stageOf(
    samples,
    median(samples.filter(sample => Number.isFinite(sample.minutes)).map(sample => sample.minutes)),
  );
};

const stagesOf = (repo: Repo, ledger: Ledger): Record<string, Stage> => ({
  check: checkStage(ledger),
  unit: stageOf(ledger.logs.unit, median(ledger.logs.unit.map(sample => sample.minutes))),
  lockAhb: stageOf(ledger.logs.lockAhb, median(ledger.logs.lockAhb.map(sample => sample.minutes))),
  e2ePayment: paymentStage(repo, ledger),
});

const feedbackAxis = (score: number, sub: Record<string, number>, gaps: Axis['gaps'], raw: Axis['raw']): Axis => ({
  id: 'F',
  name: 'Feedback latency',
  weight: 90,
  score,
  ceiling: score,
  sub,
  gaps,
  vetoes: [],
  raw,
});

const stageRaw = (stages: Record<string, Stage>) =>
  Object.fromEntries(
    Object.entries(stages).map(([key, stage]) => [
      key,
      { minutes: round(stage.minutes, 2), p: round(stage.p, 3), n: stage.n },
    ]),
  );

export const measureFeedback = (repo: Repo, ledger: Ledger | null): Axis => {
  if (!ledger) {
    return feedbackAxis(0, { latency: 0 }, [gap('F', 'feedback latency (unknown: no local ledger)', 90)], {
      ledgerInput: false,
    });
  }
  const stages = stagesOf(repo, ledger);
  const values = Object.values(stages);
  const sumMinutes = values.reduce((sum, stage) => sum + (Number.isFinite(stage.minutes) ? stage.minutes : 0), 0);
  const pAllGreen = values.reduce((product, stage) => product * stage.p, 1);
  const trustMinutes = sumMinutes / pAllGreen;
  const latency = logScore(trustMinutes, 5, 480);
  const gaps = [gap('F', `trustworthy green in ${String(round(trustMinutes))} min (target 5)`, 90 * (1 - latency))];
  const raw = {
    ledgerInput: true,
    windowDays: FEEDBACK_WINDOW_DAYS,
    stages: stageRaw(stages),
    sumMinutes: round(sumMinutes, 2),
    pAllGreen: round(pAllGreen, 4),
    expectedMinutesToTrustworthyGreen: round(trustMinutes, 1),
    logFilesScanned: ledger.logs.files.length,
  };
  return feedbackAxis(90 * latency, { latency }, gaps, raw);
};

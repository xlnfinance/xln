/**
 * F: feedback latency. T = sum(stage minutes) / prod(p_stage), p Laplace-smoothed over the 21 days that end at the
 * measured commit time; F = 90 * logScore(T, 5 min, 480 min). Stages: check, full unit, lock-ahb, E2E payment.
 * Skips and todos count as failures. Missing evidence scores 0: without `--ledger`, or when any stage has no timed
 * sample in the window, F is unknown, so dropping the slowest stage's logs can never raise the score.
 */
import { FEEDBACK_WINDOW_DAYS, runsInWindow, type Ledger, type StageSample } from '../ledger';
import { gap, laplace, logScore, median, round, type Axis } from '../model';

const E2E_PAYMENT_SPEC = /e2e-payment-smoke|tests\/e2e-payment\.spec/;

type Stage = Readonly<{ minutes: number; p: number; n: number }>;

const stageOf = (samples: readonly StageSample[], minutes: number): Stage => ({
  minutes,
  p: laplace(samples.filter(sample => sample.ok).length, samples.length),
  n: samples.length,
});

/** check = check:src wall (green runs) plus the check:short contract-drift wall; unknown (NaN) without either. */
const checkStage = (ledger: Ledger): Stage => {
  const green = ledger.logs.check.filter(sample => sample.ok).map(sample => sample.minutes);
  return stageOf(ledger.logs.check, median(green) + median(ledger.logs.checkShortMinutes));
};

const paymentStage = (ledger: Ledger): Stage => {
  const runs = runsInWindow(ledger, FEEDBACK_WINDOW_DAYS).filter(
    run => run.shards === 1 && run.files.some(file => E2E_PAYMENT_SPEC.test(file)),
  );
  const samples = runs.map(run => ({ ok: run.status === 'passed', minutes: (run.totalMs ?? Number.NaN) / 60_000 }));
  return stageOf(
    samples,
    median(samples.filter(sample => Number.isFinite(sample.minutes)).map(sample => sample.minutes)),
  );
};

const stagesOf = (ledger: Ledger): Record<string, Stage> => ({
  check: checkStage(ledger),
  unit: stageOf(ledger.logs.unit, median(ledger.logs.unit.map(sample => sample.minutes))),
  lockAhb: stageOf(ledger.logs.lockAhb, median(ledger.logs.lockAhb.map(sample => sample.minutes))),
  e2ePayment: paymentStage(ledger),
});

const unknownStages = (stages: Record<string, Stage>): string[] =>
  Object.entries(stages)
    .filter(([, stage]) => stage.n === 0 || !Number.isFinite(stage.minutes))
    .map(([key]) => key);

const feedbackAxis = (score: number, gaps: Axis['gaps'], raw: Axis['raw']): Axis => ({
  id: 'F',
  name: 'Feedback latency',
  weight: 90,
  score,
  ceiling: score,
  sub: { latency: score / 90 },
  gaps,
  vetoes: [],
  raw,
});

const unknownFeedback = (reason: string, raw: Axis['raw']): Axis =>
  feedbackAxis(0, [gap('F', `feedback latency (unknown: ${reason})`, 90)], raw);

const stageRaw = (stages: Record<string, Stage>) =>
  Object.fromEntries(
    Object.entries(stages).map(([key, stage]) => [
      key,
      { minutes: Number.isFinite(stage.minutes) ? round(stage.minutes, 2) : null, p: round(stage.p, 3), n: stage.n },
    ]),
  );

export const measureFeedback = (ledger: Ledger | null): Axis => {
  if (!ledger) return unknownFeedback('no local ledger; pass --ledger', { ledgerInput: false });
  const stages = stagesOf(ledger);
  const window = { ledgerInput: true, windowDays: FEEDBACK_WINDOW_DAYS, logFilesScanned: ledger.logs.files.length };
  const missing = unknownStages(stages);
  if (missing.length > 0) {
    const reason = `no timed sample for ${missing.join(', ')} in the ${String(FEEDBACK_WINDOW_DAYS)} days before the commit`;
    return unknownFeedback(reason, { ...window, stages: stageRaw(stages), unknownStages: missing });
  }
  const values = Object.values(stages);
  const sumMinutes = values.reduce((sum, stage) => sum + stage.minutes, 0);
  const pAllGreen = values.reduce((product, stage) => product * stage.p, 1);
  const trustMinutes = sumMinutes / pAllGreen;
  const latency = logScore(trustMinutes, 5, 480);
  const gaps = [gap('F', `trustworthy green in ${String(round(trustMinutes))} min (target 5)`, 90 * (1 - latency))];
  const raw = {
    ...window,
    stages: stageRaw(stages),
    sumMinutes: round(sumMinutes, 2),
    pAllGreen: round(pAllGreen, 4),
    expectedMinutesToTrustworthyGreen: round(trustMinutes, 1),
  };
  return feedbackAxis(90 * latency, gaps, raw);
};

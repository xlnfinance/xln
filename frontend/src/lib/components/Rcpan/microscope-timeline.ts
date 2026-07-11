import type { RcpanScenarioId, RcpanScenarioMode } from './microscope-playground';

export type RcpanMicroscopePhase =
  | 'payment'
  | 'signed'
  | 'dispute-open'
  | 'challenge'
  | 'finalizing'
  | 'settled'
  | 'rebalance-request-1'
  | 'rebalance-request-2'
  | 'debt-enforcement'
  | 'repaid';

export type RcpanScenarioDefinition = Readonly<{
  id: RcpanScenarioId;
  index: number;
  label: string;
  shortLabel: string;
  collateralBps: bigint;
  hubShortfallLiquidityBps: bigint;
  phases: readonly RcpanMicroscopePhase[];
}>;

export type RcpanTimelineState = Readonly<{
  scenario: RcpanScenarioDefinition;
  phase: RcpanMicroscopePhase;
  phaseIndex: number;
  phaseProgress: number;
  scenarioProgress: number;
  cycleIndex: number;
  nextPhaseInMs: number;
}>;

const COMMON_PHASES: readonly RcpanMicroscopePhase[] = [
  'payment',
  'signed',
  'dispute-open',
  'challenge',
  'finalizing',
  'settled',
];

export const RCPAN_SCENARIOS: readonly RcpanScenarioDefinition[] = [
  {
    id: 'full-collateral',
    index: 1,
    label: 'Paid entirely from collateral',
    shortLabel: '100% collateral',
    collateralBps: 10_000n,
    hubShortfallLiquidityBps: 10_000n,
    phases: COMMON_PHASES,
  },
  {
    id: 'reserve-backed',
    index: 2,
    label: 'Collateral plus hub reserve',
    shortLabel: '70 / 30',
    collateralBps: 7_000n,
    hubShortfallLiquidityBps: 10_000n,
    phases: COMMON_PHASES,
  },
  {
    id: 'debt-recovery',
    index: 3,
    label: 'Collateral, reserve, then FIFO debt',
    shortLabel: '30 / reserve / debt',
    collateralBps: 3_000n,
    hubShortfallLiquidityBps: 5_000n,
    phases: [
      ...COMMON_PHASES,
      'rebalance-request-1',
      'rebalance-request-2',
      'debt-enforcement',
      'repaid',
    ],
  },
];

const PHASE_WEIGHTS: Readonly<Record<RcpanMicroscopePhase, number>> = {
  payment: 1.15,
  signed: 0.8,
  'dispute-open': 1,
  challenge: 1.05,
  finalizing: 1.1,
  settled: 1.15,
  'rebalance-request-1': 1,
  'rebalance-request-2': 1,
  'debt-enforcement': 1,
  repaid: 1.2,
};

export function microscopePhaseDurationMs(
  phase: RcpanMicroscopePhase,
  baseMs: number,
): number {
  if (!Number.isFinite(baseMs) || baseMs < 200) {
    throw new Error('RCPAN_TIMELINE_INVALID: phaseDurationMs must be at least 200ms');
  }
  return PHASE_WEIGHTS[phase] * baseMs;
}

function scenarioDuration(scenario: RcpanScenarioDefinition, baseMs: number): number {
  return scenario.phases.reduce((sum, phase) => sum + microscopePhaseDurationMs(phase, baseMs), 0);
}

function phaseOffsetMs(
  scenario: RcpanScenarioDefinition,
  target: RcpanMicroscopePhase,
  baseMs: number,
): number {
  let elapsed = 0;
  for (const phase of scenario.phases) {
    if (phase === target) return elapsed;
    elapsed += PHASE_WEIGHTS[phase] * baseMs;
  }
  throw new Error(`RCPAN_TIMELINE_INVALID: ${target} is not part of ${scenario.id}`);
}

function requireTimelineInput(elapsedMs: number, baseMs: number): void {
  if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0) {
    throw new Error('RCPAN_TIMELINE_INVALID: elapsedMs must be a non-negative safe integer');
  }
  if (!Number.isFinite(baseMs) || baseMs < 200) {
    throw new Error('RCPAN_TIMELINE_INVALID: phaseDurationMs must be at least 200ms');
  }
}

function selectedScenarios(mode: RcpanScenarioMode): readonly RcpanScenarioDefinition[] {
  if (mode === 'auto') return RCPAN_SCENARIOS;
  const scenario = RCPAN_SCENARIOS.find(({ id }) => id === mode);
  if (!scenario) throw new Error(`RCPAN_TIMELINE_INVALID: unknown scenario ${String(mode)}`);
  return [scenario];
}

function locateScenario(
  scenarios: readonly RcpanScenarioDefinition[],
  elapsedInCycle: number,
  baseMs: number,
): Readonly<{ scenario: RcpanScenarioDefinition; elapsed: number }> {
  let cursor = elapsedInCycle;
  for (const scenario of scenarios) {
    const duration = scenarioDuration(scenario, baseMs);
    if (cursor < duration) return { scenario, elapsed: cursor };
    cursor -= duration;
  }
  return { scenario: scenarios[scenarios.length - 1]!, elapsed: 0 };
}

function locatePhase(
  scenario: RcpanScenarioDefinition,
  elapsed: number,
  baseMs: number,
): Readonly<{ phase: RcpanMicroscopePhase; phaseIndex: number; elapsed: number; duration: number }> {
  let cursor = elapsed;
  for (let index = 0; index < scenario.phases.length; index += 1) {
    const phase = scenario.phases[index]!;
    const duration = microscopePhaseDurationMs(phase, baseMs);
    if (cursor < duration) return { phase, phaseIndex: index, elapsed: cursor, duration };
    cursor -= duration;
  }
  const phaseIndex = scenario.phases.length - 1;
  const phase = scenario.phases[phaseIndex]!;
  return { phase, phaseIndex, elapsed: 0, duration: microscopePhaseDurationMs(phase, baseMs) };
}

export function deriveMicroscopeTimeline(
  elapsedMs: number,
  baseMs: number,
  mode: RcpanScenarioMode,
): RcpanTimelineState {
  requireTimelineInput(elapsedMs, baseMs);
  const scenarios = selectedScenarios(mode);
  const cycleDuration = scenarios.reduce((sum, scenario) => sum + scenarioDuration(scenario, baseMs), 0);
  const cycleIndex = Math.floor(elapsedMs / cycleDuration);
  const elapsedInCycle = elapsedMs % cycleDuration;
  const locatedScenario = locateScenario(scenarios, elapsedInCycle, baseMs);
  const locatedPhase = locatePhase(locatedScenario.scenario, locatedScenario.elapsed, baseMs);
  return {
    scenario: locatedScenario.scenario,
    phase: locatedPhase.phase,
    phaseIndex: locatedPhase.phaseIndex,
    phaseProgress: locatedPhase.elapsed / locatedPhase.duration,
    scenarioProgress: locatedScenario.elapsed / scenarioDuration(locatedScenario.scenario, baseMs),
    cycleIndex,
    nextPhaseInMs: Math.max(0, locatedPhase.duration - locatedPhase.elapsed),
  };
}

export function scenarioStartMs(
  scenarioId: RcpanScenarioId,
  baseMs: number,
): number {
  let elapsed = 0;
  for (const scenario of RCPAN_SCENARIOS) {
    if (scenario.id === scenarioId) return Math.round(elapsed);
    elapsed += scenarioDuration(scenario, baseMs);
  }
  throw new Error(`RCPAN_TIMELINE_INVALID: unknown scenario ${scenarioId}`);
}

export function phaseStartMs(
  scenarioId: RcpanScenarioId,
  phase: RcpanMicroscopePhase,
  baseMs: number,
  mode: RcpanScenarioMode,
): number {
  requireTimelineInput(0, baseMs);
  const scenario = RCPAN_SCENARIOS.find(({ id }) => id === scenarioId);
  if (!scenario) throw new Error(`RCPAN_TIMELINE_INVALID: unknown scenario ${scenarioId}`);
  if (mode !== 'auto' && mode !== scenarioId) {
    throw new Error(`RCPAN_TIMELINE_INVALID: ${scenarioId} is not selected by ${mode}`);
  }
  const start = mode === 'auto' ? scenarioStartMs(scenarioId, baseMs) : 0;
  return Math.round(start + phaseOffsetMs(scenario, phase, baseMs));
}

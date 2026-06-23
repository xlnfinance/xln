export type QaScenarioPhaseMs = {
  preflight: number;
  anvilBoot: number;
  apiBoot: number;
  apiHealthy: number;
  viteBoot: number;
  playwright: number;
};

export type QaScenarioStep = {
  label: string;
  ms: number;
};

export type QaScenarioShardLike = {
  shard: number;
  status: 'passed' | 'failed' | 'unknown';
  durationMs: number | null;
  handle: string | null;
  description: string | null;
  target: string | null;
  title: string | null;
  phaseMs: QaScenarioPhaseMs | null;
  timelineSteps?: QaScenarioStep[];
  slowSteps: QaScenarioStep[];
};

export type QaScenarioCue = {
  id: string;
  startMs: number;
  endMs: number;
  title: string;
  text: string;
  meta: string;
};

type PhaseKey = keyof QaScenarioPhaseMs;

const SETUP_PHASES: Array<{ key: Exclude<PhaseKey, 'playwright'>; title: string; text: string }> = [
  {
    key: 'preflight',
    title: 'Preflight',
    text: 'Runner validates contracts, inputs, and isolated stack settings.',
  },
  {
    key: 'anvilBoot',
    title: 'Chains',
    text: 'Local jurisdiction chains boot for the browser scenario.',
  },
  {
    key: 'apiBoot',
    title: 'Runtime API',
    text: 'Dedicated runtime API starts for this isolated shard.',
  },
  {
    key: 'apiHealthy',
    title: 'Health Gate',
    text: 'Health endpoint confirms reset, relay, and runtime readiness.',
  },
  {
    key: 'viteBoot',
    title: 'Wallet UI',
    text: 'Frontend wallet is served for Playwright browser control.',
  },
];

const cleanText = (value: string | null | undefined): string =>
  String(value || '')
    .replace(/[_./:-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const capitalize = (value: string): string =>
  value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : value;

const formatMs = (ms: number): string => {
  if (!Number.isFinite(ms) || ms <= 0) return '0ms';
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
};

const pushCue = (
  cues: QaScenarioCue[],
  cursorMs: number,
  durationMs: number,
  title: string,
  text: string,
  meta: string,
): number => {
  const safeDuration = Math.max(900, Math.floor(durationMs));
  const id = `${cues.length}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'cue'}`;
  cues.push({
    id,
    startMs: cursorMs,
    endMs: cursorMs + safeDuration,
    title,
    text,
    meta,
  });
  return cursorMs + safeDuration;
};

export function tenWordScenarioSummary(value: string | null | undefined): string {
  const text = cleanText(value);
  if (!text) return 'No scenario summary recorded';
  const words = text.match(/[A-Za-z0-9$]+(?:'[A-Za-z0-9]+)?/g) ?? [];
  const summary = words.slice(0, 10).join(' ');
  return summary || 'No scenario summary recorded';
}

export function qaScenarioTitle(shard: QaScenarioShardLike): string {
  return capitalize(cleanText(shard.title) || cleanText(shard.handle) || cleanText(shard.target) || `Shard ${shard.shard}`);
}

export function qaScenarioDescription(shard: QaScenarioShardLike): string {
  return capitalize(cleanText(shard.description) || cleanText(shard.title) || cleanText(shard.target) || 'No test description recorded.');
}

export function cleanTimingLabel(label: string): string {
  const withoutPrefix = label.replace(/^(E2E-TIMING|MESH-TIMING):/i, '');
  return cleanText(withoutPrefix);
}

export function buildQaScenarioCues(shard: QaScenarioShardLike): QaScenarioCue[] {
  const cues: QaScenarioCue[] = [];
  let cursorMs = 0;
  const description = qaScenarioDescription(shard);
  cursorMs = pushCue(cues, cursorMs, 1200, 'Scenario', description, shard.handle || `shard-${shard.shard}`);

  const phaseMs = shard.phaseMs;
  if (phaseMs) {
    for (const phase of SETUP_PHASES) {
      const durationMs = Number(phaseMs[phase.key] || 0);
      if (durationMs <= 0) continue;
      cursorMs = pushCue(cues, cursorMs, durationMs, phase.title, phase.text, formatMs(durationMs));
    }
  }

  const steps = (shard.timelineSteps && shard.timelineSteps.length > 0 ? shard.timelineSteps : shard.slowSteps)
    .filter(step => Number.isFinite(step.ms) && step.ms > 0)
    .slice(0, 48);

  if (steps.length > 0) {
    for (const step of steps) {
      const label = cleanTimingLabel(step.label);
      const title = capitalize(tenWordScenarioSummary(label).split(' ').slice(0, 4).join(' ')) || 'Browser Step';
      cursorMs = pushCue(
        cues,
        cursorMs,
        step.ms,
        title,
        `${capitalize(label)} completed in ${formatMs(step.ms)}.`,
        formatMs(step.ms),
      );
    }
  } else if (phaseMs && phaseMs.playwright > 0) {
    cursorMs = pushCue(
      cues,
      cursorMs,
      phaseMs.playwright,
      'Browser Run',
      'Playwright drives the wallet and verifies the scenario outcome.',
      formatMs(phaseMs.playwright),
    );
  }

  pushCue(
    cues,
    cursorMs,
    1200,
    shard.status === 'passed' ? 'Passed' : shard.status === 'failed' ? 'Failed' : 'Finished',
    shard.status === 'passed'
      ? 'Assertions passed and artifacts were captured for review.'
      : shard.status === 'failed'
        ? 'Failure artifacts were captured for inspection.'
        : 'Run completed with unknown shard status.',
    shard.status,
  );
  return cues;
}

export function qaScenarioTimelineMs(cues: QaScenarioCue[]): number {
  return cues.reduce((max, cue) => Math.max(max, cue.endMs), 0);
}

export function qaScenarioCueIndexAt(cues: QaScenarioCue[], positionMs: number): number {
  if (cues.length === 0) return -1;
  const safePosition = Math.max(0, Number.isFinite(positionMs) ? positionMs : 0);
  const index = cues.findIndex(cue => safePosition >= cue.startMs && safePosition < cue.endMs);
  return index >= 0 ? index : cues.length - 1;
}

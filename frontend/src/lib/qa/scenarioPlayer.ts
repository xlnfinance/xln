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
  startMs?: number;
  endMs?: number;
};

export type QaAuthoredScenarioStep = {
  title: string;
  text: string;
  ms?: number;
  startMs?: number;
  endMs?: number;
};

export type QaScenarioMetadata = {
  summary10w: string | null;
  steps: QaAuthoredScenarioStep[];
  owner: string | null;
  severityPolicy: string | null;
};

export type QaScenarioShardLike = {
  shard: number;
  status: 'passed' | 'failed' | 'unknown';
  durationMs: number | null;
  handle: string | null;
  description: string | null;
  scenario?: QaScenarioMetadata | null;
  target: string | null;
  title: string | null;
  error?: string | null;
  logTail?: string | null;
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
  timebase: 'video' | 'synthetic';
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

const cleanScenarioText = (value: string | null | undefined): string =>
  String(value || '').replace(/\s+/g, ' ').trim();

const capitalize = (value: string): string =>
  value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : value;

const formatMs = (ms: number): string => {
  if (!Number.isFinite(ms) || ms <= 0) return '0ms';
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
};

const formatTimeRange = (startMs: number, endMs: number): string =>
  `${formatMs(startMs)}-${formatMs(endMs)}`;

const firstUsefulLine = (value: string | null | undefined): string => {
  const lines = String(value || '').split(/\r?\n/).map(line => cleanText(line)).filter(Boolean);
  return lines.find(line => !/^(\[|at\s|file\s|trace\s)/i.test(line)) ?? lines[0] ?? '';
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
    timebase: 'synthetic',
  });
  return cursorMs + safeDuration;
};

const hasVideoTiming = (step: QaScenarioStep | null | undefined): step is QaScenarioStep => {
  if (!step) return false;
  return Number.isFinite(Number(step.startMs)) &&
    Number.isFinite(Number(step.endMs)) &&
    Number(step.endMs) >= Number(step.startMs);
};

const pushVideoCue = (
  cues: QaScenarioCue[],
  step: QaScenarioStep,
): void => {
  const startMs = Math.max(0, Math.floor(Number(step.startMs ?? 0)));
  const durationMs = Math.max(0, Math.floor(Number(step.ms || 0)));
  const rawEndMs = Math.floor(Number(step.endMs ?? startMs + durationMs));
  const endMs = Math.max(startMs, rawEndMs);
  const label = cleanTimingLabel(step.label);
  const title = capitalize(tenWordScenarioSummary(label).split(' ').slice(0, 4).join(' ')) || 'Browser Step';
  const id = `${cues.length}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'cue'}`;
  cues.push({
    id,
    startMs,
    endMs,
    title,
    text: `${capitalize(label)} completed in ${formatMs(durationMs)}.`,
    meta: `${formatTimeRange(startMs, endMs)} / ${formatMs(durationMs)}`,
    timebase: 'video',
  });
};

const pushAuthoredVideoCue = (
  cues: QaScenarioCue[],
  step: QaAuthoredScenarioStep,
  fallback?: QaScenarioStep,
): boolean => {
  const fallbackStartMs = hasVideoTiming(fallback) ? Number(fallback.startMs) : null;
  const fallbackEndMs = hasVideoTiming(fallback) ? Number(fallback.endMs) : null;
  const startMs = Number.isFinite(Number(step.startMs)) ? Number(step.startMs) : fallbackStartMs;
  const endMs = Number.isFinite(Number(step.endMs)) ? Number(step.endMs) : fallbackEndMs;
  if (startMs === null || endMs === null || endMs < startMs) return false;
  const durationMs = Number.isFinite(Number(step.ms)) ? Number(step.ms) : endMs - startMs;
  const title = cleanScenarioText(step.title) || 'Browser Step';
  const id = `${cues.length}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'cue'}`;
  cues.push({
    id,
    startMs: Math.max(0, Math.floor(startMs)),
    endMs: Math.max(0, Math.floor(endMs)),
    title,
    text: cleanScenarioText(step.text),
    meta: `${formatTimeRange(startMs, endMs)} / ${formatMs(durationMs)}`,
    timebase: 'video',
  });
  return true;
};

const pushFailureCue = (
  cues: QaScenarioCue[],
  shard: QaScenarioShardLike,
): void => {
  const lastCue = cues[cues.length - 1] ?? null;
  const startMs = lastCue ? Math.max(0, lastCue.endMs) : 0;
  const detail = tenWordScenarioSummary(firstUsefulLine(shard.error) || firstUsefulLine(shard.logTail));
  cues.push({
    id: `${cues.length}-failure`,
    startMs,
    endMs: startMs + 1200,
    title: 'Failure',
    text: detail === 'No scenario summary recorded'
      ? 'Failure artifacts were captured for inspection.'
      : detail,
    meta: 'failed',
    timebase: lastCue?.timebase ?? 'synthetic',
  });
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

export function qaScenarioSummary(shard: QaScenarioShardLike): string {
  return cleanScenarioText(shard.scenario?.summary10w) || tenWordScenarioSummary(qaScenarioDescription(shard));
}

export function cleanTimingLabel(label: string): string {
  const withoutPrefix = label.replace(/^(E2E-TIMING|MESH-TIMING):/i, '');
  return cleanText(withoutPrefix);
}

export function buildQaScenarioCues(shard: QaScenarioShardLike): QaScenarioCue[] {
  const cues: QaScenarioCue[] = [];
  let cursorMs = 0;
  const description = qaScenarioDescription(shard);
  const steps = (shard.timelineSteps && shard.timelineSteps.length > 0 ? shard.timelineSteps : shard.slowSteps)
    .filter(step => Number.isFinite(step.ms) && step.ms > 0)
    .slice(0, 48);
  const videoSteps = steps.filter(hasVideoTiming);
  const authoredSteps = (shard.scenario?.steps ?? [])
    .filter(step => cleanScenarioText(step.title) && cleanScenarioText(step.text))
    .slice(0, 48);

  if (videoSteps.length > 0) {
    for (const [index, step] of videoSteps.entries()) {
      const authored = authoredSteps[index] ?? null;
      if (!authored || !pushAuthoredVideoCue(cues, authored, step)) pushVideoCue(cues, step);
    }
    for (const authored of authoredSteps.slice(videoSteps.length)) {
      pushAuthoredVideoCue(cues, authored);
    }
    if (shard.status === 'failed') pushFailureCue(cues, shard);
    return cues;
  }

  cursorMs = pushCue(cues, cursorMs, 1200, 'Scenario', description, shard.handle || `shard-${shard.shard}`);

  if (authoredSteps.length > 0) {
    for (const step of authoredSteps) {
      const durationMs = Number.isFinite(Number(step.ms)) && Number(step.ms) > 0 ? Number(step.ms) : 1200;
      cursorMs = pushCue(
        cues,
        cursorMs,
        durationMs,
        cleanScenarioText(step.title),
        cleanScenarioText(step.text),
        formatMs(durationMs),
      );
    }
  } else {
    const phaseMs = shard.phaseMs;
    if (phaseMs) {
      for (const phase of SETUP_PHASES) {
        const durationMs = Number(phaseMs[phase.key] || 0);
        if (durationMs <= 0) continue;
        cursorMs = pushCue(cues, cursorMs, durationMs, phase.title, phase.text, formatMs(durationMs));
      }
    }

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
  }

  if (shard.status === 'failed') {
    pushFailureCue(cues, shard);
  } else {
    pushCue(
      cues,
      cursorMs,
      1200,
      shard.status === 'passed' ? 'Passed' : 'Finished',
      shard.status === 'passed'
        ? 'Assertions passed and artifacts were captured for review.'
        : 'Run completed with unknown shard status.',
      shard.status,
    );
  }
  return cues;
}

export function qaScenarioTimelineMs(cues: QaScenarioCue[]): number {
  return cues.reduce((max, cue) => Math.max(max, cue.endMs), 0);
}

export function qaScenarioUsesVideoClock(cues: QaScenarioCue[]): boolean {
  return cues.some(cue => cue.timebase === 'video');
}

export function qaScenarioCueIndexAt(cues: QaScenarioCue[], positionMs: number): number {
  if (cues.length === 0) return -1;
  const safePosition = Math.max(0, Number.isFinite(positionMs) ? positionMs : 0);
  const index = cues.findIndex(cue => safePosition >= cue.startMs && safePosition < cue.endMs);
  return index >= 0 ? index : cues.length - 1;
}

export function qaScenarioFailureCueIndex(shard: QaScenarioShardLike, cues: QaScenarioCue[]): number {
  if (shard.status !== 'failed' || cues.length === 0) return -1;
  const explicit = cues.findIndex(cue => cue.title.toLowerCase() === 'failure' || cue.meta === 'failed');
  return explicit >= 0 ? explicit : cues.length - 1;
}

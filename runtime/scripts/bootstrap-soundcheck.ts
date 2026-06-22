#!/usr/bin/env bun

import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

type Mode = 'fresh' | 'template' | 'clone' | 'hydrate' | 'all';

type BootstrapMetrics = {
  schema: 'xln-local-prod-bootstrap-benchmark-v1';
  elapsedMs: number;
  stages: Array<{ stage: string; elapsedMs: number; at: string; details?: unknown }>;
  bootstrapHash: string;
  runtimeStateHash: string;
  entityStateHash: string;
  workDir: string;
  eventsJsonl?: string;
  templateDir?: string;
};

type SoundcheckResult = {
  mode: Exclude<Mode, 'all'>;
  elapsedMs: number;
  bootstrapHash: string;
  runtimeStateHash: string;
  entityStateHash: string;
  workDir: string;
  metricsPath: string;
  eventsJsonl?: string;
};

const repoRoot = process.cwd();

const argValue = (name: string): string | null => {
  const prefix = `--${name}=`;
  return process.argv.find(arg => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
};

const timestampForPath = (): string =>
  new Date().toISOString().replace(/[:.]/g, '-');

const parseMode = (): Mode => {
  const raw = String(argValue('mode') || process.argv[2] || 'all').replace(/^--/, '').trim();
  if (raw === 'fresh' || raw === 'template' || raw === 'clone' || raw === 'hydrate' || raw === 'all') return raw;
  throw new Error(`BOOTSTRAP_SOUNDCHECK_UNKNOWN_MODE:${raw}`);
};

const positiveInteger = (value: string | null, fallback: number): number => {
  const parsed = Number(value ?? '');
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const isHash64 = (value: unknown): value is string =>
  typeof value === 'string' && /^(?:0x)?[a-f0-9]{64}$/i.test(value);

const mode = parseMode();
const outDir = resolve(
  argValue('out-dir') ||
  process.env['XLN_BOOTSTRAP_SOUNDCHECK_DIR'] ||
  join(repoRoot, '.logs', 'bootstrap-soundcheck', timestampForPath()),
);
const templateDir = resolve(
  argValue('template-dir') ||
  process.env['XLN_BOOTSTRAP_TEMPLATE_DIR'] ||
  join(repoRoot, '.logs', 'bootstrap-template', 'current'),
);
const portBase = positiveInteger(argValue('port-base') || process.env['XLN_BOOTSTRAP_SOUNDCHECK_PORT_BASE'] || null, 19700);

const requireMetrics = (metrics: BootstrapMetrics, label: string): void => {
  if (!isHash64(metrics.bootstrapHash)) throw new Error(`BOOTSTRAP_SOUNDCHECK_${label}_BOOTSTRAP_HASH_INVALID`);
  if (!isHash64(metrics.runtimeStateHash)) throw new Error(`BOOTSTRAP_SOUNDCHECK_${label}_RUNTIME_HASH_INVALID`);
  if (!isHash64(metrics.entityStateHash)) throw new Error(`BOOTSTRAP_SOUNDCHECK_${label}_ENTITY_HASH_INVALID`);
  if (!metrics.stages.some(stage => stage.stage === 'system:ready')) {
    throw new Error(`BOOTSTRAP_SOUNDCHECK_${label}_SYSTEM_READY_STAGE_MISSING`);
  }
};

const runSmoke = async (
  label: Exclude<Mode, 'all'>,
  index: number,
  extraEnv: Record<string, string>,
): Promise<SoundcheckResult> => {
  const runDir = label === 'template' ? templateDir : join(outDir, label);
  const metricsPath = join(runDir, 'bootstrap-metrics.json');
  const eventsJsonl = join(runDir, 'bootstrap-events.jsonl');
  const runPortBase = portBase + index * 100;
  console.log(`[bootstrap-soundcheck] mode=${label} portBase=${runPortBase} dir=${runDir}`);
  if (label === 'template' && existsSync(runDir)) rmSync(runDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true });
  await new Promise<void>((resolveRun, rejectRun) => {
    const proc = spawn('bun', ['runtime/scripts/local-prod-smoke.ts'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        XLN_LOCAL_PROD_SMOKE_PORT_BASE: String(runPortBase),
        XLN_LOCAL_PROD_SMOKE_DIR: runDir,
        XLN_LOCAL_PROD_SMOKE_METRICS_JSON: metricsPath,
        XLN_LOCAL_PROD_SMOKE_EVENTS_JSONL: eventsJsonl,
        XLN_LOCAL_PROD_SMOKE_ENFORCE_STAGE_BUDGETS: '1',
        XLN_LOCAL_PROD_SMOKE_POST_BOOTSTRAP_STABILITY_MS:
          process.env['XLN_LOCAL_PROD_SMOKE_POST_BOOTSTRAP_STABILITY_MS'] || '1000',
        ...extraEnv,
      },
      stdio: 'inherit',
    });
    proc.once('error', rejectRun);
    proc.once('exit', (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(new Error(
        `BOOTSTRAP_SOUNDCHECK_SMOKE_FAILED mode=${label} code=${String(code)} signal=${String(signal)} events=${eventsJsonl}`,
      ));
    });
  });
  if (!existsSync(metricsPath)) throw new Error(`BOOTSTRAP_SOUNDCHECK_METRICS_MISSING:${metricsPath}`);
  const metrics = JSON.parse(readFileSync(metricsPath, 'utf8')) as BootstrapMetrics;
  requireMetrics(metrics, label.toUpperCase());
  return {
    mode: label,
    elapsedMs: metrics.elapsedMs,
    bootstrapHash: metrics.bootstrapHash,
    runtimeStateHash: metrics.runtimeStateHash,
    entityStateHash: metrics.entityStateHash,
    workDir: metrics.workDir,
    metricsPath,
    eventsJsonl: metrics.eventsJsonl || eventsJsonl,
  };
};

const installTemplateFromResult = (result: SoundcheckResult): SoundcheckResult => {
  if (!existsSync(result.workDir)) {
    throw new Error(`BOOTSTRAP_SOUNDCHECK_TEMPLATE_SOURCE_MISSING:${result.workDir}`);
  }
  if (existsSync(templateDir)) rmSync(templateDir, { recursive: true, force: true });
  mkdirSync(dirname(templateDir), { recursive: true });
  cpSync(result.workDir, templateDir, { recursive: true });
  return {
    ...result,
    mode: 'template',
    workDir: templateDir,
    metricsPath: join(templateDir, 'bootstrap-metrics.json'),
    eventsJsonl: join(templateDir, 'bootstrap-events.jsonl'),
  };
};

const requireTemplate = (): void => {
  const required = ['anvil-state.json', 'anvil2-state.json', 'prod-main', 'prod-mesh'];
  for (const entry of required) {
    const path = join(templateDir, entry);
    if (!existsSync(path)) {
      throw new Error(`BOOTSTRAP_SOUNDCHECK_TEMPLATE_MISSING:${path}`);
    }
  }
};

const expectedTemplateHashes = (): Pick<BootstrapMetrics, 'bootstrapHash' | 'entityStateHash'> | null => {
  const metricsPath = join(templateDir, 'bootstrap-metrics.json');
  if (!existsSync(metricsPath)) return null;
  const metrics = JSON.parse(readFileSync(metricsPath, 'utf8')) as BootstrapMetrics;
  return isHash64(metrics.bootstrapHash) && isHash64(metrics.entityStateHash)
    ? { bootstrapHash: metrics.bootstrapHash, entityStateHash: metrics.entityStateHash }
    : null;
};

if (existsSync(outDir) && mode === 'all') rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const results: SoundcheckResult[] = [];
let index = 0;
let freshResult: SoundcheckResult | null = null;
if (mode === 'fresh' || mode === 'all') {
  freshResult = await runSmoke('fresh', index++, mode === 'all'
    ? { XLN_MARKET_MAKER_PERSIST_READY_SNAPSHOT: '1' }
    : {});
  results.push(freshResult);
}
if (mode === 'all') {
  if (!freshResult) throw new Error('BOOTSTRAP_SOUNDCHECK_FRESH_RESULT_MISSING');
  results.push(installTemplateFromResult(freshResult));
} else if (mode === 'template') {
  results.push(await runSmoke('template', index++, {
    XLN_MARKET_MAKER_PERSIST_READY_SNAPSHOT: '1',
  }));
}
if (mode === 'clone' || mode === 'all') {
  requireTemplate();
  const templateHashes = expectedTemplateHashes();
  const clone = await runSmoke('clone', index++, {
    XLN_LOCAL_PROD_SMOKE_TEMPLATE_DIR: templateDir,
  });
  if (templateHashes && clone.bootstrapHash !== templateHashes.bootstrapHash) {
    throw new Error(`BOOTSTRAP_SOUNDCHECK_CLONE_HASH_DRIFT template=${templateHashes.bootstrapHash} clone=${clone.bootstrapHash}`);
  }
  if (templateHashes && clone.entityStateHash !== templateHashes.entityStateHash) {
    throw new Error(`BOOTSTRAP_SOUNDCHECK_CLONE_ENTITY_HASH_DRIFT template=${templateHashes.entityStateHash} clone=${clone.entityStateHash}`);
  }
  results.push(clone);
}
if (mode === 'hydrate' || mode === 'all') {
  requireTemplate();
  const templateHashes = expectedTemplateHashes();
  const hydrate = await runSmoke('hydrate', index++, {
    XLN_LOCAL_PROD_SMOKE_TEMPLATE_DIR: templateDir,
    XLN_LOCAL_PROD_SMOKE_MM_INFO_MAX_MS: process.env['XLN_LOCAL_PROD_SMOKE_MM_INFO_MAX_MS'] || '1500',
  });
  if (templateHashes && hydrate.bootstrapHash !== templateHashes.bootstrapHash) {
    throw new Error(`BOOTSTRAP_SOUNDCHECK_HYDRATE_HASH_DRIFT template=${templateHashes.bootstrapHash} hydrate=${hydrate.bootstrapHash}`);
  }
  if (templateHashes && hydrate.entityStateHash !== templateHashes.entityStateHash) {
    throw new Error(`BOOTSTRAP_SOUNDCHECK_HYDRATE_ENTITY_HASH_DRIFT template=${templateHashes.entityStateHash} hydrate=${hydrate.entityStateHash}`);
  }
  results.push(hydrate);
}

const summary = {
  schema: 'xln-bootstrap-soundcheck-summary-v1',
  mode,
  outDir,
  templateDir,
  results,
};
const summaryPath = join(outDir, 'summary.json');
writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(`[bootstrap-soundcheck] summary=${summaryPath}`);
console.log(`[bootstrap-soundcheck] ${JSON.stringify(summary)}`);
console.log('[bootstrap-soundcheck] green');

/**
 * ALL SCENARIOS E2E TEST
 *
 * Runs core scenarios sequentially with a fresh env per run.
 * Optional stress run: SCENARIO_STRESS=1
 * Repeat runs: SCENARIO_ITERS=3
 * Filter: SCENARIO_ONLY=swap-market, SCENARIO_SKIP=grid
 *
 * Run with: bun runtime/scenarios/all-scenarios.ts
 */

import type { Env } from '../types';
import { scenarioRegistry, type ScenarioEntry } from './index';

type ScenarioResult = {
  name: string;
  iteration: number;
  frames: number;
  duration: number;
  status: 'pass' | 'fail' | 'skip';
  error?: string;
};

let _createEmptyEnv: (() => Env) | null = null;
async function getCreateEmptyEnv(): Promise<() => Env> {
  if (!_createEmptyEnv) {
    const runtime = await import('../runtime');
    _createEmptyEnv = runtime.createEmptyEnv;
  }
  return _createEmptyEnv;
}

const isBrowser = typeof window !== 'undefined';
const getEnvVar = (key: string, defaultVal: string) =>
  isBrowser ? defaultVal : (typeof process !== 'undefined' ? process.env[key] || defaultVal : defaultVal);

const iterations = Math.max(1, Number.parseInt(getEnvVar('SCENARIO_ITERS', '1'), 10) || 1);
const includeStress = getEnvVar('SCENARIO_STRESS', '0') === '1';
const onlyScenarioRaw = getEnvVar('SCENARIO_ONLY', '');
const skipScenarioRaw = getEnvVar('SCENARIO_SKIP', '');

const parseList = (value: string) =>
  value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

const onlyScenario = parseList(onlyScenarioRaw);
const skipScenario = new Set(parseList(skipScenarioRaw));

// Auto-filter scenarios based on env vars
const scenariosToRun = scenarioRegistry.filter(s => {
  if (onlyScenario.length > 0) {
    const key = s.key.toLowerCase();
    const name = s.name.toLowerCase();
    return onlyScenario.includes(key) || onlyScenario.includes(name);
  }
  if (skipScenario.has(s.key.toLowerCase()) || skipScenario.has(s.name.toLowerCase())) {
    return false;
  }
  return true;
});

async function runScenario(
  scenario: ScenarioEntry,
  iteration: number,
  results: ScenarioResult[]
): Promise<void> {
  const createEmptyEnv = await getCreateEmptyEnv();
  const env = createEmptyEnv();
  env.scenarioMode = true;

  const start = Date.now();
  try {
    const run = await scenario.load();
    await run(env);
    results.push({
      name: scenario.name,
      iteration,
      frames: env.history?.length || 0,
      duration: Date.now() - start,
      status: 'pass',
    });
  } catch (err: any) {
    results.push({
      name: scenario.name,
      iteration,
      frames: env.history?.length || 0,
      duration: Date.now() - start,
      status: 'fail',
      error: err?.message || String(err),
    });
  }
}

async function runAllScenarios() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('       ALL SCENARIOS E2E TEST - Global Safety Verification     ');
  console.log('═══════════════════════════════════════════════════════════════\n');
  console.log(`Iterations: ${iterations} | Stress: ${includeStress ? 'enabled' : 'off'}\n`);

  const startTime = Date.now();
  const results: ScenarioResult[] = [];

  for (const scenario of scenariosToRun) {
    if (scenario.requiresStress && !includeStress) {
      results.push({
        name: scenario.name,
        iteration: 0,
        frames: 0,
        duration: 0,
        status: 'skip',
        error: 'requires SCENARIO_STRESS=1',
      });
      console.log(`\n📋 ${scenario.name}: SKIPPED`);
      console.log('⚠️  requires SCENARIO_STRESS=1\n');
      continue;
    }
    for (let i = 1; i <= iterations; i++) {
      const label = iterations > 1 ? `${scenario.name} (run ${i}/${iterations})` : scenario.name;
      console.log(`\n📋 ${label}\n`);
      await runScenario(scenario, i, results);
      const last = results[results.length - 1];
      if (last?.status === 'pass') {
        console.log(`✅ ${scenario.name}: ${last.frames} frames in ${last.duration}ms\n`);
      } else if (last?.status === 'fail') {
        console.error(`❌ ${scenario.name} FAILED: ${last.error}\n`);
      }
    }
  }

  const totalDuration = Date.now() - startTime;
  const totalFrames = results.reduce((sum, r) => sum + r.frames, 0);
  const coreRuns = results.filter(r => r.status !== 'skip');
  const passed = coreRuns.filter(r => r.status === 'pass').length;
  const failed = coreRuns.filter(r => r.status === 'fail').length;
  const skipped = results.filter(r => r.status === 'skip').length;

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('                  ALL SCENARIOS E2E RESULTS                    ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  results.forEach(r => {
    const icon = r.status === 'pass' ? '✅' : r.status === 'fail' ? '❌' : '⚠️';
    const iterLabel = r.iteration > 0 && iterations > 1 ? ` #${r.iteration}` : '';
    const time = (r.duration / 1000).toFixed(1);
    console.log(`${icon} ${r.name}${iterLabel}`.padEnd(26) + `${r.frames.toString().padStart(4)} frames  ${time.padStart(6)}s`);
    if (r.error) {
      console.log(`   ${r.error}`);
    }
  });

  console.log('\n' + '─'.repeat(63));
  console.log(`   TOTAL: ${totalFrames} frames in ${(totalDuration / 1000).toFixed(1)}s`);
  console.log(`   PASSED: ${passed}/${coreRuns.length} runs`);
  console.log(`   SKIPPED: ${skipped} scenario(s)`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  if (failed > 0) {
    throw new Error(`${failed} scenario runs failed - see errors above`);
  }

  console.log('🎉 ALL CORE SCENARIOS PASSED - Global safety verified!\n');
}

// Self-executing
if (import.meta.main) {
  await runAllScenarios();
}

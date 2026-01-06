/**
 * ALL SCENARIOS E2E TEST
 *
 * Runs core scenarios sequentially with a fresh env per run.
 * Optional stress run: SCENARIO_STRESS=1
 * Repeat runs: SCENARIO_ITERS=3
 *
 * Run with: bun runtime/scenarios/all-scenarios.ts
 */

import type { Env } from '../types';

type ScenarioSpec = {
  name: string;
  load?: () => Promise<(env: Env) => Promise<void>>;
  skipReason?: string;
};

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

const iterations = Math.max(1, Number.parseInt(process.env.SCENARIO_ITERS ?? '1', 10) || 1);
const includeStress = process.env.SCENARIO_STRESS === '1';

const scenarios: ScenarioSpec[] = [
  { name: 'AHB', load: async () => (await import('./ahb')).ahb },
  { name: 'HTLC AHB', load: async () => (await import('./lock-ahb')).lockAhb },
  { name: 'HTLC 4-Hop', load: async () => (await import('./htlc-4hop')).test4HopHtlc },
  { name: 'Swap Trading', load: async () => (await import('./swap')).swap },
  { name: 'Swap Market', load: async () => (await import('./swap-market')).swapMarket },
  { name: 'Grid', load: async () => (await import('./grid')).grid },
];

if (includeStress) {
  scenarios.push({ name: 'Rapid Fire', load: async () => (await import('./rapid-fire')).rapidFire });
} else {
  scenarios.push({ name: 'Rapid Fire', skipReason: 'known throughput limit (enable with SCENARIO_STRESS=1)' });
}

async function runScenario(
  spec: ScenarioSpec,
  iteration: number,
  results: ScenarioResult[]
): Promise<void> {
  if (spec.skipReason || !spec.load) {
    results.push({
      name: spec.name,
      iteration: 0,
      frames: 0,
      duration: 0,
      status: 'skip',
      error: spec.skipReason,
    });
    return;
  }

  const createEmptyEnv = await getCreateEmptyEnv();
  const run = await spec.load();
  const env = createEmptyEnv();
  env.scenarioMode = true;

  const start = Date.now();
  try {
    await run(env);
    results.push({
      name: spec.name,
      iteration,
      frames: env.history?.length || 0,
      duration: Date.now() - start,
      status: 'pass',
    });
  } catch (err: any) {
    results.push({
      name: spec.name,
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

  for (const spec of scenarios) {
    if (spec.skipReason) {
      console.log(`\n📋 ${spec.name}: SKIPPED`);
      console.log(`⚠️  ${spec.skipReason}\n`);
      await runScenario(spec, 0, results);
      continue;
    }

    for (let i = 1; i <= iterations; i++) {
      const label = iterations > 1 ? `${spec.name} (run ${i}/${iterations})` : spec.name;
      console.log(`\n📋 ${label}\n`);
      await runScenario(spec, i, results);
      const last = results[results.length - 1];
      if (last?.status === 'pass') {
        console.log(`✅ ${spec.name}: ${last.frames} frames in ${last.duration}ms\n`);
      } else if (last?.status === 'fail') {
        console.error(`❌ ${spec.name} FAILED: ${last.error}\n`);
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

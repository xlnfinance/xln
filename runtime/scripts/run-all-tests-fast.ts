/**
 * One-command fast test suite:
 * - scenario suite (parallel, isolated)
 * - playwright e2e suite (parallel, isolated)
 *
 * Both run concurrently in separate isolated stacks.
 *
 * Usage:
 *   bun runtime/scripts/run-all-tests-fast.ts
 *   bun runtime/scripts/run-all-tests-fast.ts --scenario-workers=3 --e2e-shards=2
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

type CliArgs = {
  scenarioWorkers: number;
  e2eShards: number;
  smoke: boolean;
  quick: boolean;
  skipBuild: boolean;
};

const parseArgs = (): CliArgs => {
  const args = process.argv.slice(2);
  const getFlag = (name: string): string | undefined => {
    const eq = args.find(a => a.startsWith(`--${name}=`));
    if (eq) return eq.split('=')[1];
    const i = args.findIndex(a => a === `--${name}`);
    if (i >= 0 && i + 1 < args.length) {
      const next = args[i + 1];
      if (next && !next.startsWith('--')) return next;
    }
    return undefined;
  };

  const scenarioWorkersRaw = Number(getFlag('scenario-workers') || '3');
  const e2eShardsRaw = Number(getFlag('e2e-shards') || '2');

  return {
    scenarioWorkers: Number.isFinite(scenarioWorkersRaw) && scenarioWorkersRaw > 0 ? Math.floor(scenarioWorkersRaw) : 3,
    e2eShards: Number.isFinite(e2eShardsRaw) && e2eShardsRaw > 0 ? Math.floor(e2eShardsRaw) : 2,
    smoke: args.includes('--smoke'),
    quick: args.includes('--quick'),
    skipBuild: args.includes('--skip-build'),
  };
};

type JobResult = {
  name: string;
  code: number | null;
};

const runJob = async (name: string, cmd: string, args: string[]): Promise<JobResult> => {
  const proc: ChildProcessWithoutNullStreams = spawn(cmd, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  proc.stdout.on('data', chunk => process.stdout.write(`[${name}] ${chunk.toString()}`));
  proc.stderr.on('data', chunk => process.stderr.write(`[${name}] ${chunk.toString()}`));

  const code = await new Promise<number | null>((resolve, reject) => {
    proc.once('error', reject);
    proc.once('exit', resolve);
  });

  return { name, code };
};

async function main(): Promise<void> {
  const args = parseArgs();
  console.log('\n' + '='.repeat(72));
  console.log('Fast Full Suite (parallel + isolated)');
  console.log('='.repeat(72));
  console.log(`Scenario workers: ${args.scenarioWorkers}`);
  console.log(`E2E shards      : ${args.e2eShards}`);
  const modeLabel = args.quick ? 'quick' : args.smoke ? 'smoke' : 'full';
  console.log(`Mode            : ${modeLabel}`);
  console.log('='.repeat(72) + '\n');

  const startedAt = Date.now();

  const scenarioPromise = runJob(
    'scenarios',
    'bun',
    [
      'runtime/scenarios/run.ts',
      `--workers=${args.scenarioWorkers}`,
      ...(args.quick || args.smoke ? ['--set=smoke'] : []),
    ],
  );

  const e2eArgs = ['runtime/scripts/run-e2e-parallel-isolated.ts', `--shards=${args.e2eShards}`];
  if (args.skipBuild) e2eArgs.push('--skip-build');
  if (args.quick || args.smoke) {
    // One critical rebalance assertion path for sub-minute feedback.
    e2eArgs.push('--pw-project=chromium');
    e2eArgs.push('--pw-files=tests/e2e-rebalance-bar.spec.ts');
    e2eArgs.push('--pw-grep=faucet -> request_collateral -> secured bar');
  }

  const e2ePromise = runJob(
    'e2e',
    'bun',
    e2eArgs,
  );

  const [scenarioResult, e2eResult] = await Promise.all([scenarioPromise, e2ePromise]);
  const totalMs = Date.now() - startedAt;

  console.log('\n' + '='.repeat(72));
  console.log('Fast Suite Summary');
  console.log('='.repeat(72));
  console.log(`scenarios: exit=${scenarioResult.code}`);
  console.log(`e2e      : exit=${e2eResult.code}`);
  console.log(`wall time: ${(totalMs / 1000).toFixed(1)}s`);
  console.log('='.repeat(72));

  const ok = scenarioResult.code === 0 && e2eResult.code === 0;
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('Fast suite runner failed:', (err as Error).message);
  process.exit(1);
});

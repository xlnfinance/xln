/**
 * CLI runner for scenarios — configurable backend (browservm | rpc)
 *
 * Usage:
 *   bun core/scenarios/run.ts                             # PARALLEL: run full scenario set
 *   bun core/scenarios/run.ts all                         # PARALLEL: same as above
 *   bun core/scenarios/run.ts lock-ahb                    # SINGLE: one scenario
 *   bun core/scenarios/run.ts lock-ahb --mode=rpc         # SINGLE: explicit mode
 *   bun core/scenarios/run.ts lock-ahb --mode=rpc --rpc=http://127.0.0.1:18545
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import {
  cleanupTestArtifactsBeforeRun,
  TEST_ARTIFACT_CLEANUP_DONE_ENV,
} from '../scripts/e2e/harness/test-artifact-cleanup';
import {
  assertBroadRunHasNoUnresolvedReruns,
  recordSelectiveRerunFailure,
  recordSelectiveRerunPass,
} from '../scripts/e2e/harness/selective-rerun/ledger';
import { computeRepositoryCodeFingerprint } from '../qa/tools/code-fingerprint';
import {
  acquireLocalTestPortLease,
  type LocalTestPortLease,
} from '../scripts/e2e/harness/local-test-port-lease';
import { stopProcessGroup } from '../scripts/e2e/runners/process-group';
import {
  assertScenarioRpcOutsideDev,
  buildScenarioIsolatedEnv,
} from './harness/scenario-isolation';

type PipedChildProcess = ChildProcessByStdio<null, Readable, Readable>;
const SCENARIO_PORT_OFFSETS = [0, 1, 2, 3, 4] as const;

type ScenarioEntry = {
  file: string;
  fn: string;
  provePersistence?: boolean;
};

const SCENARIOS: Record<string, ScenarioEntry> = {
  'rebalance': { file: './settlement/rebalance', fn: 'runRebalanceScenario' },
  'lock-ahb':  { file: './payments/lock-ahb',  fn: 'lockAhb' },
  'ahb':       { file: './consensus/ahb',       fn: 'ahb' },
  'swap':      { file: './market/swap',      fn: 'runSwapScenario' },
  'settle':    { file: './settlement/settle',    fn: 'runSettleScenario' },
  'htlc-4hop': { file: './payments/htlc-4hop', fn: 'htlc4hop' },
  'grid':              { file: './consensus/grid',              fn: 'grid' },
  'swap-market':       { file: './market/swap-market',       fn: 'swapMarket' },
  'swap-tps':          { file: './market/swap-tps',          fn: 'swapTps' },
  'multi-sig':         { file: './consensus/multi-sig',         fn: 'multiSig' },
  'company-ipo':       { file: './company-ipo', fn: 'companyIpo', provePersistence: true },
  'rapid-fire':        { file: './consensus/rapid-fire',        fn: 'rapidFire' },
  'settle-rebalance':  { file: './settlement/settle-rebalance',  fn: 'runSettleRebalance' },
  'processbatch':      { file: './settlement/processbatch',      fn: 'runProcessBatchScenario' },
  'dispute-lifecycle': { file: './disputes/lifecycle', fn: 'runDisputeLifecycle' },
  'dispute-transformer': { file: './disputes/transformer', fn: 'runDisputeTransformer' },
  'cross-j':           { file: './cross-j',           fn: 'crossJ' },
  'mm-mesh':           { file: './cross-j/mm-mesh',           fn: 'mmMesh' },
};

const DEFAULT_PARALLEL_SET = [
  'processbatch',
  'rebalance',
  'settle-rebalance',
  'swap-tps',
  'lock-ahb',
  'dispute-lifecycle',
  'dispute-transformer',
];

// company-ipo stays in ALL: BOARD_HANDOVER_ACTIVATION_CHAIN_INVALID is a real
// invariant, not a scenario skip. Exact-rerun it before putting it back in default.
const ALL_PARALLEL_SET = [
  'processbatch',
  'rebalance',
  'settle-rebalance',
  'lock-ahb',
  'dispute-lifecycle',
  'dispute-transformer',
  'ahb',
  'swap',
  'settle',
  'htlc-4hop',
  'grid',
  'swap-market',
  'swap-tps',
  'multi-sig',
  'company-ipo',
  'rapid-fire',
];

const SMOKE_PARALLEL_SET = [
  'processbatch',
  'rebalance',
  'dispute-lifecycle',
  'dispute-transformer',
  'swap-tps',
  'multi-sig',
];

const resolveParallelSet = (setName?: string): readonly string[] => {
  const set = (setName || process.env['SCENARIO_SET'] || 'full').toLowerCase();
  if (set === 'smoke') return SMOKE_PARALLEL_SET;
  if (set === 'all' || set === 'everything' || set === 'full-catalog') return ALL_PARALLEL_SET;
  return DEFAULT_PARALLEL_SET;
};

const unique = <T>(items: T[]): T[] => Array.from(new Set(items));

const tsTag = (): string => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${ms}`;
};

function parseArgs(): {
  scenario?: string;
  mode?: string;
  rpc?: string;
  workers?: number;
  set?: string;
  single: boolean;
} {
  const args = process.argv.slice(2);
  const scenario = args.find(a => !a.startsWith('--'));

  const getFlag = (name: string): string | undefined => {
    const eqArg = args.find(a => a.startsWith(`--${name}=`));
    if (eqArg) return eqArg.split('=')[1];
    const idx = args.findIndex(a => a === `--${name}`);
    if (idx >= 0 && idx + 1 < args.length) {
      const value = args[idx + 1];
      if (value && !value.startsWith('--')) return value;
    }
    return undefined;
  };

  const workersRaw = getFlag('workers');
  const workers = workersRaw ? Number(workersRaw) : undefined;

  const parsed: {
    scenario?: string;
    mode?: string;
    rpc?: string;
    workers?: number;
    set?: string;
    single: boolean;
  } = { single: args.includes('--single') };
  if (scenario !== undefined) parsed.scenario = scenario;
  const mode = getFlag('mode');
  if (mode !== undefined) parsed.mode = mode;
  const rpc = getFlag('rpc');
  if (rpc !== undefined) parsed.rpc = rpc;
  if (Number.isFinite(workers as number)) parsed.workers = Math.max(1, Math.floor(workers as number));
  const set = getFlag('set');
  if (set !== undefined) parsed.set = set;
  return parsed;
}

function tail(path: string, lines = 60): string {
  try {
    const text = readFileSync(path, 'utf8');
    const chunks = text.split('\n');
    return chunks.slice(-lines).join('\n');
  } catch (error) {
    return `(unable to read log tail: ${error instanceof Error ? error.message : String(error)})`;
  }
}

async function stopProcess(proc: PipedChildProcess | null): Promise<void> {
  if (!proc || !proc.pid) return;
  await stopProcessGroup({
    pid: proc.pid,
    termTimeoutMs: 4_000,
    killTimeoutMs: 1_000,
    timeoutError: `SCENARIO_PROCESS_GROUP_STOP_TIMEOUT:${proc.pid}`,
  });
}

const verifyScenarioPersistence = async (
  env: import('../runtime/types').RuntimeReplica,
  scenario: string,
): Promise<void> => {
  const { closeInfraDb, closeRuntimeDb, getLiveJAdapterEntries, loadEnvFromDB } = await import('../runtime');
  const {
    computeCanonicalEntityHashesFromEnv,
    computeCanonicalStateHashFromEnv,
  } = await import('../storage/canonical-hash');
  const { buildDurableRuntimeMachineSnapshot } = await import('../storage/wal/snapshot');
  const { buildRuntimeStateDiffReport } = await import('../qa/tools/runtime-state-diff');
  const { safeStringify } = await import('../protocol/serialization');
  const expected = computeCanonicalStateHashFromEnv(env);
  await Promise.all(getLiveJAdapterEntries(env).map(({ adapter }) => adapter.stopWatchingAndWait()));
  await closeRuntimeDb(env);
  await closeInfraDb(env);
  const restored = await loadEnvFromDB(env.runtimeId, env.runtimeSeed);
  if (!restored) throw new Error(`SCENARIO_RECOVERY_MISSING:${scenario}`);
  try {
    const actual = computeCanonicalStateHashFromEnv(restored);
    if (actual !== expected) {
      const entityDiff = buildRuntimeStateDiffReport(
        computeCanonicalEntityHashesFromEnv(env),
        computeCanonicalEntityHashesFromEnv(restored),
      );
      const runtimeDiff = buildRuntimeStateDiffReport(
        buildDurableRuntimeMachineSnapshot(env),
        buildDurableRuntimeMachineSnapshot(restored),
      );
      throw new Error(
        `SCENARIO_RECOVERY_ROOT_MISMATCH:${scenario}:expected=${expected}:actual=${actual}:` +
        `liveHeight=${env.state.height}:restoredHeight=${restored.state.height}:` +
        `liveTimestamp=${env.state.timestamp}:restoredTimestamp=${restored.state.timestamp}:` +
        `entity=${safeStringify(entityDiff.firstDifference)}:` +
        `runtime=${safeStringify(runtimeDiff.firstDifference)}`,
      );
    }
    console.log(`SCENARIO_RECOVERY_PASS:${scenario}:height=${restored.state.height}:root=${actual}`);
  } finally {
    await closeRuntimeDb(restored);
    await closeInfraDb(restored);
  }
};

type ParallelResult = {
  scenario: string;
  workerId: number;
  status: 'passed' | 'failed';
  durationMs: number;
  logPath: string;
  error?: string;
};

const acquireScenarioLeases = async (count: number): Promise<LocalTestPortLease[]> => {
  const leases: LocalTestPortLease[] = [];
  try {
    for (let index = 0; index < count; index += 1) {
      leases.push(await acquireLocalTestPortLease({
        requiredOffsets: SCENARIO_PORT_OFFSETS,
        timeoutMs: 25_000,
      }));
    }
    return leases;
  } catch (error) {
    for (const lease of leases) lease.release();
    throw error;
  }
};

async function runParallelScenarios(mode: string, workersArg?: number, setName?: string): Promise<number> {
  cleanupTestArtifactsBeforeRun({ reason: 'scenarios', argv: process.argv.slice(2) });
  const set = (setName || process.env['SCENARIO_SET'] || 'full').toLowerCase();
  const scenarios = resolveParallelSet(setName).filter(s => SCENARIOS[s]);
  if (scenarios.length === 0) {
    console.error('No scenarios configured for parallel run');
    return 1;
  }

  const workers = Math.min(workersArg ?? scenarios.length, scenarios.length);
  const logsDir = resolve(process.cwd(), '.logs', 'scenarios-parallel', tsTag());
  mkdirSync(logsDir, { recursive: true });
  const leases = await acquireScenarioLeases(workers);

  console.log('\n' + '='.repeat(72));
  console.log('Parallel Scenario Runner (isolated RPC per worker; in-memory gossip)');
  console.log('='.repeat(72));
  console.log(`Set       : ${set}`);
  console.log(`Mode      : ${mode}`);
  console.log(`Scenarios : ${scenarios.join(', ')}`);
  console.log(`Workers   : ${workers}`);
  console.log(`Logs      : ${logsDir}`);
  console.log('='.repeat(72) + '\n');

  let next = 0;
  const results: ParallelResult[] = [];

  const runOne = async (
    scenario: string,
    workerId: number,
    lease: LocalTestPortLease,
  ): Promise<ParallelResult> => {
    const startedAt = Date.now();
    const logPath = join(logsDir, `${String(workerId).padStart(2, '0')}-${scenario}.log`);
    const log = createWriteStream(logPath, { flags: 'w' });
    let scenarioProc: PipedChildProcess | null = null;

    try {
      const rpcUrl = `http://127.0.0.1:${lease.basePort}`;
      const dbPath = join(logsDir, `db-worker-${workerId}-${scenario}`);
      mkdirSync(dbPath, { recursive: true });

      log.write(`scenario=${scenario}\nworker=${workerId}\nrpc=${rpcUrl}\nnetwork=in-memory-gossip\n\n`);

      scenarioProc = spawn('bun', [
        'core/scenarios/run.ts',
        scenario,
        `--mode=${mode}`,
        `--rpc=${rpcUrl}`,
        '--single',
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        env: {
          ...buildScenarioIsolatedEnv(process.env, dbPath, rpcUrl),
          [TEST_ARTIFACT_CLEANUP_DONE_ENV]: '1',
          JADAPTER_MODE: mode,
          XLN_ENTITY_STATE_ROOT_AUDIT: '1',
          XLN_SCENARIO_DB_ROOT: dbPath,
          XLN_SCENARIO_LEASE_BASE: String(lease.basePort),
        },
      });

      const activeScenarioProc = scenarioProc;
      activeScenarioProc.stdout.on('data', (c) => log.write(c.toString()));
      activeScenarioProc.stderr.on('data', (c) => log.write(c.toString()));

      const code = await new Promise<number | null>((resolveExit, rejectExit) => {
        activeScenarioProc.once('error', rejectExit);
        activeScenarioProc.once('exit', resolveExit);
      });

      if (code !== 0) {
        return {
          scenario,
          workerId,
          status: 'failed',
          durationMs: Date.now() - startedAt,
          logPath,
          error: `exit_code_${code}`,
        };
      }

      return {
        scenario,
        workerId,
        status: 'passed',
        durationMs: Date.now() - startedAt,
        logPath,
      };
    } catch (error) {
      return {
        scenario,
        workerId,
        status: 'failed',
        durationMs: Date.now() - startedAt,
        logPath,
        error: (error as Error).message,
      };
    } finally {
      await stopProcess(scenarioProc);
      log.end();
    }
  };

  const workerLoop = async (workerId: number) => {
    while (true) {
      const idx = next++;
      if (idx >= scenarios.length) return;
      const scenario = scenarios[idx]!;
      console.log(`▶️  [worker ${workerId}] ${scenario}`);
      const lease = leases[workerId];
      if (!lease) throw new Error(`SCENARIO_WORKER_LEASE_MISSING:${workerId}`);
      const result = await runOne(scenario, workerId, lease);
      results.push(result);
      const seconds = (result.durationMs / 1000).toFixed(1);
      if (result.status === 'passed') {
        console.log(`✅ [worker ${workerId}] ${scenario} passed in ${seconds}s`);
      } else {
        console.log(`❌ [worker ${workerId}] ${scenario} failed in ${seconds}s (${result.error || 'unknown'})`);
      }
    }
  };

  const startedAt = Date.now();
  try {
    await Promise.all(Array.from({ length: workers }, (_, i) => workerLoop(i)));
  } finally {
    for (const lease of leases) lease.release();
  }
  const totalMs = Date.now() - startedAt;

  const ordered = scenarios.map(name => results.find(r => r.scenario === name)).filter(Boolean) as ParallelResult[];
  const failed = ordered.filter(r => r.status === 'failed');

  console.log('\n' + '='.repeat(72));
  console.log('Summary');
  console.log('='.repeat(72));
  for (const r of ordered) {
    const sec = (r.durationMs / 1000).toFixed(1);
    console.log(`${r.status === 'passed' ? 'PASS' : 'FAIL'}  ${r.scenario.padEnd(18)} ${sec.padStart(8)}s worker=${r.workerId}`);
  }
  console.log('-'.repeat(72));
  console.log(`Total wall time: ${(totalMs / 1000).toFixed(1)}s`);
  console.log(`Logs: ${logsDir}`);

  if (failed.length > 0) {
    for (const f of failed) {
      console.log(`\n--- ${f.scenario} (tail: ${f.logPath}) ---`);
      console.log(tail(f.logPath, 60));
    }
    return 1;
  }
  return 0;
}

async function main() {
  if (process.argv.slice(2).some(argument => argument === '--help' || argument === '-h')) {
    console.log('Usage: bun core/scenarios/run.ts [all|<scenario>] [--mode=browservm|rpc] [--rpc=URL] [--workers=N] [--single]');
    console.log(`\nAvailable scenarios: ${unique(Object.keys(SCENARIOS)).join(', ')}`);
    return;
  }
  const { scenario, mode, rpc, workers, set, single } = parseArgs();

  const requestedMode = (mode || process.env['JADAPTER_MODE'] || 'rpc').toLowerCase();
  const runAll = !single && (!scenario || scenario === 'all');

  if (runAll) {
    const selected = resolveParallelSet(set).filter(name => SCENARIOS[name]);
    assertBroadRunHasNoUnresolvedReruns(undefined, { kind: 'scenario', targets: selected });
    const code = await runParallelScenarios(requestedMode, workers, set);
    process.exit(code);
  }

  if (!scenario) {
    console.log('Usage: bun core/scenarios/run.ts [all|<scenario>] [--mode=browservm|rpc] [--rpc=URL] [--workers=N]');
    console.log(`\nAvailable scenarios: ${unique(Object.keys(SCENARIOS)).join(', ')}`);
    process.exit(1);
  }

  const entry = SCENARIOS[scenario];
  if (!entry) {
    console.error(`Unknown scenario: "${scenario}". Available: ${Object.keys(SCENARIOS).join(', ')}`);
    process.exit(1);
  }

  cleanupTestArtifactsBeforeRun({ reason: 'scenario', argv: process.argv.slice(2) });
  process.env[TEST_ARTIFACT_CLEANUP_DONE_ENV] = '1';
  process.env['XLN_ENTITY_STATE_ROOT_AUDIT'] = '1';

  // Set env vars — scenarios read these via getJAdapterMode() / ensureJAdapter()
  if (mode) process.env['JADAPTER_MODE'] = mode;

  let ownedLease: LocalTestPortLease | null = null;
  let effectiveRpc = rpc;
  if (requestedMode !== 'browservm' && !effectiveRpc) {
    ownedLease = await acquireLocalTestPortLease({ requiredOffsets: SCENARIO_PORT_OFFSETS, timeoutMs: 25_000 });
    effectiveRpc = `http://127.0.0.1:${ownedLease.basePort}`;
    process.env['XLN_SCENARIO_LEASE_BASE'] = String(ownedLease.basePort);
  }
  if (effectiveRpc) assertScenarioRpcOutsideDev(effectiveRpc);
  const assignedLeaseBase = Number(process.env['XLN_SCENARIO_LEASE_BASE']);
  if (process.env['XLN_SCENARIO_LEASE_BASE'] !== undefined) {
    const assignedPort = effectiveRpc ? Number(new URL(effectiveRpc).port) : NaN;
    if (
      !Number.isSafeInteger(assignedLeaseBase) ||
      !Number.isSafeInteger(assignedPort) ||
      assignedPort < assignedLeaseBase ||
      assignedPort > assignedLeaseBase + 2
    ) throw new Error(`SCENARIO_ASSIGNED_LEASE_MISMATCH:${String(effectiveRpc)}`);
  }
  const assignedDbRoot = String(process.env['XLN_SCENARIO_DB_ROOT'] || '').trim();
  const dbPath = assignedDbRoot
    ? resolve(assignedDbRoot)
    : resolve(process.cwd(), '.logs', 'scenarios-single', tsTag(), scenario, 'db');
  mkdirSync(dbPath, { recursive: true });
  process.env['XLN_SCENARIO_DB_ROOT'] = dbPath;
  Object.assign(process.env, buildScenarioIsolatedEnv(process.env, dbPath, effectiveRpc ?? null));

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Scenario: ${scenario}`);
  console.log(`  Mode: ${mode || process.env['JADAPTER_MODE'] || 'rpc'}`);
  if (effectiveRpc) console.log(`  RPC: ${effectiveRpc}`);
  console.log(`${'='.repeat(60)}\n`);

  const codeHash = computeRepositoryCodeFingerprint().codeHash;
  try {
    // Create fresh env — scenario self-boots from here
    const { createEmptyEnv } = await import('../runtime');
    const env = createEmptyEnv(`${scenario}-cli-seed-42`);

    // Dynamic import and run
    const mod = await import(entry.file);
    const fn = mod[entry.fn];
    if (!fn) throw new Error(`SCENARIO_FUNCTION_MISSING:${entry.fn}:${entry.file}`);

    await fn(env);
    if (entry.provePersistence) await verifyScenarioPersistence(env, scenario);
    recordSelectiveRerunPass('scenario', scenario);

    console.log(`\n${'='.repeat(60)}`);
    console.log(`  ${scenario} COMPLETE`);
    console.log(`  Frames: ${env.state.height}`);
    console.log(`${'='.repeat(60)}\n`);
    return;
  } catch (error) {
    recordSelectiveRerunFailure({
      kind: 'scenario',
      target: scenario,
      failedCodeHash: codeHash,
      failedAt: new Date().toISOString(),
      reason: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
    });
    throw error;
  } finally {
    const { stopManagedScenarioAnvil } = await import('./harness/boot');
    await stopManagedScenarioAnvil();
    ownedLease?.release();
  }
}

main().then(() => {
  // Every owned process and port lease has already been released by main's
  // finally block. Scenario adapters may retain diagnostic poll timers; those
  // must not outlive a successful CLI gate or contend with the next stand.
  process.exit(0);
}).catch((error: unknown) => {
  const details = error instanceof Error
    ? `${error.name}: ${error.message}\n${error.stack ?? '(no stack)'}`
    : String(error);
  console.error('\nScenario FAILED:', details);
  process.exit(1);
});

/**
 * CLI runner for scenarios — configurable backend (browservm | rpc)
 *
 * Usage:
 *   bun runtime/scenarios/run.ts                             # PARALLEL: run full scenario set
 *   bun runtime/scenarios/run.ts all                         # PARALLEL: same as above
 *   bun runtime/scenarios/run.ts lock-ahb                    # SINGLE: one scenario
 *   bun runtime/scenarios/run.ts lock-ahb --mode=rpc         # SINGLE: explicit mode
 *   bun runtime/scenarios/run.ts lock-ahb --mode=rpc --rpc=http://127.0.0.1:18545
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const SCENARIOS: Record<string, { file: string; fn: string }> = {
  'rebalance': { file: './rebalance', fn: 'runRebalanceScenario' },
  'lock-ahb':  { file: './lock-ahb',  fn: 'lockAhb' },
  'ahb':       { file: './ahb',       fn: 'ahb' },
  'swap':      { file: './swap',      fn: 'swap' },
  'settle':    { file: './settle',    fn: 'runSettleScenario' },
  'htlc-4hop': { file: './htlc-4hop', fn: 'htlc4hop' },
  'grid':              { file: './grid',              fn: 'grid' },
  'settle-rebalance':  { file: './settle-rebalance',  fn: 'runSettleRebalance' },
  'processbatch':      { file: './processbatch',      fn: 'runProcessBatchScenario' },
  'process-batch':     { file: './processbatch',      fn: 'runProcessBatchScenario' },
  'dispute-lifecycle': { file: './dispute-lifecycle', fn: 'runDisputeLifecycle' },
};

const DEFAULT_PARALLEL_SET = [
  'processbatch',
  'rebalance',
  'settle-rebalance',
  'lock-ahb',
  'dispute-lifecycle',
];

const SMOKE_PARALLEL_SET = [
  'rebalance',
  'dispute-lifecycle',
];

async function reserveFreeLocalPort(): Promise<number> {
  const { createServer } = await import('node:net');
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close(() => reject(new Error('Failed to reserve local RPC port')));
        return;
      }
      const port = addr.port;
      server.close(err => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

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

  return {
    scenario,
    mode: getFlag('mode'),
    rpc: getFlag('rpc'),
    workers: Number.isFinite(workers as number) ? Math.max(1, Math.floor(workers as number)) : undefined,
    set: getFlag('set'),
    single: args.includes('--single'),
  };
}

function tail(path: string, lines = 60): string {
  try {
    const text = readFileSync(path, 'utf8');
    const chunks = text.split('\n');
    return chunks.slice(-lines).join('\n');
  } catch {
    return '(unable to read log tail)';
  }
}

async function stopProcess(proc: ChildProcessWithoutNullStreams | null): Promise<void> {
  if (!proc || proc.exitCode !== null) return;
  proc.kill('SIGTERM');
  const deadline = Date.now() + 4000;
  while (proc.exitCode === null && Date.now() < deadline) {
    await delay(100);
  }
  if (proc.exitCode === null) proc.kill('SIGKILL');
}

async function waitRelayReady(proc: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`relay startup timeout (${timeoutMs}ms)`));
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      if (text.includes('listening on')) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      }
    };
    const onExit = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`relay exited early (code=${code})`));
    };

    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.once('exit', onExit);
  });
}

type ParallelResult = {
  scenario: string;
  workerId: number;
  status: 'passed' | 'failed';
  durationMs: number;
  logPath: string;
  error?: string;
};

async function runParallelScenarios(mode: string, workersArg?: number, setName?: string): Promise<number> {
  const set = (setName || process.env.SCENARIO_SET || 'full').toLowerCase();
  const selectedSet = set === 'smoke' ? SMOKE_PARALLEL_SET : DEFAULT_PARALLEL_SET;
  const scenarios = selectedSet.filter(s => SCENARIOS[s]);
  if (scenarios.length === 0) {
    console.error('No scenarios configured for parallel run');
    return 1;
  }

  const workers = Math.min(workersArg ?? scenarios.length, scenarios.length);
  const logsDir = resolve(process.cwd(), '.logs', 'scenarios-parallel', tsTag());
  mkdirSync(logsDir, { recursive: true });

  console.log('\n' + '='.repeat(72));
  console.log('Parallel Scenario Runner (isolated Anvil + relay per worker)');
  console.log('='.repeat(72));
  console.log(`Set       : ${set}`);
  console.log(`Mode      : ${mode}`);
  console.log(`Scenarios : ${scenarios.join(', ')}`);
  console.log(`Workers   : ${workers}`);
  console.log(`Logs      : ${logsDir}`);
  console.log('='.repeat(72) + '\n');

  let next = 0;
  const results: ParallelResult[] = [];

  const runOne = async (scenario: string, workerId: number): Promise<ParallelResult> => {
    const startedAt = Date.now();
    const logPath = join(logsDir, `${String(workerId).padStart(2, '0')}-${scenario}.log`);
    const log = createWriteStream(logPath, { flags: 'w' });
    let relayProc: ChildProcessWithoutNullStreams | null = null;
    let scenarioProc: ChildProcessWithoutNullStreams | null = null;

    try {
      const rpcPort = await reserveFreeLocalPort();
      const relayPort = await reserveFreeLocalPort();
      const rpcUrl = `http://127.0.0.1:${rpcPort}`;
      const relayUrl = `ws://127.0.0.1:${relayPort}`;
      const dbPath = join(logsDir, `db-worker-${workerId}-${scenario}`);
      mkdirSync(dbPath, { recursive: true });

      log.write(`scenario=${scenario}\nworker=${workerId}\nrpc=${rpcUrl}\nrelay=${relayUrl}\n\n`);

      relayProc = spawn('bun', ['runtime/networking/ws-server.ts', '--port', String(relayPort)], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          WS_PORT: String(relayPort),
          WS_SERVER_ID: `relay-${workerId}-${scenario}`,
        },
      });

      relayProc.stdout.on('data', (c) => log.write(`[relay] ${c.toString()}`));
      relayProc.stderr.on('data', (c) => log.write(`[relay:err] ${c.toString()}`));
      await waitRelayReady(relayProc, 10_000);

      scenarioProc = spawn('bun', [
        'runtime/scenarios/run.ts',
        scenario,
        `--mode=${mode}`,
        `--rpc=${rpcUrl}`,
        '--single',
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          JADAPTER_MODE: mode,
          ANVIL_RPC: rpcUrl,
          XLN_DB_PATH: dbPath,
          RELAY_URL: relayUrl,
          INTERNAL_RELAY_URL: relayUrl,
          PUBLIC_RELAY_URL: relayUrl,
          P2P_RELAY_PORT: String(relayPort),
        },
      });

      scenarioProc.stdout.on('data', (c) => log.write(c.toString()));
      scenarioProc.stderr.on('data', (c) => log.write(c.toString()));

      const code = await new Promise<number | null>((resolveExit, rejectExit) => {
        scenarioProc?.once('error', rejectExit);
        scenarioProc?.once('exit', resolveExit);
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
      await stopProcess(relayProc);
      log.end();
    }
  };

  const workerLoop = async (workerId: number) => {
    while (true) {
      const idx = next++;
      if (idx >= scenarios.length) return;
      const scenario = scenarios[idx]!;
      console.log(`▶️  [worker ${workerId}] ${scenario}`);
      const result = await runOne(scenario, workerId);
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
  await Promise.all(Array.from({ length: workers }, (_, i) => workerLoop(i)));
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
  const { scenario, mode, rpc, workers, set, single } = parseArgs();

  const requestedMode = (mode || process.env.JADAPTER_MODE || 'rpc').toLowerCase();
  const runAll = !single && (!scenario || scenario === 'all');

  if (runAll) {
    const code = await runParallelScenarios(requestedMode, workers, set);
    process.exit(code);
  }

  if (!scenario) {
    console.log('Usage: bun runtime/scenarios/run.ts [all|<scenario>] [--mode=browservm|rpc] [--rpc=URL] [--workers=N]');
    console.log(`\nAvailable scenarios: ${unique(Object.keys(SCENARIOS)).join(', ')}`);
    process.exit(1);
  }

  const entry = SCENARIOS[scenario];
  if (!entry) {
    console.error(`Unknown scenario: "${scenario}". Available: ${Object.keys(SCENARIOS).join(', ')}`);
    process.exit(1);
  }

  // Set env vars — scenarios read these via getJAdapterMode() / ensureJAdapter()
  if (mode) process.env.JADAPTER_MODE = mode;

  let effectiveRpc = rpc || process.env.ANVIL_RPC;
  if (requestedMode !== 'browservm' && !effectiveRpc) {
    // Default to isolated RPC per scenario process to allow true parallel runs.
    const port = await reserveFreeLocalPort();
    effectiveRpc = `http://127.0.0.1:${port}`;
  }
  if (effectiveRpc) process.env.ANVIL_RPC = effectiveRpc;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Scenario: ${scenario}`);
  console.log(`  Mode: ${mode || process.env.JADAPTER_MODE || 'rpc'}`);
  if (effectiveRpc) console.log(`  RPC: ${effectiveRpc}`);
  console.log(`${'='.repeat(60)}\n`);

  // Create fresh env — scenario self-boots from here
  const { createEmptyEnv } = await import('../runtime');
  const env = createEmptyEnv(`${scenario}-cli-seed-42`);

  // Dynamic import and run
  const mod = await import(entry.file);
  const fn = mod[entry.fn];
  if (!fn) {
    console.error(`Function "${entry.fn}" not found in ${entry.file}`);
    process.exit(1);
  }

  await fn(env);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${scenario} COMPLETE`);
  console.log(`  Frames: ${env.history?.length || 0}`);
  console.log(`${'='.repeat(60)}\n`);
  process.exit(0);
}

main().catch(err => {
  console.error('\nScenario FAILED:', err.message || err);
  process.exit(1);
});

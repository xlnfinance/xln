/**
 * Parallel system scenario runner with isolated Anvil instances per worker.
 *
 * Why:
 * - Running RPC scenarios against one shared Anvil causes nonce/deploy races.
 * - This runner gives each worker its own port/anvil process (chainId=31337).
 *
 * Usage:
 *   bun runtime/scripts/run-system-tests-parallel.ts
 *   bun runtime/scripts/run-system-tests-parallel.ts --workers=6
 *   bun runtime/scripts/run-system-tests-parallel.ts --scenarios=processbatch,rebalance
 *   bun runtime/scripts/run-system-tests-parallel.ts --base-port=18545 --stream
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, createWriteStream, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

type RunStatus = 'passed' | 'failed';
type RunResult = {
  scenario: string;
  workerId: number;
  port: number;
  status: RunStatus;
  durationMs: number;
  logPath: string;
  error?: string;
  exitCode?: number | null;
};

const DEFAULT_SCENARIOS = [
  'processbatch',
  'rebalance',
  'settle-rebalance',
];

type CliArgs = {
  scenarios: string[];
  workers: number;
  basePort: number;
  scenarioTimeoutMs: number;
  anvilStartupTimeoutMs: number;
  anvilBin: string;
  stream: boolean;
};

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const getFlag = (name: string): string | undefined => {
    const arg = args.find((a) => a.startsWith(`--${name}=`));
    return arg?.split('=')[1];
  };
  const hasFlag = (name: string): boolean => args.includes(`--${name}`);

  const scenarios = (getFlag('scenarios') || DEFAULT_SCENARIOS.join(','))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const workersRaw = Number(getFlag('workers') || scenarios.length);
  const workers = Number.isFinite(workersRaw) && workersRaw > 0
    ? Math.floor(workersRaw)
    : scenarios.length;

  const basePortRaw = Number(getFlag('base-port') || '18545');
  const basePort = Number.isFinite(basePortRaw) && basePortRaw > 0
    ? Math.floor(basePortRaw)
    : 18545;

  const scenarioTimeoutMsRaw = Number(getFlag('timeout-ms') || '900000'); // 15m
  const scenarioTimeoutMs = Number.isFinite(scenarioTimeoutMsRaw) && scenarioTimeoutMsRaw > 0
    ? Math.floor(scenarioTimeoutMsRaw)
    : 900000;

  const anvilStartupTimeoutMsRaw = Number(getFlag('anvil-timeout-ms') || '30000');
  const anvilStartupTimeoutMs = Number.isFinite(anvilStartupTimeoutMsRaw) && anvilStartupTimeoutMsRaw > 0
    ? Math.floor(anvilStartupTimeoutMsRaw)
    : 30000;

  return {
    scenarios,
    workers,
    basePort,
    scenarioTimeoutMs,
    anvilStartupTimeoutMs,
    anvilBin: getFlag('anvil-bin') || 'anvil',
    stream: hasFlag('stream'),
  };
}

function timestampTag(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${y}${m}${d}-${hh}${mm}${ss}`;
}

function truncateTail(path: string, maxLines = 60): string {
  try {
    const text = readFileSync(path, 'utf8');
    const lines = text.split('\n');
    return lines.slice(-maxLines).join('\n');
  } catch {
    return '(unable to read log tail)';
  }
}

async function waitForRpcReady(rpcUrl: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_chainId',
          params: [],
        }),
      });
      if (response.ok) {
        const body = await response.json();
        const chainIdHex = String(body?.result || '0x0');
        const chainId = Number.parseInt(chainIdHex, 16);
        if (chainId === 31337) return;
      }
    } catch {
      // retry
    }
    await delay(200);
  }
  throw new Error(`RPC not ready on ${rpcUrl} (expected chainId=31337 within ${timeoutMs}ms)`);
}

async function stopProcess(proc: ChildProcessWithoutNullStreams | null): Promise<void> {
  if (!proc || proc.exitCode !== null) return;
  proc.kill('SIGTERM');
  const startedAt = Date.now();
  while (proc.exitCode === null && Date.now() - startedAt < 3000) {
    await delay(100);
  }
  if (proc.exitCode === null) {
    proc.kill('SIGKILL');
  }
}

function spawnAnvil(
  anvilBin: string,
  port: number,
  log: ReturnType<typeof createWriteStream>,
  stream: boolean,
  prefix: string,
): ChildProcessWithoutNullStreams {
  const proc = spawn(anvilBin, [
    '--host', '127.0.0.1',
    '--port', String(port),
    '--chain-id', '31337',
    '--silent',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  proc.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    log.write(text);
    if (stream) process.stdout.write(`[${prefix}:anvil] ${text}`);
  });
  proc.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    log.write(text);
    if (stream) process.stderr.write(`[${prefix}:anvil] ${text}`);
  });

  return proc;
}

async function runScenarioOnWorker(
  scenario: string,
  workerId: number,
  port: number,
  args: CliArgs,
  logsDir: string,
): Promise<RunResult> {
  const startedAt = Date.now();
  const prefix = `w${workerId}:${scenario}`;
  const logPath = join(logsDir, `${String(workerId).padStart(2, '0')}-${scenario}.log`);
  const log = createWriteStream(logPath, { flags: 'w' });
  const workerDbPath = join(logsDir, `db-worker-${workerId}`);
  mkdirSync(workerDbPath, { recursive: true });
  let anvil: ChildProcessWithoutNullStreams | null = null;
  let child: ChildProcessWithoutNullStreams | null = null;

  try {
    const rpcUrl = `http://127.0.0.1:${port}`;
    log.write(`== ${scenario} ==\n`);
    log.write(`worker=${workerId} port=${port} rpc=${rpcUrl}\n`);
    log.write(`startedAt=${new Date().toISOString()}\n\n`);

    anvil = spawnAnvil(args.anvilBin, port, log, args.stream, prefix);
    await waitForRpcReady(rpcUrl, args.anvilStartupTimeoutMs);

    child = spawn(process.execPath, [
      'runtime/scenarios/run.ts',
      scenario,
      '--mode=rpc',
      `--rpc=${rpcUrl}`,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ANVIL_RPC: rpcUrl,
        JADAPTER_MODE: 'rpc',
        XLN_DB_PATH: workerDbPath,
      },
    });

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      log.write(text);
      if (args.stream) process.stdout.write(`[${prefix}] ${text}`);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      log.write(text);
      if (args.stream) process.stderr.write(`[${prefix}] ${text}`);
    });

    const timeout = setTimeout(() => {
      if (child && child.exitCode === null) child.kill('SIGKILL');
    }, args.scenarioTimeoutMs);

    const exitCode = await new Promise<number | null>((resolveExit, rejectExit) => {
      child?.once('error', rejectExit);
      child?.once('exit', (code) => resolveExit(code));
    });
    clearTimeout(timeout);

    if (exitCode !== 0) {
      return {
        scenario,
        workerId,
        port,
        status: 'failed',
        durationMs: Date.now() - startedAt,
        logPath,
        exitCode,
        error: `scenario exited with code ${exitCode}`,
      };
    }

    return {
      scenario,
      workerId,
      port,
      status: 'passed',
      durationMs: Date.now() - startedAt,
      logPath,
      exitCode,
    };
  } catch (err) {
    return {
      scenario,
      workerId,
      port,
      status: 'failed',
      durationMs: Date.now() - startedAt,
      logPath,
      error: (err as Error).message,
    };
  } finally {
    await stopProcess(child);
    await stopProcess(anvil);
    log.end();
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  const scenarios = args.scenarios;
  if (scenarios.length === 0) {
    console.error('No scenarios selected. Use --scenarios=a,b,c');
    process.exit(1);
  }

  const workers = Math.min(args.workers, scenarios.length);
  const logsDir = resolve(process.cwd(), '.logs', 'system-tests', timestampTag());
  mkdirSync(logsDir, { recursive: true });

  console.log('\n' + '='.repeat(72));
  console.log('Parallel System Scenario Runner');
  console.log('='.repeat(72));
  console.log(`Scenarios : ${scenarios.join(', ')}`);
  console.log(`Workers   : ${workers}`);
  console.log(`Base port : ${args.basePort} (worker i => ${args.basePort}+i)`);
  console.log(`Chain ID  : 31337 (per-worker Anvil)`);
  console.log(`Logs dir  : ${logsDir}`);
  console.log('='.repeat(72) + '\n');

  let nextIndex = 0;
  const results: RunResult[] = [];

  async function workerLoop(workerId: number): Promise<void> {
    const port = args.basePort + workerId;
    while (true) {
      const idx = nextIndex++;
      if (idx >= scenarios.length) return;
      const scenario = scenarios[idx]!;

      console.log(`▶️  [worker ${workerId}] starting ${scenario} on :${port}`);
      const result = await runScenarioOnWorker(scenario, workerId, port, args, logsDir);
      results.push(result);
      const seconds = (result.durationMs / 1000).toFixed(1);
      if (result.status === 'passed') {
        console.log(`✅ [worker ${workerId}] ${scenario} passed in ${seconds}s`);
      } else {
        console.log(`❌ [worker ${workerId}] ${scenario} failed in ${seconds}s (${result.error || 'unknown error'})`);
      }
    }
  }

  const startedAt = Date.now();
  await Promise.all(Array.from({ length: workers }, (_, i) => workerLoop(i)));
  const totalMs = Date.now() - startedAt;

  const byScenario = new Map(results.map((r) => [r.scenario, r]));
  const ordered = scenarios.map((s) => byScenario.get(s)).filter(Boolean) as RunResult[];
  const failed = ordered.filter((r) => r.status === 'failed');

  console.log('\n' + '='.repeat(72));
  console.log('Summary');
  console.log('='.repeat(72));
  for (const r of ordered) {
    const seconds = (r.durationMs / 1000).toFixed(1);
    console.log(`${r.status === 'passed' ? 'PASS' : 'FAIL'}  ${r.scenario.padEnd(18)}  ${seconds.padStart(8)}s  worker=${r.workerId} port=${r.port}`);
  }
  console.log('-'.repeat(72));
  console.log(`Total wall time: ${(totalMs / 1000).toFixed(1)}s`);
  console.log(`Logs: ${logsDir}`);
  console.log('='.repeat(72));

  if (failed.length > 0) {
    for (const f of failed) {
      console.log(`\n--- ${f.scenario} (tail: ${f.logPath}) ---`);
      console.log(truncateTail(f.logPath, 60));
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Parallel scenario runner failed:', (err as Error).message);
  process.exit(1);
});

/**
 * Parallel Playwright runner with fully isolated local stacks per shard:
 * - dedicated anvil RPC
 * - dedicated runtime server
 * - dedicated vite preview server (single frontend build shared by all shards)
 *
 * Usage:
 *   bun runtime/scripts/run-e2e-parallel-isolated.ts
 *   bun runtime/scripts/run-e2e-parallel-isolated.ts --shards=3
 *   bun runtime/scripts/run-e2e-parallel-isolated.ts --base-port=20000
 *   bun runtime/scripts/run-e2e-parallel-isolated.ts --video=on --trace=on-first-retry --max-failures=1
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

type CliArgs = {
  shards: number;
  basePort: number;
  stackTimeoutMs: number;
  testTimeoutMs: number;
  phaseWarnMs: number;
  anvilBin: string;
  maxFailures: number;
  workersPerShard: number;
  videoMode: 'off' | 'on' | 'retain-on-failure' | 'on-first-retry';
  traceMode: 'off' | 'on' | 'retain-on-failure' | 'on-first-retry';
  screenshotMode: 'off' | 'on' | 'only-on-failure';
  reporter: 'line' | 'list' | 'dot';
  pwGrep?: string;
  pwProject?: string;
  pwFiles: string[];
  skipBuild: boolean;
};

type RunResult = {
  shard: number;
  status: 'passed' | 'failed';
  durationMs: number;
  logPath: string;
  phaseMs: {
    preflight: number;
    anvilBoot: number;
    apiBoot: number;
    apiHealthy: number;
    viteBoot: number;
    playwright: number;
  };
  error?: string;
};

const parseArgs = (): CliArgs => {
  const args = process.argv.slice(2);
  const longMode = process.env.E2E_LONG === '1';
  const cpu = (() => {
    try {
      return Math.max(1, availableParallelism());
    } catch {
      return 8;
    }
  })();
  const defaultShards = Math.max(2, Math.min(8, Math.floor(cpu / 2)));
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

  const shardsRaw = Number(getFlag('shards') || String(defaultShards));
  const basePortRaw = Number(getFlag('base-port') || '20000');
  const stackTimeoutRaw = Number(getFlag('stack-timeout-ms') || '90000');
  const testTimeoutRaw = Number(getFlag('test-timeout-ms') || (longMode ? '1200000' : '360000'));
  const phaseWarnRaw = Number(getFlag('phase-warn-ms') || '30000');
  const maxFailuresRaw = Number(getFlag('max-failures') || '1');
  const workersPerShardRaw = Number(getFlag('workers-per-shard') || '1');
  const videoRaw = String(getFlag('video') || 'on').toLowerCase();
  const traceRaw = String(getFlag('trace') || 'on-first-retry').toLowerCase();
  const screenshotRaw = String(getFlag('screenshot') || 'only-on-failure').toLowerCase();
  const reporterRaw = String(getFlag('reporter') || 'line').toLowerCase();
  const pwFiles = (getFlag('pw-files') || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  const coerceVideo = (mode: string): CliArgs['videoMode'] =>
    mode === 'off' || mode === 'retain-on-failure' || mode === 'on-first-retry' ? mode : 'on';
  const coerceTrace = (mode: string): CliArgs['traceMode'] =>
    mode === 'off' || mode === 'on' || mode === 'retain-on-failure' ? mode : 'on-first-retry';
  const coerceScreenshot = (mode: string): CliArgs['screenshotMode'] =>
    mode === 'off' || mode === 'on' ? mode : 'only-on-failure';
  const coerceReporter = (mode: string): CliArgs['reporter'] =>
    mode === 'list' || mode === 'dot' ? mode : 'line';

  return {
    shards: Number.isFinite(shardsRaw) && shardsRaw > 0 ? Math.floor(shardsRaw) : 2,
    basePort: Number.isFinite(basePortRaw) && basePortRaw > 0 ? Math.floor(basePortRaw) : 20000,
    stackTimeoutMs: Number.isFinite(stackTimeoutRaw) && stackTimeoutRaw > 0 ? Math.floor(stackTimeoutRaw) : 90000,
    testTimeoutMs: Number.isFinite(testTimeoutRaw) && testTimeoutRaw > 0
      ? Math.floor(testTimeoutRaw)
      : (longMode ? 1200000 : 360000),
    phaseWarnMs: Number.isFinite(phaseWarnRaw) && phaseWarnRaw > 0 ? Math.floor(phaseWarnRaw) : 30000,
    anvilBin: getFlag('anvil-bin') || 'anvil',
    maxFailures: Number.isFinite(maxFailuresRaw) && maxFailuresRaw >= 0 ? Math.floor(maxFailuresRaw) : 1,
    workersPerShard: Number.isFinite(workersPerShardRaw) && workersPerShardRaw > 0 ? Math.floor(workersPerShardRaw) : 1,
    videoMode: coerceVideo(videoRaw),
    traceMode: coerceTrace(traceRaw),
    screenshotMode: coerceScreenshot(screenshotRaw),
    reporter: coerceReporter(reporterRaw),
    pwGrep: getFlag('pw-grep'),
    pwProject: getFlag('pw-project'),
    pwFiles,
    skipBuild: args.includes('--skip-build'),
  };
};

const tsTag = (): string => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${ms}`;
};

const tail = (path: string, lines = 60): string => {
  try {
    const text = readFileSync(path, 'utf8');
    return text.split('\n').slice(-lines).join('\n');
  } catch {
    return '(unable to read log tail)';
  }
};

type StepTiming = { label: string; ms: number };

const parseStepTimings = (path: string): StepTiming[] => {
  try {
    const text = readFileSync(path, 'utf8');
    const out: StepTiming[] = [];
    const re = /\[E2E-TIMING\]\s+(.+?)\s+(\d+)ms/g;
    let match: RegExpExecArray | null = null;
    while ((match = re.exec(text)) !== null) {
      const label = String(match[1] || '').trim();
      const ms = Number(match[2] || '0');
      if (!label || !Number.isFinite(ms)) continue;
      out.push({ label, ms });
    }
    return out;
  } catch {
    return [];
  }
};

const stopProcess = async (proc: ChildProcessWithoutNullStreams | null): Promise<void> => {
  if (!proc || proc.exitCode !== null) return;
  proc.kill('SIGTERM');
  const deadline = Date.now() + 4000;
  while (proc.exitCode === null && Date.now() < deadline) {
    await delay(100);
  }
  if (proc.exitCode === null) proc.kill('SIGKILL');
};

const pidsOnPort = (port: number): number[] => {
  const res = Bun.spawnSync(['lsof', '-ti', `tcp:${port}`], {
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const text = Buffer.from(res.stdout).toString('utf8').trim();
  if (!text) return [];
  return text
    .split(/\s+/)
    .map(v => Number(v))
    .filter(v => Number.isFinite(v) && v > 0);
};

const freePort = async (
  port: number,
  log?: ReturnType<typeof createWriteStream>,
): Promise<void> => {
  const first = pidsOnPort(port).filter(pid => pid !== process.pid);
  if (first.length === 0) return;

  log?.write(`[preflight] port ${port} busy by pids=${first.join(',')} -> SIGTERM\n`);
  for (const pid of first) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  await delay(300);

  const second = pidsOnPort(port).filter(pid => pid !== process.pid);
  if (second.length > 0) {
    log?.write(`[preflight] port ${port} still busy by pids=${second.join(',')} -> SIGKILL\n`);
    for (const pid of second) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    await delay(150);
  }

  const remain = pidsOnPort(port).filter(pid => pid !== process.pid);
  if (remain.length > 0) {
    throw new Error(`Port ${port} still in use after cleanup: ${remain.join(',')}`);
  }
};

const waitForRpcReady = async (rpcUrl: string, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      });
      if (res.ok) {
        const body = await res.json() as any;
        const chainId = Number.parseInt(String(body?.result || '0x0'), 16);
        if (chainId === 31337) return;
      }
    } catch {
      // retry
    }
    await delay(200);
  }
  throw new Error(`RPC not ready at ${rpcUrl}`);
};

const waitForHttpReady = async (url: string, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      // retry
    }
    await delay(250);
  }
  throw new Error(`HTTP endpoint not ready: ${url}`);
};

const waitForServerHealthy = async (apiUrl: string, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let lastHealth: any = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${apiUrl}/api/health`);
      if (res.ok) {
        const body = await res.json();
        lastHealth = body;
        const resetDone = body?.reset?.inProgress !== true;
        const meshReady = body?.hubMesh?.ok === true;
        const hasTs = typeof body?.timestamp === 'number';
        if (hasTs && resetDone && meshReady) return;
      }
    } catch {
      // retry
    }
    await delay(250);
  }
  const snapshot = lastHealth
    ? JSON.stringify(
        {
          reset: lastHealth?.reset || null,
          hubMesh: lastHealth?.hubMesh || null,
          hubs: Array.isArray(lastHealth?.hubs)
            ? lastHealth.hubs.map((h: any) => ({
                entityId: h?.entityId,
                name: h?.name,
                online: h?.online,
              }))
            : [],
        },
        null,
        2,
      )
    : 'no-health-payload';
  throw new Error(`Server health not ready at ${apiUrl} within ${timeoutMs}ms\n${snapshot}`);
};

const waitForHttpsReady = async (url: string, timeoutMs: number): Promise<void> => {
  // Use curl -k for self-signed local certs.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const p = spawn('curl', ['-k', '-sSf', url], { stdio: 'ignore' });
      p.once('exit', (code) => resolve(code === 0));
      p.once('error', () => resolve(false));
    });
    if (ok) return;
    await delay(250);
  }
  throw new Error(`HTTPS endpoint not ready: ${url}`);
};

const runCmd = async (
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; cwd?: string; log?: ReturnType<typeof createWriteStream>; timeoutMs?: number },
): Promise<number | null> => {
  const proc = spawn(cmd, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: opts.env ?? process.env,
    cwd: opts.cwd,
  });

  proc.stdout.on('data', chunk => opts.log?.write(chunk.toString()));
  proc.stderr.on('data', chunk => opts.log?.write(chunk.toString()));

  const timeout = opts.timeoutMs
    ? setTimeout(() => {
        if (proc.exitCode === null) proc.kill('SIGKILL');
      }, opts.timeoutMs)
    : null;

  const code = await new Promise<number | null>((resolveExit, rejectExit) => {
    proc.once('error', rejectExit);
    proc.once('exit', resolveExit);
  });
  if (timeout) clearTimeout(timeout);
  return code;
};

const runShard = async (shard: number, totalShards: number, args: CliArgs, logsDir: string): Promise<RunResult> => {
  const startedAt = Date.now();
  const logPath = join(logsDir, `e2e-shard-${String(shard).padStart(2, '0')}.log`);
  const log = createWriteStream(logPath, { flags: 'w' });

  let anvil: ChildProcessWithoutNullStreams | null = null;
  let api: ChildProcessWithoutNullStreams | null = null;
  let vite: ChildProcessWithoutNullStreams | null = null;

  const rpcPort = args.basePort + shard * 20 + 0;
  const apiPort = args.basePort + shard * 20 + 2;
  const webPort = args.basePort + shard * 20 + 4;
  const rpcUrl = `http://127.0.0.1:${rpcPort}`;
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const webUrl = `https://localhost:${webPort}`;
  const dbPath = join(logsDir, `db-e2e-shard-${shard}`);
  mkdirSync(dbPath, { recursive: true });
  const phaseMs: RunResult['phaseMs'] = {
    preflight: 0,
    anvilBoot: 0,
    apiBoot: 0,
    apiHealthy: 0,
    viteBoot: 0,
    playwright: 0,
  };
  const markPhase = (phase: keyof RunResult['phaseMs'], started: number): void => {
    const ms = Date.now() - started;
    phaseMs[phase] = ms;
    const warn = ms > args.phaseWarnMs;
    log.write(`[timing] ${phase}=${ms}ms${warn ? ` (>${args.phaseWarnMs}ms)` : ''}\n`);
  };

  try {
    log.write(`shard=${shard}/${totalShards}\nrpc=${rpcUrl}\napi=${apiUrl}\nweb=${webUrl}\ndb=${dbPath}\n\n`);

    // Hard preflight: kill stale processes that kept shard ports occupied
    // from previous crashed/aborted runs.
    // Layout:
    // - rpc: anvil
    // - api: runtime server
    // - web: vite preview
    // - relay: runtime ws relay (api+20, from runtime/server.ts)
    const preflightStart = Date.now();
    await freePort(rpcPort, log);
    await freePort(apiPort, log);
    await freePort(webPort, log);
    await freePort(apiPort + 20, log);
    markPhase('preflight', preflightStart);

    const anvilStart = Date.now();
    anvil = spawn(args.anvilBin, [
      '--host', '127.0.0.1',
      '--port', String(rpcPort),
      '--chain-id', '31337',
      '--silent',
    ], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    anvil.stdout.on('data', c => log.write(`[anvil] ${c.toString()}`));
    anvil.stderr.on('data', c => log.write(`[anvil:err] ${c.toString()}`));
    await waitForRpcReady(rpcUrl, args.stackTimeoutMs);
    markPhase('anvilBoot', anvilStart);

    const apiStart = Date.now();
    api = spawn('bun', ['runtime/server.ts', '--port', String(apiPort)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        USE_ANVIL: 'true',
        ANVIL_RPC: rpcUrl,
        XLN_DB_PATH: dbPath,
      },
    });
    api.stdout.on('data', c => log.write(`[api] ${c.toString()}`));
    api.stderr.on('data', c => log.write(`[api:err] ${c.toString()}`));
    await waitForHttpReady(`${apiUrl}/api`, args.stackTimeoutMs);
    markPhase('apiBoot', apiStart);
    const healthStart = Date.now();
    await waitForServerHealthy(apiUrl, args.stackTimeoutMs);
    markPhase('apiHealthy', healthStart);

    const shardViteCacheDir = join(logsDir, `vite-cache-shard-${shard}`);
    const viteStart = Date.now();
    vite = spawn('bun', ['run', 'preview', '--', '--host', '0.0.0.0', '--port', String(webPort), '--strictPort'], {
      cwd: resolve(process.cwd(), 'frontend'),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        VITE_DEV_PORT: String(webPort),
        VITE_API_PROXY_TARGET: apiUrl,
        VITE_CACHE_DIR: shardViteCacheDir,
      },
    });
    vite.stdout.on('data', c => log.write(`[vite] ${c.toString()}`));
    vite.stderr.on('data', c => log.write(`[vite:err] ${c.toString()}`));
    await waitForHttpsReady(webUrl, args.stackTimeoutMs);
    markPhase('viteBoot', viteStart);

    const shardArg = `${shard + 1}/${totalShards}`;
    const playwrightArgs = [
      'playwright',
      'test',
      '--config',
      'playwright.config.ts',
      '--shard',
      shardArg,
    ];
    if (args.pwGrep) {
      playwrightArgs.push('--grep', args.pwGrep);
    }
    if (args.pwProject) {
      playwrightArgs.push(`--project=${args.pwProject}`);
    }
    playwrightArgs.push(`--workers=${args.workersPerShard}`);
    playwrightArgs.push(`--reporter=${args.reporter}`);
    if (args.maxFailures > 0) playwrightArgs.push(`--max-failures=${args.maxFailures}`);
    for (const file of args.pwFiles) playwrightArgs.push(file);
    log.write(`[runner] playwright args: ${JSON.stringify(playwrightArgs)}\n`);

    const playwrightStart = Date.now();
    const code = await runCmd(
      'bunx',
      playwrightArgs,
      {
        env: {
          ...process.env,
          PW_BASE_URL: webUrl,
          PW_SKIP_WEBSERVER: '1',
          PW_WORKERS: String(args.workersPerShard),
          PW_VIDEO: args.videoMode,
          PW_TRACE: args.traceMode,
          PW_SCREENSHOT: args.screenshotMode,
          PW_SIMPLE_REPORTER: '1',
          PW_REPORTER: args.reporter,
          PW_OUTPUT_DIR: join(logsDir, `test-results-shard-${shard}`),
          E2E_BASE_URL: webUrl,
          E2E_API_BASE_URL: apiUrl,
          E2E_RESET_BASE_URL: apiUrl,
          E2E_FAST: process.env.E2E_FAST ?? '1',
        },
        log,
        timeoutMs: args.testTimeoutMs,
      },
    );
    markPhase('playwright', playwrightStart);

    if (code !== 0) {
      return {
        shard,
        status: 'failed',
        durationMs: Date.now() - startedAt,
        logPath,
        phaseMs,
        error: `playwright_exit_${code}`,
      };
    }

    return {
      shard,
      status: 'passed',
      durationMs: Date.now() - startedAt,
      logPath,
      phaseMs,
    };
  } catch (error) {
    return {
      shard,
      status: 'failed',
      durationMs: Date.now() - startedAt,
      logPath,
      phaseMs,
      error: (error as Error).message,
    };
  } finally {
    await stopProcess(vite);
    await stopProcess(api);
    await stopProcess(anvil);
    log.end();
  }
};

async function main(): Promise<void> {
  const args = parseArgs();
  const logsDir = resolve(process.cwd(), '.logs', 'e2e-parallel', tsTag());
  mkdirSync(logsDir, { recursive: true });

  console.log('\n' + '='.repeat(72));
  console.log('E2E Parallel Runner (isolated stack per shard)');
  console.log('='.repeat(72));
  console.log(`Shards   : ${args.shards}`);
  console.log(`BasePort : ${args.basePort}`);
  console.log(`Workers/shard: ${args.workersPerShard}`);
  console.log(`Max failures : ${args.maxFailures}`);
  console.log(`Phase warn ms: ${args.phaseWarnMs}`);
  console.log(`Artifacts    : video=${args.videoMode}, trace=${args.traceMode}, screenshot=${args.screenshotMode}`);
  console.log(`Logs     : ${logsDir}`);
  console.log('='.repeat(72) + '\n');

  if (!args.skipBuild) {
    const buildLogPath = join(logsDir, 'build-runtime.log');
    const buildLog = createWriteStream(buildLogPath, { flags: 'w' });
    const buildCode = await runCmd('bash', ['-lc', './scripts/build-runtime.sh'], {
      env: process.env,
      log: buildLog,
      timeoutMs: 300000,
    });
    buildLog.write('\n=== frontend build ===\n');
    const frontendBuildCode = await runCmd('bun', ['run', 'build'], {
      cwd: resolve(process.cwd(), 'frontend'),
      env: process.env,
      log: buildLog,
      timeoutMs: 300000,
    });
    buildLog.end();
    if (buildCode !== 0 || frontendBuildCode !== 0) {
      console.error(`❌ prebuild failed (runtime/frontend). See log: ${buildLogPath}`);
      process.exit(1);
    }
  } else {
    console.log('⏩ skip-build enabled');
  }

  const startedAt = Date.now();
  const promises: Array<Promise<RunResult>> = [];
  for (let i = 0; i < args.shards; i++) {
    promises.push(runShard(i, args.shards, args, logsDir));
  }

  const results = await Promise.all(promises);
  const totalMs = Date.now() - startedAt;
  const failed = results.filter(r => r.status === 'failed');

  console.log('\n' + '='.repeat(72));
  console.log('E2E Summary');
  console.log('='.repeat(72));
  for (const r of results.sort((a, b) => a.shard - b.shard)) {
    const sec = (r.durationMs / 1000).toFixed(1);
    const p = r.phaseMs;
    console.log(
      `${r.status === 'passed' ? 'PASS' : 'FAIL'}  shard=${r.shard}  ${sec.padStart(8)}s  ` +
      `phases[pre=${p.preflight} anvil=${p.anvilBoot} api=${p.apiBoot} health=${p.apiHealthy} vite=${p.viteBoot} pw=${p.playwright}]  ` +
      `log=${r.logPath}`,
    );
    const steps = parseStepTimings(r.logPath).sort((a, b) => b.ms - a.ms).slice(0, 8);
    if (steps.length > 0) {
      console.log(`      slow-steps: ${steps.map((s) => `${s.label}=${s.ms}ms`).join(' | ')}`);
    }
  }
  console.log('-'.repeat(72));
  console.log(`Total wall time: ${(totalMs / 1000).toFixed(1)}s`);
  console.log(`Logs: ${logsDir}`);

  if (failed.length > 0) {
    for (const f of failed) {
      console.log(`\n--- shard ${f.shard} (tail: ${f.logPath}) ---`);
      console.log(tail(f.logPath, 80));
    }
    process.exit(1);
  }

  // Bun may keep event-loop handles alive (streams/timers) after successful run.
  // Exit explicitly so parent orchestrators (run-all-tests-fast) don't hang.
  process.exit(0);
}

main().catch((err) => {
  console.error('E2E isolated parallel runner failed:', (err as Error).message);
  process.exit(1);
});

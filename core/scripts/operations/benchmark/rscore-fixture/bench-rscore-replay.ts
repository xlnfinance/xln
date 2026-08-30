#!/usr/bin/env bun

/**
 * Zero-JS native replay benchmark via `xlnrs replay`.
 * Invokes the proven Rust binary directly. No TS cutover, no shadow.
 *
 * Captures: phase metrics (per-worker CPU/wall/barrier, touched shards),
 * OS telemetry (CPU%, effective cores, RSS, threads), exact root/digest counts.
 *
 * Scale evidence requires manifest cardinality: >=1,000 active accounts,
 * >=1,000 Runtime frames and >=1,000 payments. `--allow-smoke` is parity-only
 * and is deliberately labelled as a diagnostic, never TPS evidence.
 * Args: --paths-json <fixture.paths.json> [--max-seconds <20>] [--allow-smoke]
 * Runs w=1/2/4/8 sequentially against independent native DBs inside one
 * 20-second process budget, with exact digest equality assertion.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { safeParse, safeStringify } from '../../../../protocol/serialization';

// ---------------------------------------------------------------------------
// OS telemetry
// ---------------------------------------------------------------------------

type Sample = { cpuCores: number; rssKiB: number; threads: number };

const requiredManifestPath = (manifest: unknown, field: string): string => {
  if (!manifest || typeof manifest !== 'object') throw new Error('PATHS_MANIFEST_OBJECT');
  const value = (manifest as Record<string, unknown>)[field];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`PATHS_MANIFEST_FIELD:${field}`);
  return value;
};

const requiredManifestCount = (manifest: unknown, field: string): number => {
  if (!manifest || typeof manifest !== 'object') throw new Error('PATHS_MANIFEST_OBJECT');
  const value = (manifest as Record<string, unknown>)[field];
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`PATHS_MANIFEST_COUNT:${field}:${String(value)}`);
  }
  return Number(value);
};

const psRows = (): { pid: number; ppid: number; cpu: number; rss: number; threads: number }[] => {
  const r = spawnSync('ps', ['-axo', 'pid=,ppid=,%cpu=,rss=', '-o', 'nlwp='], {
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  });
  if (r.status !== 0) return [];
  return r.stdout.trim().split('\n').flatMap(line => {
    const f = line.trim().split(/\s+/);
    if (f.length < 4) return [];
    const [p, pp, c, rss, th = '0'] = f;
    const pid = Math.floor(Number(p));
    const ppid = Math.floor(Number(pp));
    const cpu = Number(c);
    const rssKiB = Number(rss);
    const threads = Math.floor(Number(th) || 1);
    if (!Number.isSafeInteger(pid) || pid < 1 || !Number.isFinite(cpu) || !Number.isFinite(rssKiB)) return [];
    return [{ pid, ppid, cpu, rss: rssKiB, threads }];
  });
};

const sampleTree = (rootPid: number): Sample => {
  const all = psRows();
  const descendants = new Set([rootPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of all) {
      if (!descendants.has(r.ppid) || descendants.has(r.pid)) continue;
      descendants.add(r.pid);
      grew = true;
    }
  }
  return all.filter(r => descendants.has(r.pid)).reduce(
    (s, r) => ({ cpuCores: s.cpuCores + r.cpu / 100, rssKiB: s.rssKiB + r.rss, threads: s.threads + r.threads }),
    { cpuCores: 0, rssKiB: 0, threads: 0 },
  );
};

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

type BenchResult = {
  workers: number;
  ok: boolean;
  elapsedMs: number;
  frames: number;
  ingress: number;
  egress: number;
  payments: number;
  engineMs: number;
  applyMs: number;
  projectionMs: number;
  avgCpuCores: number;
  peakRssMiB: number;
  peakThreads: number;
  effectiveCores: number;
  effectDigestsCompared: number;
  outboxDigestsCompared: number;
  postStateHashesCompared: number;
  runtimeRootsCompared: number;
  accountsRoot: string;
  phaseSummary: { kind: string; workerWorkMaxMs: number; touchedShards: number; workersWithWork: number }[];
  error?: string;
};

// ---------------------------------------------------------------------------
// Run replay
// ---------------------------------------------------------------------------

const runReplay = async (
  pathsJson: string,
  workers: number,
  maxSec: number,
): Promise<BenchResult> => {
  if (!Number.isFinite(maxSec) || maxSec <= 0 || maxSec > 20) {
    throw new Error(`REPLAY_TIMEOUT_LIMIT:max=${maxSec}:allowed=20`);
  }
  const paths = safeParse(readFileSync(pathsJson, 'utf8'));
  const walDb = requiredManifestPath(paths, 'walDb');
  const stateDb = requiredManifestPath(paths, 'stateDb');
  const recording = requiredManifestPath(paths, 'recording');
  const runtimeSeedFile = requiredManifestPath(paths, 'runtimeSeedFile');

  if (!existsSync(walDb)) throw new Error(`WAL_DB_MISSING:${walDb}`);
  if (!existsSync(stateDb)) throw new Error(`STATE_DB_MISSING:${stateDb}`);
  if (!existsSync(recording)) throw new Error(`RECORDING_MISSING:${recording}`);

  const binary = resolve(import.meta.dir, '../../../../../rscore/target/release/xlnrs');
  if (!existsSync(binary)) throw new Error(`BINARY_MISSING:${binary}`);

  // The native store imports the checkpoint itself. Copying the TS state DB
  // here would mix two storage formats and also charge setup I/O to replay.
  const nativeParent = mkdtempSync(join(dirname(pathsJson), `.native-w${workers}-`));
  const nativeDir = join(nativeParent, 'db');

  const args = ['replay',
    '--wal', walDb,
    '--state-db', stateDb,
    '--recording', recording,
    '--runtime-seed-file', runtimeSeedFile,
    '--runtime-signer-label', '1',
    '--entity-signer-label', 'owner',
    '--native-db', nativeDir,
    '--workers', String(workers),
    '--offline-ts-import',
  ];

  console.error(`\nREPLAY w=${workers} binary=${binary}`);
  console.error(`REPLAY cmd: ${binary} ${args.join(' ')}`);

  const started = performance.now();
  const child = spawn(binary, args, {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  if (!child.stdout || !child.stderr) throw new Error('PIPE_MISSING');

  const samples: Sample[] = [sampleTree(child.pid ?? 0)];
  const sampler = setInterval(() => { if (child.pid) samples.push(sampleTree(child.pid)); }, 100);
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, maxSec * 1_000);

  const collectLines = (stream: NodeJS.ReadableStream): Promise<string[]> =>
    new Promise(res => {
      const rl = createInterface({ input: stream });
      const lines: string[] = [];
      rl.on('line', l => lines.push(l));
      rl.on('close', () => res(lines));
    });

  const stdoutP = collectLines(child.stdout);
  const stderrP = collectLines(child.stderr);

  let exitCode: number | null;
  try {
    exitCode = await new Promise<number | null>((resolveExit, rejectExit) => {
      child.once('error', rejectExit);
      child.once('exit', resolveExit);
    });
  } finally {
    clearTimeout(timeout);
    clearInterval(sampler);
  }

  const [stdout, stderr] = await Promise.all([stdoutP, stderrP]);
  const wallMs = performance.now() - started;
  rmSync(nativeParent, { recursive: true, force: true });

  // Forward stderr
  for (const line of stderr) console.error(line);

  if (timedOut || exitCode !== 0) {
    return {
      workers, ok: false, elapsedMs: wallMs,
      error: `${timedOut ? `timeout=${maxSec}s` : `exit=${exitCode}`}: ${stderr.slice(-5).join(' | ')}`,
    } as BenchResult;
  }

  // Parse JSON from stdout
  const jsonLine = stdout.find(l => l.startsWith('{') && l.includes('"benchmark"'));
  if (!jsonLine) return { workers, ok: false, elapsedMs: wallMs, error: 'NO_JSON_OUTPUT' } as BenchResult;
  const data = safeParse(jsonLine) as Record<string, unknown>;

  const avgCores = samples.reduce((s, r) => s + r.cpuCores, 0) / Math.max(samples.length, 1);
  const peakRss = Math.max(...samples.map(s => s.rssKiB), 0) / 1024;
  const peakThreads = Math.max(...samples.map(s => s.threads), 0);
  const elapsedMs = (data['elapsedMs'] as number) ?? wallMs;

  const phases = (data['accountPhaseMetrics'] as unknown[])?.map(p => {
    const m = p as Record<string, unknown>;
    return {
      kind: String(m['kind'] ?? '?'),
      workerWorkMaxMs: Number(m['workerWorkMaxMs'] ?? 0),
      touchedShards: Number(m['touchedShards'] ?? 0),
      workersWithWork: Number(m['workersWithWork'] ?? 0),
    };
  }) ?? [];

  return {
    workers,
    ok: true,
    elapsedMs,
    frames: Number(data['frames'] ?? 0),
    ingress: Number(data['ingress'] ?? 0),
    egress: Number(data['egress'] ?? 0),
    payments: Number(data['directPayments'] ?? 0),
    engineMs: Number(data['engineMs'] ?? 0),
    applyMs: Number(data['applyMs'] ?? 0),
    projectionMs: Number(data['projectionMs'] ?? 0),
    avgCpuCores: avgCores,
    peakRssMiB: peakRss,
    peakThreads,
    effectiveCores: avgCores,
    effectDigestsCompared: Number(data['effectDigestsCompared'] ?? 0),
    outboxDigestsCompared: Number(data['outboxDigestsCompared'] ?? 0),
    postStateHashesCompared: Number(data['postStateHashesCompared'] ?? 0),
    runtimeRootsCompared: Number(data['runtimeRootsCompared'] ?? 0),
    accountsRoot: String(data['accountsRoot'] ?? '?'),
    phaseSummary: phases,
  };
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const requiredArg = (name: string): string => {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx < 0) throw new Error(`MISSING:--${name}`);
  return process.argv[idx + 1]!;
};

if (import.meta.main) {
  const pathsJson = resolve(requiredArg('paths-json'));
  const maxSec = Number(process.argv.includes('--max-seconds')
    ? process.argv[process.argv.indexOf('--max-seconds') + 1]! : '20');
  const allowSmoke = process.argv.includes('--allow-smoke');

  if (!existsSync(pathsJson)) { console.error('paths-json not found'); process.exit(1); }

  const pathsManifest = safeParse(readFileSync(pathsJson, 'utf8'));
  const fixtureAccounts = requiredManifestCount(pathsManifest, 'fixtureAccounts');
  const fixturePayments = requiredManifestCount(pathsManifest, 'fixturePayments');
  const fixtureRuntimeFrames = requiredManifestCount(pathsManifest, 'fixtureRuntimeFrames');
  const minimumScaleCardinality = 1_000;
  const scaleEligible = fixtureAccounts >= minimumScaleCardinality
    && fixturePayments >= minimumScaleCardinality
    && fixtureRuntimeFrames >= minimumScaleCardinality;
  if (!allowSmoke && !scaleEligible) {
    throw new Error(
      `REPLAY_SCALE_FIXTURE_TOO_SMALL:min=${minimumScaleCardinality}:` +
      `accounts=${fixtureAccounts}:payments=${fixturePayments}:frames=${fixtureRuntimeFrames}:` +
      'use --allow-smoke only for parity diagnostics',
    );
  }

  const deadline = performance.now() + maxSec * 1_000;
  const results: BenchResult[] = [];
  for (const workers of [1, 2, 4, 8]) {
    const remainingSeconds = (deadline - performance.now()) / 1_000;
    if (remainingSeconds <= 0) {
      results.push({ workers, ok: false, elapsedMs: 0, error: `global-timeout=${maxSec}s` } as BenchResult);
      break;
    }
    results.push(await runReplay(pathsJson, workers, remainingSeconds));
  }

  const failed = results.filter(result => !result.ok);
  if (failed.length > 0) {
    for (const result of failed) {
      console.error(`REPLAY_FAILED:w=${result.workers}:${result.error ?? 'unknown'}`);
    }
    process.exit(1);
  }
  if (!allowSmoke && results.some(result => result.frames < minimumScaleCardinality)) {
    throw new Error(
      `REPLAY_SCALE_RESULT_TOO_SMALL:min=${minimumScaleCardinality}:` +
      results.map(result => `w${result.workers}=${result.frames}`).join(':') + ':' +
      'pass --allow-smoke only for diagnostics',
    );
  }

  // Print table
  console.log('\n========================================');
  console.log(allowSmoke
    ? ' SMOKE/PARITY DIAGNOSTIC — NOT TPS EVIDENCE'
    : ' PRODUCTION-SHAPED REPLAY SCALING — NOT LIVE TPS');
  console.log('========================================');
  console.log(` accounts=${fixtureAccounts} payments=${fixturePayments} frames=${fixtureRuntimeFrames}`);
  const scalingBaseline = results[0]!;
  if (allowSmoke) {
    // A small fixture proves only that every worker count executes the same
    // bytes. Do not print elapsed time, CPU or any derived rate: those numbers
    // are too easy to misquote as production capacity.
    console.log(' w  frames  payments  effectDigests  outboxDigests  root');
    for (const r of results) {
      console.log(
        `${String(r.workers).padStart(2)}  ` +
        `${String(r.frames).padStart(6)}  ` +
        `${String(r.payments).padStart(8)}  ` +
        `${String(r.effectDigestsCompared).padStart(13)}  ` +
        `${String(r.outboxDigestsCompared).padStart(13)}  ` +
        `${r.accountsRoot}`,
      );
    }
  } else {
    console.log(' w  elapsedMs  speedup  payments engineMs  applyMs   avgCpu  peakRSS  threads  effCores  in+e');
    for (const r of results) {
      console.log(
        `${String(r.workers).padStart(2)}  ` +
        `${String(Math.round(r.elapsedMs)).padStart(8)}  ` +
        `${(scalingBaseline.elapsedMs / r.elapsedMs).toFixed(2).padStart(7)}  ` +
        `${String(r.payments).padStart(8)}  ` +
        `${Math.round(r.engineMs).toString().padStart(8)}  ` +
        `${Math.round(r.applyMs).toString().padStart(7)}  ` +
        `${r.avgCpuCores.toFixed(2).padStart(6)}  ` +
        `${Math.round(r.peakRssMiB).toString().padStart(5)}M  ` +
        `${String(r.peakThreads).padStart(7)}  ` +
        `${r.effectiveCores.toFixed(2).padStart(8)}  ` +
        `${r.ingress}+${r.egress}`,
      );
    }
  }

  // Phase details
  for (const r of allowSmoke ? [] : results) {
    if (r.phaseSummary.length === 0) continue;
    console.log(`\nw=${r.workers} phase detail:`);
    console.log('  kind              workMaxMs  shards  workersWithWork');
    for (const p of r.phaseSummary) {
      console.log(
        `  ${p.kind.padEnd(16)}  ${p.workerWorkMaxMs.toFixed(2).padStart(8)}  ` +
        `${String(p.touchedShards).padStart(6)}  ${String(p.workersWithWork).padStart(15)}`,
      );
    }
  }

  // Exact digest verification
  console.log('\n--- EXACT VERIFICATION (compared against recording) ---');
  for (const r of results) {
    console.log(
      `w=${r.workers}: effectDigests=${r.effectDigestsCompared} outboxDigests=${r.outboxDigestsCompared} ` +
      `postState=${r.postStateHashesCompared} runtimeRoots=${r.runtimeRootsCompared}`,
    );
  }

  // Cross-worker digest equality
  const baseline = results[0]!;
  const same = results.every(result =>
    result.payments === baseline.payments &&
    result.frames === baseline.frames &&
    result.accountsRoot === baseline.accountsRoot);
  console.log(`\nDIGEST_EQUALITY w=1/2/4/8: ${same ? 'OK' : 'MISMATCH'}`);
  if (!same) {
    for (const result of results) {
      console.error(
        `w${result.workers}: payments=${result.payments} frames=${result.frames} root=${result.accountsRoot}`,
      );
    }
    process.exitCode = 1;
  }

  // Full JSON output
  console.log(`\nBENCH_COMPLETE ${safeStringify({
    pathsJson,
    evidence: allowSmoke ? 'smoke-parity-only' : 'replay-scaling-diagnostic-not-live-tps',
    results: allowSmoke
      ? results.map(result => ({
          workers: result.workers,
          ok: result.ok,
          frames: result.frames,
          payments: result.payments,
          effectDigestsCompared: result.effectDigestsCompared,
          outboxDigestsCompared: result.outboxDigestsCompared,
          postStateHashesCompared: result.postStateHashesCompared,
          runtimeRootsCompared: result.runtimeRootsCompared,
          accountsRoot: result.accountsRoot,
        }))
      : results,
  })}\n`);
}

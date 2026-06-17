#!/usr/bin/env bun

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

type SoakProfile = 'quick' | 'release' | 'swap';

type SoakCommand = {
  name: string;
  command: string;
  timeoutMs: number;
};

type SoakArgs = {
  profile: SoakProfile;
  iterations: number | null;
  minutes: number | null;
  intervalMs: number;
  outputPath: string;
  streamOutput: boolean;
  keepE2eRuns: number;
  minKeepE2eRuns: number;
  minFreeBytes: number;
};

type SoakResult = {
  iteration: number;
  name: string;
  command: string;
  code: number | null;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  stdoutTail?: string;
  stderrTail?: string;
};

const DEFAULT_OUTPUT = join('.logs', 'soak', `soak-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
const DEFAULT_KEEP_E2E_RUNS = 64;
const DEFAULT_MIN_KEEP_E2E_RUNS = 4;
const DEFAULT_MIN_FREE_BYTES = 8 * 1024 ** 3;
const OUTPUT_TAIL_CHARS = 16_384;

const profileCommands: Record<SoakProfile, SoakCommand[]> = {
  quick: [
    { name: 'persistence WAL smoke', command: 'bun run test:persistence:cli', timeoutMs: 120_000 },
    { name: 'fast E2E matrix', command: 'bun run test:e2e:fast', timeoutMs: 900_000 },
  ],
  release: [
    { name: 'CI gate', command: 'bun run gate:ci', timeoutMs: 1_800_000 },
    { name: 'hub 10k storage benchmark', command: 'bun run bench:radapter:hub10k', timeoutMs: 1_200_000 },
  ],
  swap: [
    { name: 'orderbook core TPS', command: 'bun run bench:swap:orderbook', timeoutMs: 120_000 },
    { name: 'same/cross account TPS', command: 'bun run bench:swap:runtime', timeoutMs: 120_000 },
    { name: 'swap scenario TPS', command: 'bun run bench:swap:scenarios', timeoutMs: 180_000 },
  ],
};

const parseArgs = (): SoakArgs => {
  const flags = new Map<string, string | true>();
  for (let index = 2; index < process.argv.length; index += 1) {
    const current = process.argv[index];
    if (!current) continue;
    if (!current.startsWith('--')) continue;
    const [inlineKeyRaw, inlineValue] = current.split('=', 2);
    const inlineKey = inlineKeyRaw || current;
    if (inlineValue !== undefined) {
      flags.set(inlineKey, inlineValue);
      continue;
    }
    const next = process.argv[index + 1];
    if (!next || next.startsWith('--')) {
      flags.set(current, true);
      continue;
    }
    flags.set(current, next);
    index += 1;
  }

  const rawProfile = String(flags.get('--profile') || 'quick');
  if (rawProfile !== 'quick' && rawProfile !== 'release' && rawProfile !== 'swap') {
    throw new Error(`Invalid --profile=${rawProfile}; expected quick, release, or swap`);
  }

  const iterationsRaw = flags.get('--iterations');
  const minutesRaw = flags.get('--minutes');
  const iterations = iterationsRaw === undefined ? (rawProfile === 'quick' ? 2 : null) : Number(iterationsRaw);
  const minutes = minutesRaw === undefined ? (rawProfile === 'release' ? 240 : rawProfile === 'swap' ? 10 : null) : Number(minutesRaw);
  if (iterations !== null && (!Number.isFinite(iterations) || iterations <= 0)) {
    throw new Error(`Invalid --iterations=${String(iterationsRaw)}`);
  }
  if (minutes !== null && (!Number.isFinite(minutes) || minutes <= 0)) {
    throw new Error(`Invalid --minutes=${String(minutesRaw)}`);
  }

  const intervalMs = Math.max(0, Math.floor(Number(flags.get('--interval-ms') || 0)));
  const outputPath = String(flags.get('--out') || DEFAULT_OUTPUT);
  const streamOutput = flags.has('--stream-output');
  const keepE2eRunsRaw = Number(flags.get('--keep-e2e-runs') || process.env['SOAK_KEEP_E2E_RUNS'] || DEFAULT_KEEP_E2E_RUNS);
  const minKeepE2eRunsRaw = Number(flags.get('--min-keep-e2e-runs') || process.env['SOAK_MIN_KEEP_E2E_RUNS'] || DEFAULT_MIN_KEEP_E2E_RUNS);
  const minFreeBytesRaw = Number(
    flags.get('--min-free-bytes')
      || process.env['SOAK_MIN_FREE_BYTES']
      || process.env['XLN_MIN_DISK_FREE_BYTES']
      || DEFAULT_MIN_FREE_BYTES,
  );
  return {
    profile: rawProfile,
    iterations: iterations === null ? null : Math.floor(iterations),
    minutes: minutes === null ? null : Math.floor(minutes),
    intervalMs,
    outputPath,
    streamOutput,
    keepE2eRuns: Number.isFinite(keepE2eRunsRaw) && keepE2eRunsRaw >= 0
      ? Math.floor(keepE2eRunsRaw)
      : DEFAULT_KEEP_E2E_RUNS,
    minKeepE2eRuns: Number.isFinite(minKeepE2eRunsRaw) && minKeepE2eRunsRaw >= 0
      ? Math.floor(minKeepE2eRunsRaw)
      : DEFAULT_MIN_KEEP_E2E_RUNS,
    minFreeBytes: Number.isFinite(minFreeBytesRaw) && minFreeBytesRaw > 0
      ? Math.max(Math.floor(minFreeBytesRaw), DEFAULT_MIN_FREE_BYTES)
      : DEFAULT_MIN_FREE_BYTES,
  };
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const appendTail = (tail: string, chunk: string): string =>
  `${tail}${chunk}`.slice(-OUTPUT_TAIL_CHARS);

const prefixedOutput = (iteration: number, command: SoakCommand, chunk: string): string =>
  `[soak:${iteration}:${command.name}] ${chunk}`;

const runCommand = async (command: SoakCommand, iteration: number, streamOutput: boolean): Promise<SoakResult> => {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  console.log(`[soak:${iteration}] ${command.name}`);
  console.log(`[soak:${iteration}] ${command.command}`);
  let stdoutTail = '';
  let stderrTail = '';

  const proc: ChildProcessByStdio<null, Readable, Readable> = spawn('sh', ['-lc', command.command], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', chunk => {
    const text = chunk.toString();
    stdoutTail = appendTail(stdoutTail, text);
    if (streamOutput) process.stdout.write(prefixedOutput(iteration, command, text));
  });
  proc.stderr.on('data', chunk => {
    const text = chunk.toString();
    stderrTail = appendTail(stderrTail, text);
    if (streamOutput) process.stderr.write(prefixedOutput(iteration, command, text));
  });

  const timer = setTimeout(() => {
    proc.kill('SIGTERM');
    setTimeout(() => {
      if (proc.exitCode === null) proc.kill('SIGKILL');
    }, 5_000).unref();
  }, command.timeoutMs);
  timer.unref();

  const code = await new Promise<number | null>((resolve, reject) => {
    proc.once('error', reject);
    proc.once('exit', resolve);
  });
  clearTimeout(timer);
  const durationMs = Date.now() - startedAtMs;
  if (code !== 0) {
    if (stdoutTail) process.stdout.write(prefixedOutput(iteration, command, `stdout tail:\n${stdoutTail}`));
    if (stderrTail) process.stderr.write(prefixedOutput(iteration, command, `stderr tail:\n${stderrTail}`));
  }
  console.log(`[soak:${iteration}] ${command.name} code=${code ?? 'signal'} durationMs=${durationMs}`);

  return {
    iteration,
    name: command.name,
    command: command.command,
    code,
    durationMs,
    startedAt,
    finishedAt: new Date().toISOString(),
    ...(stdoutTail ? { stdoutTail } : {}),
    ...(stderrTail ? { stderrTail } : {}),
  };
};

const writeSummary = (path: string, payload: unknown): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
};

type E2eRunForPrune = {
  path: string;
  runId: string;
  completedAtMs: number;
};

const readDiskFreeBytes = (): number => {
  const stat = statfsSync(process.cwd());
  return Number(stat.bavail) * Number(stat.bsize);
};

const readPassedE2eRunForPrune = (path: string, runId: string): E2eRunForPrune | null => {
  const manifestPath = join(path, 'manifest.json');
  if (!existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { status?: unknown; completedAt?: unknown };
    if (manifest.status !== 'passed') return null;
    const completedAtMs =
      typeof manifest.completedAt === 'number' && Number.isFinite(manifest.completedAt)
        ? manifest.completedAt
        : statSync(path).mtimeMs;
    return { path, runId, completedAtMs };
  } catch {
    return null;
  }
};

const pruneSuccessfulE2eRuns = (keepRuns: number, minFreeBytes: number, minKeepRuns: number): void => {
  const root = resolve(process.cwd(), '.logs', 'e2e-parallel');
  if (keepRuns < 0 || !existsSync(root)) {
    const freeBytes = readDiskFreeBytes();
    if (freeBytes < minFreeBytes) {
      throw new Error(`SOAK_INSUFFICIENT_DISK_FREE: free=${String(freeBytes)} required=${String(minFreeBytes)}`);
    }
    return;
  }
  const passedRuns = readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => readPassedE2eRunForPrune(join(root, entry.name), entry.name))
    .filter((entry): entry is E2eRunForPrune => entry !== null)
    .sort((a, b) => b.completedAtMs - a.completedAtMs || b.runId.localeCompare(a.runId));

  const protectedRunCount = Math.max(0, Math.min(minKeepRuns, passedRuns.length));
  const effectiveKeepRuns = Math.max(keepRuns, protectedRunCount);
  const removableByCount = passedRuns.slice(effectiveKeepRuns);
  const removableForDisk = passedRuns.slice(protectedRunCount, effectiveKeepRuns);
  const removable: E2eRunForPrune[] = [...removableByCount];
  let freeBytes = readDiskFreeBytes();
  for (const run of removableForDisk.reverse()) {
    if (freeBytes >= minFreeBytes) break;
    if (removable.some(candidate => candidate.runId === run.runId)) continue;
    removable.push(run);
    rmSync(run.path, { recursive: true, force: true });
    freeBytes = readDiskFreeBytes();
  }
  let removed = 0;
  for (const run of removableByCount) {
    rmSync(run.path, { recursive: true, force: true });
    removed += 1;
  }
  removed += removable.length - removableByCount.length;
  freeBytes = readDiskFreeBytes();
  if (removed > 0) {
    const retained = Math.max(0, passedRuns.length - removed);
    console.log(`[soak] pruned ${removed} successful E2E run(s); retained=${retained} free=${freeBytes} minFree=${minFreeBytes}`);
  }
  if (freeBytes < minFreeBytes) {
    throw new Error(
      `SOAK_INSUFFICIENT_DISK_FREE_AFTER_PRUNE: free=${String(freeBytes)} required=${String(minFreeBytes)} ` +
      `successfulRuns=${String(passedRuns.length)} minKeep=${String(protectedRunCount)}`,
    );
  }
};

const main = async (): Promise<void> => {
  const args = parseArgs();
  const commands = profileCommands[args.profile];
  const startedAt = Date.now();
  const deadline = args.minutes === null ? null : startedAt + args.minutes * 60_000;
  const results: SoakResult[] = [];

  console.log('');
  console.log('='.repeat(76));
  console.log(`XLN soak gate: ${args.profile}`);
  console.log(`mode=${args.iterations !== null ? `${args.iterations} iteration(s)` : `${args.minutes} minute(s)`}`);
  console.log(`summary=${args.outputPath}`);
  console.log(`streamOutput=${args.streamOutput}`);
  console.log(`keepE2eRuns=${args.keepE2eRuns}`);
  console.log(`minKeepE2eRuns=${args.minKeepE2eRuns}`);
  console.log(`minFreeBytes=${args.minFreeBytes}`);
  console.log('='.repeat(76));

  pruneSuccessfulE2eRuns(args.keepE2eRuns, args.minFreeBytes, args.minKeepE2eRuns);

  let iteration = 1;
  while (true) {
    if (args.iterations !== null && iteration > args.iterations) break;
    if (deadline !== null && Date.now() >= deadline) break;

    for (const command of commands) {
      pruneSuccessfulE2eRuns(args.keepE2eRuns, args.minFreeBytes, args.minKeepE2eRuns);
      const result = await runCommand(command, iteration, args.streamOutput);
      results.push(result);
      writeSummary(args.outputPath, {
        profile: args.profile,
        startedAt: new Date(startedAt).toISOString(),
        updatedAt: new Date().toISOString(),
        complete: false,
        results,
      });
      if (result.code !== 0) {
        console.error(`[soak] failed: ${command.name} code=${result.code ?? 'signal'}`);
        process.exit(result.code ?? 1);
      }
      pruneSuccessfulE2eRuns(args.keepE2eRuns, args.minFreeBytes, args.minKeepE2eRuns);
      if (deadline !== null && Date.now() >= deadline) break;
    }

    iteration += 1;
    if (args.intervalMs > 0 && (args.iterations === null || iteration <= args.iterations)) {
      await sleep(args.intervalMs);
    }
  }

  const payload = {
    profile: args.profile,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    complete: true,
    iterationsCompleted: Math.max(0, iteration - 1),
    durationMs: Date.now() - startedAt,
    results,
  };
  writeSummary(args.outputPath, payload);
  console.log('');
  console.log('='.repeat(76));
  console.log(`XLN soak gate passed: ${results.length} command run(s)`);
  console.log(`summary=${args.outputPath}`);
  console.log('='.repeat(76));
};

main().catch((error) => {
  console.error('soak gate failed:', error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});

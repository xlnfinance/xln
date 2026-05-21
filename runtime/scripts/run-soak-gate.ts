#!/usr/bin/env bun

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

type SoakProfile = 'quick' | 'release';

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
};

type SoakResult = {
  iteration: number;
  name: string;
  command: string;
  code: number | null;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
};

const DEFAULT_OUTPUT = join('.logs', 'soak', `soak-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);

const profileCommands: Record<SoakProfile, SoakCommand[]> = {
  quick: [
    { name: 'persistence WAL smoke', command: 'bun run test:persistence:cli', timeoutMs: 120_000 },
    { name: 'fast E2E matrix', command: 'bun run test:e2e:fast', timeoutMs: 900_000 },
  ],
  release: [
    { name: 'CI gate', command: 'bun run gate:ci', timeoutMs: 1_800_000 },
    { name: 'hub 10k storage benchmark', command: 'bun run bench:radapter:hub10k', timeoutMs: 1_200_000 },
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
  if (rawProfile !== 'quick' && rawProfile !== 'release') {
    throw new Error(`Invalid --profile=${rawProfile}; expected quick or release`);
  }

  const iterationsRaw = flags.get('--iterations');
  const minutesRaw = flags.get('--minutes');
  const iterations = iterationsRaw === undefined ? (rawProfile === 'quick' ? 2 : null) : Number(iterationsRaw);
  const minutes = minutesRaw === undefined ? (rawProfile === 'release' ? 240 : null) : Number(minutesRaw);
  if (iterations !== null && (!Number.isFinite(iterations) || iterations <= 0)) {
    throw new Error(`Invalid --iterations=${String(iterationsRaw)}`);
  }
  if (minutes !== null && (!Number.isFinite(minutes) || minutes <= 0)) {
    throw new Error(`Invalid --minutes=${String(minutesRaw)}`);
  }

  const intervalMs = Math.max(0, Math.floor(Number(flags.get('--interval-ms') || 0)));
  const outputPath = String(flags.get('--out') || DEFAULT_OUTPUT);
  return {
    profile: rawProfile,
    iterations: iterations === null ? null : Math.floor(iterations),
    minutes: minutes === null ? null : Math.floor(minutes),
    intervalMs,
    outputPath,
  };
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const runCommand = async (command: SoakCommand, iteration: number): Promise<SoakResult> => {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  console.log(`[soak:${iteration}] ${command.name}`);
  console.log(`[soak:${iteration}] ${command.command}`);

  const proc: ChildProcessByStdio<null, Readable, Readable> = spawn('sh', ['-lc', command.command], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', chunk => process.stdout.write(`[soak:${iteration}:${command.name}] ${chunk.toString()}`));
  proc.stderr.on('data', chunk => process.stderr.write(`[soak:${iteration}:${command.name}] ${chunk.toString()}`));

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

  return {
    iteration,
    name: command.name,
    command: command.command,
    code,
    durationMs: Date.now() - startedAtMs,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
};

const writeSummary = (path: string, payload: unknown): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
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
  console.log('='.repeat(76));

  let iteration = 1;
  while (true) {
    if (args.iterations !== null && iteration > args.iterations) break;
    if (deadline !== null && Date.now() >= deadline) break;

    for (const command of commands) {
      const result = await runCommand(command, iteration);
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

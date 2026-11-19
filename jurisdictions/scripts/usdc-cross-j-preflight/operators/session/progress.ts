#!/usr/bin/env bun
import { realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { requireBoundaryInteger, requireBoundaryRecord } from '../../../../../core/protocol/boundary-validation';
import { networks } from '../../identities';

const usage = 'Usage: bun jurisdictions/scripts/usdc-cross-j-preflight/operators/session/progress.ts <job-or-session-directory> [--watch]';
const rangeMarker = ' watcher.authenticated_range ';
const formatBlock = new Intl.NumberFormat('en-US');

type Scan = { firstBlock: number; through: number; certifiedBeforeRange: number };
type Session = { directory: string | null; ready: boolean; exitCode: number | null; failure: string | null };

const readOptional = async (file: string): Promise<string | null> => {
  try {
    return await Bun.file(file).text();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};

const readExitCode = (text: string | null): number | null => {
  if (!text?.trim()) return null;
  if (!/^\d+$/.test(text.trim())) throw new Error('PROGRESS_INVALID_EXIT_STATUS');
  return requireBoundaryInteger(Number(text.trim()), 'PROGRESS_INVALID_EXIT_STATUS');
};

const readSession = async (path: string): Promise<Session> => {
  if (basename(path).startsWith('restore-')) {
    const ready = await Bun.file(join(path, 'session.json')).exists();
    return { directory: path, ready, exitCode: null, failure: null };
  }
  const launcher = await Bun.file(join(path, 'launcher.log')).text();
  const exitCode = readExitCode(await readOptional(join(path, 'exit-status')));
  const failure = /^error: ((?:USDC_SESSION|STAND_LOCK)_[A-Z_]+(?::[a-z0-9:-]+)?)/m.exec(launcher)?.[1] ?? null;
  const marker = /^USDC_SESSION_DIRECTORY:([^\r\n]+)\r?\n/m.exec(launcher)?.[1];
  if (!marker) return { directory: null, ready: false, exitCode, failure };

  const directory = realpathSync(marker);
  if (dirname(directory) !== dirname(path) || !basename(directory).startsWith('restore-'))
    throw new Error('PROGRESS_SESSION_OUTSIDE_JOB_DIRECTORY');
  const ready = launcher.split(/\r?\n/).includes(`USDC_SESSION_READY:${marker}`);
  return { directory, ready, exitCode, failure };
};

const readScans = (log: string): Map<number, Scan> => {
  const scans = new Map<number, Scan>();
  const lines = log.split('\n');
  lines.pop(); // The Runtime may still be writing the last line.
  for (const line of lines) {
    const offset = line.indexOf(rangeMarker);
    if (offset < 0) continue;
    const event = requireBoundaryRecord(JSON.parse(line.slice(offset + rangeMarker.length)), 'PROGRESS_INVALID_RANGE');
    const chainId = requireBoundaryInteger(event['chainId'], 'PROGRESS_INVALID_CHAIN', 1);
    const from = requireBoundaryInteger(event['fromBlock'], 'PROGRESS_INVALID_FROM_BLOCK', 1);
    const through = requireBoundaryInteger(event['toBlock'], 'PROGRESS_INVALID_TO_BLOCK', from);
    const certifiedBeforeRange = requireBoundaryInteger(event['committedBeforeRange'], 'PROGRESS_INVALID_CERTIFIED_CURSOR');
    scans.set(chainId, { firstBlock: scans.get(chainId)?.firstBlock ?? from, through, certifiedBeforeRange });
  }
  return scans;
};

const showOperator = async (directory: string, role: 'hub' | 'mm'): Promise<void> => {
  const label = role === 'hub' ? 'Hub' : 'MM';
  const log = await readOptional(join(directory, `${role}.log`));
  if (log === null) {
    console.log(`${label}  Runtime log pending`);
    return;
  }
  const proof = await readOptional(join(directory, `${role}-restored.json`));
  const restored = proof === null ? null : requireBoundaryRecord(JSON.parse(proof), 'PROGRESS_INVALID_RESTORE_PROOF');
  const height = restored && requireBoundaryInteger(restored['height'], 'PROGRESS_INVALID_RESTORED_FRAME');
  console.log(height === null ? label : `${label} (WAL frame at startup ${formatBlock.format(height)})`);
  const scans = readScans(log);
  for (const chain of networks) {
    const scan = scans.get(chain.chainId);
    if (!scan) {
      console.log(`  ${chain.name}  No authenticated range yet`);
      continue;
    }
    const first = formatBlock.format(scan.firstBlock);
    const through = formatBlock.format(scan.through);
    const cursor = formatBlock.format(scan.certifiedBeforeRange);
    console.log(`  ${chain.name}  first ${first} | authenticated through ${through} | last reported certified cursor ${cursor}`);
  }
};

const showProgress = async (path: string): Promise<Session> => {
  const session = await readSession(path);
  console.log(`[${new Date().toISOString()}]`);
  console.log(session.directory ?? path);
  if (session.exitCode !== null) {
    console.log(`Launcher exited (${session.exitCode})${session.failure ? ` - ${session.failure}` : ''}`);
  } else {
    console.log(session.ready ? 'Readiness recorded' : 'Readiness pending');
  }
  if (session.directory) {
    await showOperator(session.directory, 'hub');
    await showOperator(session.directory, 'mm');
  }
  return session;
};

const main = async (): Promise<void> => {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: { watch: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
    allowPositionals: true,
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  const [directory, extra] = positionals;
  if (!directory || extra !== undefined) throw new Error(usage);

  const path = realpathSync(directory);
  while (true) {
    const session = await showProgress(path);
    if (!values.watch || session.exitCode !== null) return;
    await Bun.sleep(10_000);
  }
};

await main();

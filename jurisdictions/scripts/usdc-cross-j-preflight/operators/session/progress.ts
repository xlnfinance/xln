#!/usr/bin/env bun
import { realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { requireBoundaryInteger, requireBoundaryRecord } from '../../../../../core/protocol/boundary-validation';
import { networks } from '../../identities';
import { releaseUserDelivery, userCaughtUp } from '../../execution/flow/operator-barrier';
import { completeLogLines, readCatchUp, readRunProgress, readSlots, type Scan } from './progress-log';
import { readRpcTimings } from './progress-rpc';

const usage =
  'Usage: bun jurisdictions/scripts/usdc-cross-j-preflight/operators/session/progress.ts <job-or-session-directory> [--watch]';
const formatBlock = new Intl.NumberFormat('en-US');

const labels = { hub: 'Hub', mm: 'MM', user: 'User' } as const;
type Role = keyof typeof labels;
type Session = {
  directory: string | null;
  ready: boolean;
  exitCode: number | null;
  failure: string | null;
  journey: boolean;
  run: ReturnType<typeof readRunProgress>;
};

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

const restoreDirectory = (path: string, log: string) => {
  const marker = /^USDC_SESSION_DIRECTORY:([^\r\n]+)\r?\n/m.exec(log)?.[1];
  if (!marker) return null;
  const directory = realpathSync(marker);
  if (dirname(directory) !== dirname(path) || !basename(directory).startsWith('restore-'))
    throw new Error('PROGRESS_SESSION_OUTSIDE_JOB_DIRECTORY');
  return { directory, marker };
};

const readSession = async (path: string): Promise<Session> => {
  if (basename(path).startsWith('restore-')) {
    const ready = await Bun.file(join(path, 'session.json')).exists();
    return { directory: path, ready, exitCode: null, failure: null, journey: false, run: null };
  }
  const journey = basename(path).startsWith('journey-');
  const launcher = await readOptional(join(path, 'launcher.log'));
  if (!journey && launcher === null) throw new Error('PROGRESS_LAUNCHER_LOG_REQUIRED');
  const supervisor = journey ? await readOptional(join(path, 'supervisor.log')) : launcher;
  const exitCode = readExitCode(await readOptional(join(path, 'exit-status')));
  const failure =
    /^error: ((?:USDC_(?:SESSION|EXECUTION)|STAND_LOCK)_[A-Z_]+(?::[a-z0-9:-]+)?)/m.exec(
      `${launcher ?? ''}\n${supervisor ?? ''}`,
    )?.[1] ?? null;
  const restore = restoreDirectory(path, supervisor ?? '');
  const ready = restore !== null && completeLogLines(supervisor ?? '').includes(`USDC_SESSION_READY:${restore.marker}`);
  return {
    directory: restore?.directory ?? null,
    ready,
    exitCode,
    failure,
    journey,
    run: readRunProgress(launcher ?? ''),
  };
};

const roleStage = (role: Role, lines: readonly string[], complete: boolean | null, userReady: boolean) => {
  const has = (marker: string) => lines.some(line => line.includes(marker));
  if (role === 'hub' && has(' runtime.ready ')) return 'readiness recorded';
  if (role === 'mm') {
    if (has(' offers.ready ')) return 'offers ready';
    if (has(' bootstrap.hub_routes_waiting ') && !has(' bootstrap.hub_routes_ready ')) return 'waiting for Hub routes';
  }
  if (role === 'user') {
    const lastStage = lines.findLast(line => /^USDC_POC_STAGE:[a-z0-9-]+$/.test(line));
    if (lastStage) return `last completed stage ${lastStage.slice('USDC_POC_STAGE:'.length)}`;
    if (userReady) return 'relay connected';
    if (lines.includes(releaseUserDelivery)) return 'checking latest J suffix';
    if (lines.includes(userCaughtUp)) return 'waiting for operator readiness';
  }
  if (complete === true || has(' startup.j_catchup_ready ')) return 'J catch-up complete';
  return complete === false ? 'authenticating J history' : 'restoring or checking startup';
};

const showScan = (name: string, scan: Scan | undefined): void => {
  if (!scan) {
    console.log(`  ${name}  No authenticated range yet`);
    return;
  }
  const parts = [];
  if (scan.first !== null) parts.push(`first ${formatBlock.format(scan.first)}`);
  parts.push(scan.through > 0 ? `authenticated through ${formatBlock.format(scan.through)}` : 'authentication pending');
  parts.push(`last reported committed cursor ${formatBlock.format(scan.cursor)}`);
  if (scan.target !== null) {
    parts.push(`startup target ${formatBlock.format(scan.target)}`);
    if (scan.through > 0) parts.push(`${formatBlock.format(Math.max(0, scan.target - scan.through))} blocks remaining`);
  }
  console.log(`  ${name}  ${parts.join(' | ')}`);
};

const showRole = async (directory: string, role: Role, log: string | null): Promise<void> => {
  const label = labels[role];
  if (log === null) {
    console.log(`${label}  Runtime log unavailable`);
    return;
  }
  const proof = await readOptional(join(directory, `${role}-restored.json`));
  const restored = proof === null ? null : requireBoundaryRecord(JSON.parse(proof), 'PROGRESS_INVALID_RESTORE_PROOF');
  const height = restored && requireBoundaryInteger(restored['height'], 'PROGRESS_INVALID_RESTORED_FRAME');
  const lines = completeLogLines(log);
  const { scans, complete } = readCatchUp(lines);
  const userReady = role === 'user' && (await Bun.file(join(directory, 'user-ready.json')).exists());
  const stage = roleStage(role, lines, complete, userReady);
  const startup = height === null ? '' : ` (WAL frame at startup ${formatBlock.format(height)})`;
  console.log(`${label}  ${stage}${startup}`);
  for (const chain of networks) showScan(chain.name, scans.get(chain.chainId));
};

const showGateway = (gateway: string, execution: string, session: Session): void => {
  const timings = readRpcTimings(gateway);
  if (timings.size) {
    console.log('RPC timing, latest samples');
    for (const [name, { queueMs, upstreamMs }] of timings)
      console.log(`  ${name}  queue ${formatBlock.format(queueMs)} ms | upstream ${formatBlock.format(upstreamMs)} ms`);
  }
  const slots = readSlots(gateway, execution, session.run?.runId);
  if (slots.length) {
    console.log('Transaction slots');
    for (const slot of slots) {
      const chain = networks.find(chain => chain.chainId === slot.chainId)?.name ?? String(slot.chainId);
      console.log(`  ${chain}  ${slot.step} nonce ${slot.nonce}  ${slot.status}${slot.hash ? `  ${slot.hash}` : ''}`);
    }
  } else if (session.journey) {
    console.log('No transaction slot events recorded');
  }
};

const showSessionDetails = async (directory: string, path: string, session: Session): Promise<void> => {
  const [hub, mm, user, gateway] = await Promise.all([
    readOptional(join(directory, 'hub.log')),
    readOptional(join(directory, 'mm.log')),
    readOptional(session.journey ? join(path, 'execution.log') : join(directory, 'user.log')),
    readOptional(join(directory, 'gateway.log')),
  ]);
  await showRole(directory, 'hub', hub);
  await showRole(directory, 'mm', mm);
  await showRole(directory, 'user', user);
  showGateway(gateway ?? '', session.journey ? (user ?? '') : '', session);
};

const showProgress = async (path: string): Promise<Session> => {
  const session = await readSession(path);
  console.log(`[${new Date().toISOString()}]`);
  console.log(session.directory ?? path);
  if (session.exitCode !== null) {
    console.log(`Launcher exited (${session.exitCode})${session.failure ? ` - ${session.failure}` : ''}`);
  } else {
    const subject = session.journey ? 'Operator readiness' : 'Readiness';
    console.log(`${subject} ${session.ready ? 'recorded' : 'pending'}`);
  }
  if (session.run) {
    const { runId, expiresAt } = session.run;
    const remaining = Math.ceil((expiresAt - Date.now()) / 1_000);
    console.log(
      `Run ${runId} | authority expires ${new Date(expiresAt).toISOString()}${
        remaining > 0 ? ` (${formatBlock.format(remaining)} s remaining)` : ' (expired)'
      }`,
    );
  }
  if (session.directory) await showSessionDetails(session.directory, path, session);
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

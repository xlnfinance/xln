import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { safeStringify } from '../../../../../core/protocol/serialization';
import { acquireStandLock, inheritedStandLock } from '../../../../../tools/stand-lock';
import { runStandChild } from '../../../../../tools/stand/run';
import { sessionArgs, sessionWatcherEnv, type SessionConfig } from '../../operators/session/config';
import {
  launchSessionChild,
  sessionChildShutdownGraceMs,
  stopSessionChildren,
  waitSessionReady,
  type ManagedChild,
} from '../../operators/session/processes';
import { readAuthority, requireCurrentAuthority } from '../authority';
import type { ExecutionConfig } from '../config';
import { runProgressMarker } from './progress-events';
import { releaseUserDelivery, supervisedExecutionEnv, userCaughtUp } from './operator-barrier';
import { reasonText, throwAfter, withCleanup } from './run-report';

const entry = 'jurisdictions/scripts/usdc-cross-j-preflight/execution/index.ts';

const launchExecution = (children: ManagedChild[], logs: string, config: ExecutionConfig): ManagedChild =>
  launchSessionChild(
    children,
    logs,
    'execution',
    entry,
    [
      'run',
      '--directory',
      config.directory,
      '--user-store',
      config.store,
      '--api-base',
      config.apiBase,
      '--hub-url',
      config.hubUrl,
      '--authority-file',
      config.authorityPath,
      '--run-id',
      config.runId,
      '--output',
      config.output,
    ],
    {
      PATH: process.env['PATH'],
      HOME: process.env['HOME'],
      TMPDIR: process.env['TMPDIR'],
      XLN_ORCHESTRATOR_PID: String(process.pid),
      [supervisedExecutionEnv]: '1',
      ...sessionWatcherEnv(),
    },
    { ipc: true },
  );

const remainingMs = (deadline: number): number => Math.max(1, deadline - Date.now());

const requireUnexpired = (expiresAt: number): void => {
  if (Date.now() >= expiresAt) throw new Error('USDC_EXECUTION_AUTHORITY_EXPIRED');
};

const operatorReady = (logs: string, marker: RegExp): boolean =>
  marker.test(readFileSync(join(logs, 'supervisor.log'), 'utf8'));

const releaseWhenReady = async (
  children: ManagedChild[],
  runner: ManagedChild,
  logs: string,
  startupDeadline: number,
  expiresAt: number,
): Promise<void> => {
  let caughtUp = false;
  runner.child.on('message', (message: unknown) => {
    if (message !== userCaughtUp || caughtUp) runner.error = new Error('USDC_EXECUTION_USER_IPC_INVALID');
    else caughtUp = true;
  });
  await waitSessionReady(
    children,
    'supervisor',
    async () => {
      requireUnexpired(expiresAt);
      return operatorReady(logs, /^USDC_SESSION_READY:/m);
    },
    remainingMs(startupDeadline),
  );
  await waitSessionReady(
    children,
    'user-catch-up',
    async () => {
      requireUnexpired(expiresAt);
      return caughtUp;
    },
    remainingMs(expiresAt),
  );
  requireUnexpired(expiresAt);
  await new Promise<void>((resolve, reject) =>
    runner.child.send(releaseUserDelivery, error => (error ? reject(error) : resolve())),
  );
};

const supervise = async (config: ExecutionConfig, session: SessionConfig, expiresAt: number): Promise<void> => {
  const root = join(config.directory, 'sessions');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const logs = mkdtempSync(join(root, 'journey-'));
  const launcher = join(logs, 'launcher.log');
  writeFileSync(launcher, runProgressMarker + safeStringify({ runId: config.runId, expiresAt }) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
  console.log(`USDC_EXECUTION_LOG_DIRECTORY:${logs}`);
  const children: ManagedChild[] = [];
  let stop!: (error: Error) => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    stop = reject;
  });
  const onStop = () => stop(new Error('USDC_EXECUTION_SUPERVISION_INTERRUPTED'));
  process.on('SIGINT', onStop);
  process.on('SIGTERM', onStop);
  await withCleanup(
    async () => {
      const startupDeadline = Math.min(Date.now() + session.startupTimeoutMs * 5, expiresAt);
      const supervisor = launchSessionChild(
        children,
        logs,
        'supervisor',
        'jurisdictions/scripts/usdc-cross-j-preflight/operators/session/index.ts',
        sessionArgs({ ...session, runId: config.runId }),
        process.env,
        // The supervisor must finish stopping MM, Hub and gateway before it releases the stores.
        { shutdownGraceMs: 3 * sessionChildShutdownGraceMs + 5_000 },
      );
      await Promise.race([
        interrupted,
        waitSessionReady(
          [supervisor],
          'gateway',
          async () => {
            requireUnexpired(expiresAt);
            return operatorReady(logs, /^USDC_SESSION_GATEWAY_READY:/m);
          },
          remainingMs(startupDeadline),
        ),
      ]);
      requireUnexpired(expiresAt);
      const runner = launchExecution(children, logs, config);
      await Promise.race([interrupted, releaseWhenReady(children, runner, logs, startupDeadline, expiresAt)]);
      await Promise.race([
        interrupted,
        waitSessionReady(
          [supervisor],
          'financial-run',
          async () => {
            if (runner.error) throw runner.error;
            if (runner.child.exitCode === 0) return true;
            if (runner.child.exitCode !== null || runner.child.signalCode !== null)
              throw new Error(`USDC_EXECUTION_CHILD_FAILED:${join(logs, 'execution.log')}`);
            return false;
          },
          remainingMs(expiresAt + 90_000),
        ),
      ]);
      console.log(`USDC_EXECUTION_SUPERVISED_COMPLETE:${config.runId}:${config.output}`);
    },
    async () => {
      try {
        await stopSessionChildren(children);
      } finally {
        process.off('SIGINT', onStop);
        process.off('SIGTERM', onStop);
      }
    },
  ).catch(error =>
    throwAfter(error, () => {
      const failure =
        reasonText(error).match(/^(?:USDC_|STAND_LOCK_)[A-Z_]+/)?.[0] ?? 'USDC_EXECUTION_SUPERVISION_FAILED';
      appendFileSync(launcher, `error: ${failure}\n`);
      writeFileSync(join(logs, 'exit-status'), '1\n', { mode: 0o600, flag: 'wx' });
    }),
  );
  writeFileSync(join(logs, 'exit-status'), '0\n', { mode: 0o600, flag: 'wx' });
};

export const runSupervised = async (config: ExecutionConfig, session: SessionConfig): Promise<void> => {
  const authority = readAuthority(config.authorityPath);
  requireCurrentAuthority(authority, join(config.directory, 'jurisdictions.json'));
  if (!authority.runIds.includes(config.runId)) throw new Error('USDC_EXECUTION_RUN_NOT_AUTHORIZED');
  if (authority.apiBase !== config.apiBase) throw new Error('USDC_EXECUTION_API_BINDING_MISMATCH');
  if (inheritedStandLock()) return supervise(config, session, authority.expiresAt);
  const lease = await acquireStandLock({ reason: 'usdc-execution', waitMs: 0 });
  const code = await runStandChild(
    lease,
    [process.execPath, entry, ...process.argv.slice(2)],
    Math.min(2_147_483_647, Math.max(1, authority.expiresAt - Date.now() + 120_000)),
  );
  if (code !== 0) process.exitCode = code;
};

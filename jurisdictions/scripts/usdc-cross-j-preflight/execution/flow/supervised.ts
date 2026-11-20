import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireStandLock, inheritedStandLock } from '../../../../../tools/stand-lock';
import { runStandChild } from '../../../../../tools/stand/run';
import { sessionArgs, type SessionConfig } from '../../operators/session/config';
import {
  launchSessionChild,
  stopSessionChildren,
  waitSessionReady,
  type ManagedChild,
} from '../../operators/session/processes';
import { readAuthority, requireCurrentAuthority } from '../authority';
import type { ExecutionConfig } from '../config';
import { withCleanup } from './run-report';

const entry = 'jurisdictions/scripts/usdc-cross-j-preflight/execution/index.ts';

const supervise = async (config: ExecutionConfig, session: SessionConfig, expiresAt: number): Promise<void> => {
  const root = join(config.directory, 'sessions');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const logs = mkdtempSync(join(root, 'journey-'));
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
      const supervisor = launchSessionChild(
        children,
        logs,
        'supervisor',
        'jurisdictions/scripts/usdc-cross-j-preflight/operators/session/index.ts',
        sessionArgs({ ...session, runId: config.runId }),
        process.env,
      );
      await Promise.race([
        interrupted,
        waitSessionReady(
          [supervisor],
          'supervisor',
          async () => /^USDC_SESSION_READY:/m.test(readFileSync(join(logs, 'supervisor.log'), 'utf8')),
          Math.max(1, Math.min(session.startupTimeoutMs * 5, expiresAt - Date.now())),
        ),
      ]);
      const runner = launchSessionChild(
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
        },
      );
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
          Math.max(1, expiresAt - Date.now() + 90_000),
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
  );
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

import { readFileSync } from 'node:fs';
import { createStructuredLogger } from '../infra/logger';

const DEFAULT_PARENT_WATCH_MS = 5_000;
const parentWatchLog = createStructuredLogger('orchestrator.parent_watch');

const readLinuxProcessStartTicks = (pid: number): string | null => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const endComm = stat.lastIndexOf(')');
    if (endComm < 0) return null;
    const fields = stat.slice(endComm + 2).trim().split(/\s+/);
    return fields[19] ?? null;
  } catch {
    return null;
  }
};

export const startParentLivenessWatch = (
  label: string,
  parentPidRaw: string | number | undefined,
  onParentLost: () => void,
  intervalMs: number = DEFAULT_PARENT_WATCH_MS,
): (() => void) => {
  const parentPid = Number(parentPidRaw || 0);
  if (!Number.isInteger(parentPid) || parentPid <= 1) {
    if (process.env['XLN_ALLOW_ORPHAN_RUNTIME'] === '1') {
      parentWatchLog.warn('disabled_missing_parent_pid', { label, parentPidRaw });
      return () => {};
    }
    let stopping = false;
    queueMicrotask(() => {
      if (stopping) return;
      stopping = true;
      parentWatchLog.error('missing_parent_pid', { label, parentPidRaw });
      onParentLost();
    });
    return () => {
      stopping = true;
    };
  }

  const parentStartTicks = readLinuxProcessStartTicks(parentPid);
  let stopping = false;
  const timer = setInterval(() => {
    if (stopping) return;
    if (process.ppid === 1) {
      stopping = true;
      parentWatchLog.error('parent_missing_ppid_one', { label, parentPid });
      onParentLost();
      return;
    }
    try {
      process.kill(parentPid, 0);
      const currentStartTicks = readLinuxProcessStartTicks(parentPid);
      if (parentStartTicks && currentStartTicks && currentStartTicks !== parentStartTicks) {
        stopping = true;
        parentWatchLog.error('parent_pid_reused', { label, parentPid });
        onParentLost();
      }
    } catch {
      stopping = true;
      parentWatchLog.error('parent_pid_missing', { label, parentPid });
      onParentLost();
    }
  }, intervalMs);

  timer.unref?.();

  return () => {
    stopping = true;
    clearInterval(timer);
  };
};

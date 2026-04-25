import { readFileSync } from 'node:fs';

const DEFAULT_PARENT_WATCH_MS = 5_000;

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
      console.warn(`[${label}] XLN_ORCHESTRATOR_PID missing/invalid; XLN_ALLOW_ORPHAN_RUNTIME=1 so parent-watch is disabled`);
      return () => {};
    }
    let stopping = false;
    queueMicrotask(() => {
      if (stopping) return;
      stopping = true;
      console.error(`[${label}] XLN_ORCHESTRATOR_PID missing/invalid (${String(parentPidRaw)}), exiting to avoid orphan runtime`);
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
      console.error(`[${label}] orchestrator parent missing (ppid=1), exiting`);
      onParentLost();
      return;
    }
    try {
      process.kill(parentPid, 0);
      const currentStartTicks = readLinuxProcessStartTicks(parentPid);
      if (parentStartTicks && currentStartTicks && currentStartTicks !== parentStartTicks) {
        stopping = true;
        console.error(`[${label}] orchestrator parent pid=${parentPid} was reused, exiting`);
        onParentLost();
      }
    } catch {
      stopping = true;
      console.error(`[${label}] orchestrator parent pid=${parentPid} missing, exiting`);
      onParentLost();
    }
  }, intervalMs);

  timer.unref?.();

  return () => {
    stopping = true;
    clearInterval(timer);
  };
};

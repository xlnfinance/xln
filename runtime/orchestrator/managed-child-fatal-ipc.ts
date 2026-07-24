import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export type ManagedChildFatalReport = {
  type: 'xln:managed-child-fatal';
  reportId: string;
  runtimeId: string;
  code: string;
  message: string;
  height: number;
  timestamp: number;
};

type ManagedChildFatalAck = {
  type: 'xln:managed-child-fatal-ack';
  reportId: string;
  persisted: boolean;
  fingerprint?: string;
  error?: string;
};

type IpcProcess = NodeJS.Process & {
  connected?: boolean;
  send?: (
    message: unknown,
    callback?: (error: Error | null) => void,
  ) => boolean;
};

const boundedText = (value: unknown, maxLength: number): string =>
  typeof value === 'string' ? value.trim().slice(0, maxLength) : '';

const finiteNonNegativeInt = (value: unknown): number => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
};

export const parseManagedChildFatalReport = (value: unknown): ManagedChildFatalReport | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record['type'] !== 'xln:managed-child-fatal') return null;
  const reportId = boundedText(record['reportId'], 200);
  const code = boundedText(record['code'], 200);
  const message = boundedText(record['message'], 2000);
  if (!reportId || !code || !message) return null;
  return {
    type: 'xln:managed-child-fatal',
    reportId,
    runtimeId: boundedText(record['runtimeId'], 200),
    code,
    message,
    height: finiteNonNegativeInt(record['height']),
    timestamp: finiteNonNegativeInt(record['timestamp']),
  };
};

const parseAck = (value: unknown, reportId: string): ManagedChildFatalAck | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record['type'] !== 'xln:managed-child-fatal-ack' || record['reportId'] !== reportId) return null;
  return {
    type: 'xln:managed-child-fatal-ack',
    reportId,
    persisted: record['persisted'] === true,
    ...(typeof record['fingerprint'] === 'string' ? { fingerprint: record['fingerprint'] } : {}),
    ...(typeof record['error'] === 'string' ? { error: record['error'] } : {}),
  };
};

export const reportManagedChildFatal = (
  payload: Omit<ManagedChildFatalReport, 'type' | 'reportId'>,
  timeoutMs = 3_000,
  ipcProcess = process as IpcProcess,
): Promise<string> => {
  if (ipcProcess.connected !== true || typeof ipcProcess.send !== 'function') {
    return Promise.reject(new Error('MANAGED_CHILD_FATAL_IPC_UNAVAILABLE'));
  }
  const reportId = randomUUID();
  const report: ManagedChildFatalReport = {
    type: 'xln:managed-child-fatal',
    reportId,
    ...payload,
  };
  return new Promise((resolve, reject) => {
    const finish = (error: Error | null, fingerprint = ''): void => {
      clearTimeout(timer);
      ipcProcess.off('message', onMessage);
      if (error) reject(error);
      else resolve(fingerprint);
    };
    const onMessage = (message: unknown): void => {
      const ack = parseAck(message, reportId);
      if (!ack) return;
      if (!ack.persisted) {
        finish(new Error(`MANAGED_CHILD_FATAL_IPC_REJECTED:${ack.error || 'unknown'}`));
        return;
      }
      finish(null, ack.fingerprint || '');
    };
    const timer = setTimeout(
      () => finish(new Error('MANAGED_CHILD_FATAL_IPC_ACK_TIMEOUT')),
      Math.max(1, Math.floor(timeoutMs)),
    );
    ipcProcess.on('message', onMessage);
    ipcProcess.send?.(report, (error) => {
      if (error) finish(new Error(`MANAGED_CHILD_FATAL_IPC_SEND_FAILED:${error.message}`));
    });
  });
};

export const attachManagedChildFatalIpc = (
  child: ChildProcess,
  persist: (report: ManagedChildFatalReport) => string,
): (() => void) => {
  const onMessage = (message: unknown): void => {
    const report = parseManagedChildFatalReport(message);
    if (!report) return;
    let ack: ManagedChildFatalAck;
    try {
      ack = {
        type: 'xln:managed-child-fatal-ack',
        reportId: report.reportId,
        persisted: true,
        fingerprint: persist(report),
      };
    } catch (error) {
      ack = {
        type: 'xln:managed-child-fatal-ack',
        reportId: report.reportId,
        persisted: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    child.send?.(ack);
  };
  child.on('message', onMessage);
  return () => child.off('message', onMessage);
};

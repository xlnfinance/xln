/**
 * XLN Structured Logging System
 *
 * Frame-scoped deterministic logs that travel with snapshots for time-travel debugging.
 *
 * Usage:
 *   import { xlog } from './log';
 *   xlog.info('consensus', 'Entity committed frame', { entityId, frame });
 *   xlog.warn('account', 'Delta mismatch detected', { expected, actual });
 */

import type { Env, LogLevel, LogCategory, FrameLogEntry } from './types';

const getLogState = (env: Env) => {
  if (!env.runtimeState) env.runtimeState = {};
  if (!env.runtimeState.logState) {
    env.runtimeState.logState = { nextId: 0, mirrorToConsole: true };
  }
  return env.runtimeState.logState;
};

/**
 * Enable/disable console mirroring for a specific runtime.
 */
export const setMirrorToConsole = (env: Env, enabled: boolean): void => {
  const logState = getLogState(env);
  logState.mirrorToConsole = enabled;
};

/**
 * Flush current frame logs and reset buffer.
 * Called by captureSnapshot before capturing.
 */
export const flushFrameLogs = (env: Env): FrameLogEntry[] => {
  const logs = [...env.frameLogs];
  env.frameLogs = [];
  return logs;
};

/**
 * Core logging function.
 */
const log = (
  env: Env,
  level: LogLevel,
  category: LogCategory,
  message: string,
  data?: Record<string, unknown>,
  entityId?: string,
): void => {
  const logState = getLogState(env);
  const entry: FrameLogEntry = {
    id: logState.nextId++,
    timestamp: env.timestamp ?? 0,
    level,
    category,
    message,
    ...(entityId && { entityId }),
    ...(data && { data }),
  };

  // Add to frame buffer if env is set
  env.frameLogs.push(entry);

  // Mirror to DevTools console
  if (logState.mirrorToConsole) {
    const prefix = `[${level.toUpperCase()}][${category}]`;
    const consoleMethod = level === 'error' ? console.error
      : level === 'warn' ? console.warn
      : level === 'debug' || level === 'trace' ? console.debug
      : console.log;

    if (data) {
      consoleMethod(prefix, message, data);
    } else {
      consoleMethod(prefix, message);
    }
  }
};

/**
 * Structured logging API.
 *
 * @example
 * xlog.info('consensus', 'Frame committed', { entityId, height });
 * xlog.error('evm', 'Transaction reverted', { txHash, reason });
 */
export const createLogger = (env: Env) => ({
  trace: (category: LogCategory, message: string, data?: Record<string, unknown>, entityId?: string) =>
    log(env, 'trace', category, message, data, entityId),

  debug: (category: LogCategory, message: string, data?: Record<string, unknown>, entityId?: string) =>
    log(env, 'debug', category, message, data, entityId),

  info: (category: LogCategory, message: string, data?: Record<string, unknown>, entityId?: string) =>
    log(env, 'info', category, message, data, entityId),

  warn: (category: LogCategory, message: string, data?: Record<string, unknown>, entityId?: string) =>
    log(env, 'warn', category, message, data, entityId),

  error: (category: LogCategory, message: string, data?: Record<string, unknown>, entityId?: string) =>
    log(env, 'error', category, message, data, entityId),

  // Convenience methods for common patterns
  consensus: (message: string, data?: Record<string, unknown>, entityId?: string) =>
    log(env, 'info', 'consensus', message, data, entityId),

  account: (message: string, data?: Record<string, unknown>, entityId?: string) =>
    log(env, 'info', 'account', message, data, entityId),

  jurisdiction: (message: string, data?: Record<string, unknown>) =>
    log(env, 'info', 'jurisdiction', message, data),

  evm: (message: string, data?: Record<string, unknown>) =>
    log(env, 'info', 'evm', message, data),
});

export const xlog = createLogger;

export default createLogger;

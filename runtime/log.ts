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

// Global log ID counter for deterministic ordering
let globalLogId = 0;

// Current environment reference (set by runtime.ts)
let currentEnv: Env | null = null;

// Mirror to DevTools console (for debugging)
let mirrorToConsole = true;

/**
 * Set the current environment for logging.
 * Called by runtime.ts at the start of each tick.
 */
export const setLogEnv = (env: Env): void => {
  currentEnv = env;
};

/**
 * Enable/disable console mirroring.
 */
export const setMirrorToConsole = (enabled: boolean): void => {
  mirrorToConsole = enabled;
};

/**
 * Flush current frame logs and reset buffer.
 * Called by captureSnapshot before capturing.
 */
export const flushFrameLogs = (): FrameLogEntry[] => {
  if (!currentEnv) return [];
  const logs = [...currentEnv.frameLogs];
  currentEnv.frameLogs = [];
  return logs;
};

/**
 * Core logging function.
 */
const log = (
  level: LogLevel,
  category: LogCategory,
  message: string,
  data?: Record<string, unknown>,
  entityId?: string,
): void => {
  const entry: FrameLogEntry = {
    id: globalLogId++,
    timestamp: Date.now(),
    level,
    category,
    message,
    ...(entityId && { entityId }),
    ...(data && { data }),
  };

  // Add to frame buffer if env is set
  if (currentEnv) {
    currentEnv.frameLogs.push(entry);
  }

  // Mirror to DevTools console
  if (mirrorToConsole) {
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
export const xlog = {
  trace: (category: LogCategory, message: string, data?: Record<string, unknown>, entityId?: string) =>
    log('trace', category, message, data, entityId),

  debug: (category: LogCategory, message: string, data?: Record<string, unknown>, entityId?: string) =>
    log('debug', category, message, data, entityId),

  info: (category: LogCategory, message: string, data?: Record<string, unknown>, entityId?: string) =>
    log('info', category, message, data, entityId),

  warn: (category: LogCategory, message: string, data?: Record<string, unknown>, entityId?: string) =>
    log('warn', category, message, data, entityId),

  error: (category: LogCategory, message: string, data?: Record<string, unknown>, entityId?: string) =>
    log('error', category, message, data, entityId),

  // Convenience methods for common patterns
  consensus: (message: string, data?: Record<string, unknown>, entityId?: string) =>
    log('info', 'consensus', message, data, entityId),

  account: (message: string, data?: Record<string, unknown>, entityId?: string) =>
    log('info', 'account', message, data, entityId),

  jurisdiction: (message: string, data?: Record<string, unknown>) =>
    log('info', 'jurisdiction', message, data),

  evm: (message: string, data?: Record<string, unknown>) =>
    log('info', 'evm', message, data),
};

export default xlog;

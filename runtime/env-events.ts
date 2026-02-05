/**
 * XLN Event Emission System (EVM-style)
 *
 * Attaches event emission methods to Env (like Ethereum blocks have logs).
 * Events are stored in env.frameLogs and travel with snapshots for time-travel debugging.
 *
 * Usage:
 *   env.info('consensus', 'Frame committed', { entityId, height });
 *   env.emit('FrameCommitted', { entityId, height, hash });
 */

import type { Env, LogLevel, LogCategory, FrameLogEntry } from './types';

const getLogState = (env: Env) => {
  if (!env.runtimeState) env.runtimeState = {};
  if (!env.runtimeState.logState) {
    env.runtimeState.logState = { nextId: 0, mirrorToConsole: true };
  }
  return env.runtimeState.logState;
};

const MAX_CLEAN_LOGS = 2000;

const getCleanLogBuffer = (env: Env): string[] => {
  if (!env.runtimeState) env.runtimeState = {};
  if (!env.runtimeState.cleanLogs) env.runtimeState.cleanLogs = [];
  return env.runtimeState.cleanLogs;
};

const addCleanLog = (env: Env, level: string, msg: string): void => {
  const ts = new Date().toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  });
  const buffer = getCleanLogBuffer(env);
  buffer.push(`[${ts}] ${level}: ${msg}`);
  if (buffer.length > MAX_CLEAN_LOGS) buffer.shift();
};

/**
 * Create event emission methods for an environment.
 * Called once during env creation (createEmptyEnv).
 */
export function attachEventEmitters(env: Env): void {
  // Helper: Use env.timestamp for deterministic logs
  const getTimestamp = () => env.timestamp;
  const logState = getLogState(env);

  // Simple log (like console.log but captured)
  env.log = (message: string) => {
    const entry: FrameLogEntry = {
      id: logState.nextId++,
      timestamp: getTimestamp(),
      level: 'info',
      category: 'system',
      message,
    };
    env.frameLogs.push(entry);
    addCleanLog(env, 'LOG', message);
  };

  // Structured info log
  env.info = (category: LogCategory, message: string, data?: Record<string, unknown>, entityId?: string) => {
    const entry: FrameLogEntry = {
      id: logState.nextId++,
      timestamp: getTimestamp(),
      level: 'info',
      category,
      message,
      ...(entityId && { entityId }),
      ...(data && { data }),
    };
    env.frameLogs.push(entry);
    addCleanLog(env, 'INFO', message);
  };

  // Structured warning log
  env.warn = (category: LogCategory, message: string, data?: Record<string, unknown>, entityId?: string) => {
    const entry: FrameLogEntry = {
      id: logState.nextId++,
      timestamp: getTimestamp(),
      level: 'warn',
      category,
      message,
      ...(entityId && { entityId }),
      ...(data && { data }),
    };
    env.frameLogs.push(entry);
    addCleanLog(env, 'WARN', message);
    console.warn(`[${category}]`, message, data || '');
  };

  // Structured error log
  env.error = (category: LogCategory, message: string, data?: Record<string, unknown>, entityId?: string) => {
    const entry: FrameLogEntry = {
      id: logState.nextId++,
      timestamp: getTimestamp(),
      level: 'error',
      category,
      message,
      ...(entityId && { entityId }),
      ...(data && { data }),
    };
    env.frameLogs.push(entry);
    addCleanLog(env, 'ERR', message);
    console.error(`[${category}]`, message, data || '');
  };

  // Generic event emission (EVM-style)
  env.emit = (eventName: string, data: Record<string, unknown>) => {
    const entry: FrameLogEntry = {
      id: logState.nextId++,
      timestamp: getTimestamp(),
      level: 'info',
      category: 'system',
      message: eventName,
      data,
    };
    env.frameLogs.push(entry);
    addCleanLog(env, 'EVENT', eventName);
  };
}

/**
 * Reset global log ID counter (for testing)
 */
export function resetLogCounter(env: Env): void {
  const logState = getLogState(env);
  logState.nextId = 0;
}

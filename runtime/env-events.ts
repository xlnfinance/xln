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

// Global log ID counter for deterministic ordering
let globalLogId = 0;

/**
 * Create event emission methods for an environment.
 * Called once during env creation (createEmptyEnv).
 */
export function attachEventEmitters(env: Env): void {
  // Helper: Get deterministic timestamp (scenario mode uses env.timestamp, live uses Date.now())
  const getTimestamp = () => env.scenarioMode ? env.timestamp : Date.now();

  // Simple log (like console.log but captured)
  env.log = (message: string) => {
    const entry: FrameLogEntry = {
      id: globalLogId++,
      timestamp: getTimestamp(),
      level: 'info',
      category: 'system',
      message,
    };
    env.frameLogs.push(entry);
  };

  // Structured info log
  env.info = (category: LogCategory, message: string, data?: Record<string, unknown>, entityId?: string) => {
    const entry: FrameLogEntry = {
      id: globalLogId++,
      timestamp: getTimestamp(),
      level: 'info',
      category,
      message,
      ...(entityId && { entityId }),
      ...(data && { data }),
    };
    env.frameLogs.push(entry);
  };

  // Structured warning log
  env.warn = (category: LogCategory, message: string, data?: Record<string, unknown>, entityId?: string) => {
    const entry: FrameLogEntry = {
      id: globalLogId++,
      timestamp: getTimestamp(),
      level: 'warn',
      category,
      message,
      ...(entityId && { entityId }),
      ...(data && { data }),
    };
    env.frameLogs.push(entry);
    console.warn(`[${category}]`, message, data || '');
  };

  // Structured error log
  env.error = (category: LogCategory, message: string, data?: Record<string, unknown>, entityId?: string) => {
    const entry: FrameLogEntry = {
      id: globalLogId++,
      timestamp: getTimestamp(),
      level: 'error',
      category,
      message,
      ...(entityId && { entityId }),
      ...(data && { data }),
    };
    env.frameLogs.push(entry);
    console.error(`[${category}]`, message, data || '');
  };

  // Generic event emission (EVM-style)
  env.emit = (eventName: string, data: Record<string, unknown>) => {
    const entry: FrameLogEntry = {
      id: globalLogId++,
      timestamp: getTimestamp(),
      level: 'info',
      category: 'system',
      message: eventName,
      data,
    };
    env.frameLogs.push(entry);
  };
}

/**
 * Reset global log ID counter (for testing)
 */
export function resetLogCounter(): void {
  globalLogId = 0;
}

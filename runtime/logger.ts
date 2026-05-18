/**
 * XLN Logging System
 *
 * Feature-flagged logging controlled by runtime/constants.ts PERFORMANCE flags.
 * In production, set all DEBUG_* flags to false for 10x faster performance.
 *
 * @license AGPL-3.0
 * Copyright (C) 2025 XLN Finance
 */

import { PERFORMANCE } from './constants';
import { safeStringify } from './serialization-utils';

// Log filtering system for debugging
export interface LogConfig {
  ENTITY_TX: boolean;
  ACCOUNT_OPEN: boolean;
  SIGNER_LOOKUP: boolean;
  PROCESS_TICK: boolean;
  FRAME_CONSENSUS: boolean;
  ENTITY_OUTPUT: boolean;
  ENTITY_INPUT: boolean;
  RUNTIME_TICK: boolean;
  SERVER_TICK: boolean;
  J_WATCHER: boolean;
  BLOCKCHAIN: boolean;
  GOSSIP: boolean;
  R2R_FLOW: boolean;
  ACCOUNT_STATE: boolean;
}

// Default log config - derived from constants.ts PERFORMANCE flags
// Individual categories can be toggled at runtime via window.logConfig.set()
export const LOG_CONFIG: LogConfig = {
  ENTITY_TX: PERFORMANCE.DEBUG_CONSENSUS,        // Entity-level consensus
  ACCOUNT_OPEN: PERFORMANCE.DEBUG_ACCOUNTS,      // Account creation
  SIGNER_LOOKUP: PERFORMANCE.DEBUG_CONSENSUS,    // Validator management
  PROCESS_TICK: PERFORMANCE.DEBUG_LOGGING,       // Tick processing
  FRAME_CONSENSUS: PERFORMANCE.DEBUG_CONSENSUS,  // BFT consensus
  ENTITY_OUTPUT: PERFORMANCE.DEBUG_LOGGING,      // Entity outputs
  ENTITY_INPUT: PERFORMANCE.DEBUG_LOGGING,       // Entity inputs
  RUNTIME_TICK: PERFORMANCE.DEBUG_LOGGING,       // Runtime input processing
  SERVER_TICK: PERFORMANCE.DEBUG_LOGGING,        // Runtime tick processing
  J_WATCHER: PERFORMANCE.LOG_BLOCKCHAIN_ERRORS,  // Blockchain watcher
  BLOCKCHAIN: PERFORMANCE.LOG_BLOCKCHAIN_ERRORS, // Blockchain interactions
  GOSSIP: PERFORMANCE.DEBUG_LOGGING,             // Network gossip
  R2R_FLOW: PERFORMANCE.DEBUG_ACCOUNTS,          // Reserve-to-reserve transfers
  ACCOUNT_STATE: PERFORMANCE.DEBUG_ACCOUNTS,     // Account state changes
};

let FAIL_FAST_ERRORS = false;

export function setFailFastErrors(enabled: boolean): void {
  FAIL_FAST_ERRORS = enabled;
}

function formatLogArgs(args: unknown[]): string {
  return args.map(arg => {
    if (typeof arg === 'string') return arg;
    if (typeof arg === 'bigint') return `${arg.toString()}n`;
    try {
      return safeStringify(arg);
    } catch {
      return String(arg);
    }
  }).join(' ');
}

// Helper to check if logging is enabled for a category
export function shouldLog(category: keyof LogConfig): boolean {
  return LOG_CONFIG[category] ?? false;
}

// Log levels for structured logging
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

export type StructuredLogFields = Record<string, unknown>;

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 0,
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const configuredLevel = (): LogLevel => {
  const raw = String(process.env['XLN_LOG_LEVEL'] || 'info').trim().toLowerCase();
  if (raw === 'trace' || raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
  return 'info';
};

const shouldEmitLevel = (level: LogLevel): boolean =>
  LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[configuredLevel()];

const configuredScopes = (): Set<string> | null => {
  const raw = String(process.env['XLN_LOG_SCOPES'] || '').trim().toLowerCase();
  if (!raw) return null;
  const scopes = raw.split(',').map(scope => scope.trim()).filter(Boolean);
  return scopes.length > 0 ? new Set(scopes) : null;
};

const shouldEmitScope = (scope: string): boolean => {
  const scopes = configuredScopes();
  if (!scopes) return true;
  const normalized = String(scope || '').trim().toLowerCase();
  if (scopes.has(normalized)) return true;
  const [root] = normalized.split(/[.:]/);
  return Boolean(root && scopes.has(root));
};

export const shouldLogFullPayloads = (): boolean =>
  configuredLevel() === 'trace' || String(process.env['XLN_LOG_FULL_PAYLOADS'] || '').trim() === '1';

export const shortId = (value: unknown, chars = 4): string => {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.startsWith('0x') && text.length > 2 + chars) return text.slice(-chars);
  return text.length > chars ? text.slice(-chars) : text;
};

export const shortHash = (value: unknown, head = 10): string => {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length <= head + 2) return text;
  return `${text.slice(0, head)}..`;
};

export const shortOrder = (value: unknown, chars = 10): string => {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.length > chars ? text.slice(-chars) : text;
};

export const formatAmount = (value: unknown): string => {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NaN';
  return String(value ?? '');
};

export const emitStructuredLog = (
  level: LogLevel,
  scope: string,
  message: string,
  fields: StructuredLogFields = {},
): void => {
  if (!shouldEmitLevel(level)) return;
  if (!shouldEmitScope(scope)) return;
  const payload = {
    ts: new Date().toISOString(),
    level,
    scope,
    message,
    ...fields,
  };
  const line = process.env['XLN_LOG_FORMAT'] === 'json'
    ? safeStringify(payload)
    : `[${level.toUpperCase()}][${scope}] ${message}${Object.keys(fields).length ? ` ${safeStringify(fields)}` : ''}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};

export const createStructuredLogger = (scope: string, baseFields: StructuredLogFields = {}) => ({
  trace: (message: string, fields: StructuredLogFields = {}) =>
    emitStructuredLog('trace', scope, message, { ...baseFields, ...fields }),
  debug: (message: string, fields: StructuredLogFields = {}) =>
    emitStructuredLog('debug', scope, message, { ...baseFields, ...fields }),
  info: (message: string, fields: StructuredLogFields = {}) =>
    emitStructuredLog('info', scope, message, { ...baseFields, ...fields }),
  warn: (message: string, fields: StructuredLogFields = {}) =>
    emitStructuredLog('warn', scope, message, { ...baseFields, ...fields }),
  error: (message: string, fields: StructuredLogFields = {}) =>
    emitStructuredLog('error', scope, message, { ...baseFields, ...fields }),
});

// Conditional logger with levels
export function log(category: keyof LogConfig, level: LogLevel, ...args: unknown[]): void {
  if (shouldLog(category)) {
    const prefix = `[${category}]`;
    switch (level) {
      case 'error':
        console.error(prefix, ...args);
        break;
      case 'warn':
        console.warn(prefix, ...args);
        break;
      case 'info':
        console.info(prefix, ...args);
        break;
      case 'debug':
      default:
        console.log(prefix, ...args);
        break;
    }
  }
}

// Convenience methods for common patterns
export function logDebug(category: keyof LogConfig, ...args: unknown[]): void {
  log(category, 'debug', ...args);
}

export function logInfo(category: keyof LogConfig, ...args: unknown[]): void {
  log(category, 'info', ...args);
}

export function logWarn(category: keyof LogConfig, ...args: unknown[]): void {
  log(category, 'warn', ...args);
}

export function logError(category: keyof LogConfig, ...args: unknown[]): void {
  log(category, 'error', ...args);
  if (FAIL_FAST_ERRORS) {
    throw new Error(`[FAIL_FAST] ${String(category)}: ${formatLogArgs(args)}`);
  }
}

// Debug helper to show current config
export function showLogConfig(): void {
  console.log('📊 Current Log Configuration:');
  Object.entries(LOG_CONFIG).forEach(([key, enabled]) => {
    console.log(`  ${enabled ? '✅' : '❌'} ${key}`);
  });
}

// Runtime config setter (for debugging from console)
export function setLogConfig(category: keyof LogConfig, enabled: boolean): void {
  LOG_CONFIG[category] = enabled;
  console.log(`🔧 Log category "${category}" set to ${enabled ? 'ON' : 'OFF'}`);
}

// Enable all logs
export function enableAllLogs(): void {
  Object.keys(LOG_CONFIG).forEach(key => {
    LOG_CONFIG[key as keyof LogConfig] = true;
  });
  console.log('✅ All logs enabled');
}

// Disable all logs
export function disableAllLogs(): void {
  Object.keys(LOG_CONFIG).forEach(key => {
    LOG_CONFIG[key as keyof LogConfig] = false;
  });
  console.log('❌ All logs disabled');
}

// Extend Window interface for debugging

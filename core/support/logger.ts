/**
 * XLN Logging System
 *
 * Feature-flagged logging controlled by config/constants.ts PERFORMANCE flags.
 * In production, set all DEBUG_* flags to false for 10x faster performance.
 *
 * @license AGPL-3.0
 * Copyright (C) 2025 XLN Finance
 */

import { PERFORMANCE } from '../config/constants';
import { safeStringify } from '../protocol/serialization';
import { redactTelemetryValue } from './telemetry-redaction';

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

// Default log config - derived from config/constants.ts PERFORMANCE flags
// Individual categories can be toggled at runtime via window.logConfig.set()
const LOG_CONFIG: LogConfig = {
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
  return args.map(rawArg => {
    const arg = redactTelemetryValue(rawArg);
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
function shouldLog(category: keyof LogConfig): boolean {
  return LOG_CONFIG[category] ?? false;
}

// Log levels for structured logging
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

export type StructuredLogFields = Record<string, unknown>;

export type StructuredLogEvent = StructuredLogFields & {
  ts: string;
  level: LogLevel;
  scope: string;
  message: string;
};

type StructuredLogSink = (event: StructuredLogEvent) => void;
const structuredLogSinks = new Set<StructuredLogSink>();

export const registerStructuredLogSink = (sink: StructuredLogSink): (() => void) => {
  structuredLogSinks.add(sink);
  return () => structuredLogSinks.delete(sink);
};

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 0,
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

type StructuredLogRuntime = {
  level: LogLevel;
  scopes: ReadonlySet<string> | null;
  json: boolean;
  warnStdout: boolean;
};

let structuredLogRuntimeKey = '';
let structuredLogRuntime: StructuredLogRuntime | null = null;

const parseLogLevel = (raw: string): LogLevel => {
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'trace' || normalized === 'debug' || normalized === 'info' || normalized === 'warn' || normalized === 'error') {
    return normalized;
  }
  return 'info';
};

const parseLogScopes = (raw: string): ReadonlySet<string> | null => {
  const scopes = raw.trim().toLowerCase().split(',').map(scope => scope.trim()).filter(Boolean);
  return scopes.length > 0 ? new Set(scopes) : null;
};

const readStructuredLogRuntime = (): StructuredLogRuntime => {
  const key = `${process.env['XLN_LOG_LEVEL'] ?? ''}\n${process.env['XLN_LOG_SCOPES'] ?? ''}\n${process.env['XLN_LOG_FORMAT'] ?? ''}\n${process.env['XLN_LOG_WARN_STDOUT'] ?? ''}`;
  if (structuredLogRuntime && structuredLogRuntimeKey === key) return structuredLogRuntime;
  structuredLogRuntime = {
    level: parseLogLevel(process.env['XLN_LOG_LEVEL'] || 'info'),
    scopes: parseLogScopes(process.env['XLN_LOG_SCOPES'] || ''),
    json: process.env['XLN_LOG_FORMAT'] === 'json',
    warnStdout: process.env['XLN_LOG_WARN_STDOUT'] === '1',
  };
  structuredLogRuntimeKey = key;
  return structuredLogRuntime;
};

const scopeAllowed = (scope: string, scopes: ReadonlySet<string> | null): boolean => {
  if (!scopes) return true;
  const normalized = String(scope || '').trim().toLowerCase();
  if (scopes.has(normalized)) return true;
  const [root] = normalized.split(/[.:]/);
  return Boolean(root && scopes.has(root));
};

const canEmitStructuredLog = (level: LogLevel, scope: string): boolean => {
  const runtime = readStructuredLogRuntime();
  return LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[runtime.level] && scopeAllowed(scope, runtime.scopes);
};

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

const emitStructuredLog = (
  level: LogLevel,
  scope: string,
  message: string,
  fields: StructuredLogFields = {},
): void => {
  if (!canEmitStructuredLog(level, scope)) return;
  const runtime = readStructuredLogRuntime();
  const redactedFields = redactTelemetryValue(fields) as StructuredLogFields;
  const redactedMessage = redactTelemetryValue(message) as string;
  const payload: StructuredLogEvent = {
    ...redactedFields,
    ts: new Date().toISOString(),
    level,
    scope,
    message: redactedMessage,
  };
  for (const sink of structuredLogSinks) sink(payload);
  const line = runtime.json
    ? safeStringify(payload)
    : `[${level.toUpperCase()}][${scope}] ${redactedMessage}${Object.keys(redactedFields).length ? ` ${safeStringify(redactedFields)}` : ''}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') {
    const warnSink = runtime.warnStdout ? console.log : console.warn;
    warnSink(line);
  }
  else console.log(line);
};

export const createStructuredLogger = (scope: string, baseFields: StructuredLogFields = {}) => ({
  trace: (message: string, fields: StructuredLogFields = {}) => {
    if (!canEmitStructuredLog('trace', scope)) return;
    emitStructuredLog('trace', scope, message, { ...baseFields, ...fields });
  },
  debug: (message: string, fields: StructuredLogFields = {}) => {
    if (!canEmitStructuredLog('debug', scope)) return;
    emitStructuredLog('debug', scope, message, { ...baseFields, ...fields });
  },
  info: (message: string, fields: StructuredLogFields = {}) => {
    if (!canEmitStructuredLog('info', scope)) return;
    emitStructuredLog('info', scope, message, { ...baseFields, ...fields });
  },
  warn: (message: string, fields: StructuredLogFields = {}) => {
    if (!canEmitStructuredLog('warn', scope)) return;
    emitStructuredLog('warn', scope, message, { ...baseFields, ...fields });
  },
  error: (message: string, fields: StructuredLogFields = {}) => {
    if (!canEmitStructuredLog('error', scope)) return;
    emitStructuredLog('error', scope, message, { ...baseFields, ...fields });
  },
});

// Conditional logger with levels
function log(category: keyof LogConfig, level: LogLevel, ...args: unknown[]): void {
  if (shouldLog(category)) {
    const prefix = `[${category}]`;
    const redactedArgs = args.map(arg => redactTelemetryValue(arg));
    switch (level) {
      case 'error':
        console.error(prefix, ...redactedArgs);
        break;
      case 'warn':
        console.warn(prefix, ...redactedArgs);
        break;
      case 'info':
        console.info(prefix, ...redactedArgs);
        break;
      case 'debug':
      default:
        console.log(prefix, ...redactedArgs);
        break;
    }
  }
}

// Convenience methods for common patterns
export function logDebug(category: keyof LogConfig, ...args: unknown[]): void {
  log(category, 'debug', ...args);
}

export function logError(category: keyof LogConfig, ...args: unknown[]): void {
  log(category, 'error', ...args);
  if (FAIL_FAST_ERRORS) {
    throw new Error(`[FAIL_FAST] ${String(category)}: ${formatLogArgs(args)}`);
  }
}

// Extend Window interface for debugging

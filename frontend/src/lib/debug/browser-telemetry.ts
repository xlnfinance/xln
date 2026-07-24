type BrowserErrorKind =
  | 'console_error'
  | 'window_error'
  | 'unhandled_rejection'
  | 'svelte_error';

type BrowserErrorEvent = {
  kind: BrowserErrorKind;
  message: string;
  stack?: string;
  code?: string;
  route: string;
  sessionId: string;
  runtimeId?: string;
  entityId?: string;
  build?: string;
  at: number;
};

type TelemetryState = {
  queued: number;
  sent: number;
  failed: number;
  lastFailure: string;
};

type DebugWindow = Window & {
  isolatedEnv?: {
    runtimeId?: unknown;
    activeEntityId?: unknown;
  };
  __xlnBrowserTelemetry?: TelemetryState;
};

const MAX_QUEUE = 100;
const BATCH_SIZE = 20;
const FLUSH_DELAY_MS = 100;
const REDACTED_KEY = /auth|capability|ciphertext|mnemonic|password|private|seed|secret|signature|token/i;
const queue: BrowserErrorEvent[] = [];
const sessionId = globalThis.crypto?.randomUUID?.() ?? `page-${Date.now().toString(36)}`;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let installed = false;

const telemetryState = (): TelemetryState => {
  const target = window as DebugWindow;
  target.__xlnBrowserTelemetry ??= { queued: 0, sent: 0, failed: 0, lastFailure: '' };
  return target.__xlnBrowserTelemetry;
};

const redactText = (value: string): string => value
  .replace(/xlnra1\.[A-Za-z0-9._~-]+/g, '[REDACTED_CAPABILITY]')
  .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [REDACTED]');

const serializeValue = (value: unknown, depth = 0): string => {
  if (value instanceof Error) return redactText(value.stack || value.message || value.name);
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'bigint') return value.toString();
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (depth >= 2) return `[${Array.isArray(value) ? 'Array' : typeof value}]`;
  if (Array.isArray(value)) return `[${value.slice(0, 20).map(item => serializeValue(item, depth + 1)).join(', ')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .slice(0, 30)
      .map(([key, item]) => `${key}:${REDACTED_KEY.test(key) ? '[REDACTED]' : serializeValue(item, depth + 1)}`);
    return `{${entries.join(', ')}}`;
  }
  return String(value);
};

const currentIdentity = (): Pick<BrowserErrorEvent, 'runtimeId' | 'entityId'> => {
  const env = (window as DebugWindow).isolatedEnv;
  const runtimeId = typeof env?.runtimeId === 'string' ? env.runtimeId.slice(0, 200) : undefined;
  const entityId = typeof env?.activeEntityId === 'string' ? env.activeEntityId.slice(0, 200) : undefined;
  return {
    ...(runtimeId ? { runtimeId } : {}),
    ...(entityId ? { entityId } : {}),
  };
};

const flush = async (): Promise<void> => {
  flushTimer = null;
  if (queue.length === 0) return;
  const events = queue.splice(0, BATCH_SIZE);
  const state = telemetryState();
  state.queued = queue.length;
  try {
    const response = await fetch('/api/debug/events/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events }),
      keepalive: true,
    });
    if (!response.ok) throw new Error(`DEBUG_INGEST_HTTP_${response.status}`);
    state.sent += events.length;
    state.lastFailure = '';
  } catch (error) {
    state.failed += events.length;
    state.lastFailure = error instanceof Error ? error.message : String(error);
  } finally {
    if (queue.length > 0) scheduleFlush();
  }
};

const scheduleFlush = (): void => {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => void flush(), FLUSH_DELAY_MS);
};

export const captureBrowserError = (
  kind: BrowserErrorKind,
  error: unknown,
  context: unknown[] = [],
): void => {
  if (typeof window === 'undefined') return;
  const serialized = [error, ...context].map(value => serializeValue(value)).filter(Boolean);
  const message = redactText(serialized.join(' ')).slice(0, 4000) || 'UNKNOWN_BROWSER_ERROR';
  const stack = error instanceof Error ? redactText(error.stack || '').slice(0, 8000) : undefined;
  const code = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? String((error as { code: string }).code).slice(0, 200)
    : undefined;
  const build = String(import.meta.env['VITE_COMMIT_SHA'] || '').slice(0, 200) || undefined;
  if (queue.length >= MAX_QUEUE) queue.shift();
  queue.push({
    kind,
    message,
    ...(stack ? { stack } : {}),
    ...(code ? { code } : {}),
    route: window.location.pathname.slice(0, 500),
    sessionId,
    ...currentIdentity(),
    ...(build ? { build } : {}),
    at: Date.now(),
  });
  telemetryState().queued = queue.length;
  scheduleFlush();
};

export const installBrowserErrorTelemetry = (): void => {
  if (typeof window === 'undefined' || installed) return;
  installed = true;
  const originalError = console.error.bind(console);
  console.error = (...args: unknown[]): void => {
    originalError(...args);
    captureBrowserError('console_error', args[0], args.slice(1));
  };
  window.addEventListener('error', (event) => {
    captureBrowserError('window_error', event.error ?? event.message);
  });
  window.addEventListener('unhandledrejection', (event) => {
    captureBrowserError('unhandled_rejection', event.reason);
  });
};

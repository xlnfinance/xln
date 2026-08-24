/**
 * Idle self-termination for non-production stands.
 *
 * An HLT lane host, an E2E node or a local smoke server whose driver dies (or
 * simply forgets it) keeps its port, its LevelDB handles and its child engine
 * processes forever: a machine collects hundreds of them over a day, and the
 * next benchmark measures a polluted stand. Parent-liveness covers a parent
 * that dies; this covers the other half — a parent that lives but stopped
 * asking for anything.
 *
 * Never arms in production: only an explicit timeout or a stand marker in the
 * environment turns it on.
 */
import { createStructuredLogger } from '../logger';
import { readPositiveIntegerEnv } from '../../config/environment';

const idleLog = createStructuredLogger('process.idle_shutdown');

const DEFAULT_IDLE_TIMEOUT_S = 300;
/** Environment variables that mark a stand as a test/benchmark stand. */
const STAND_MARKERS = ['XLN_HLT_USERS', 'E2E_BASE_URL', 'XLN_LOCAL_PROD_SMOKE_DIR', 'XLN_TESTNET'] as const;

export type IdleShutdownWatch = {
  /** Called on every unit of real work; resets the idle clock. */
  noteActivity: () => void;
  stop: () => void;
};

const NO_WATCH: IdleShutdownWatch = { noteActivity: () => {}, stop: () => {} };

/**
 * Idle timeout in milliseconds, or null when this process must never
 * self-terminate. `XLN_NODE_IDLE_TIMEOUT_S` is the operator's explicit
 * decision and wins everywhere, including production; without it the watch
 * arms only on a stand marker.
 */
export const idleShutdownTimeoutMs = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): number | null => {
  if (environment['XLN_NODE_IDLE_TIMEOUT_S'] !== undefined) {
    return readPositiveIntegerEnv('XLN_NODE_IDLE_TIMEOUT_S', DEFAULT_IDLE_TIMEOUT_S, environment) * 1_000;
  }
  const marked = STAND_MARKERS.some(marker => (environment[marker] ?? '') !== '');
  return marked ? DEFAULT_IDLE_TIMEOUT_S * 1_000 : null;
};

/**
 * Terminate this process after `timeoutMs` without a single `noteActivity()`.
 *
 * The timer is deliberately NOT unref'd: a node whose only remaining work is
 * its own idle timer is exactly the node that has to notice it is idle.
 */
export const startIdleShutdownWatch = (
  label: string,
  onIdle: (idleMs: number) => void,
  options: { timeoutMs?: number | null; checkEveryMs?: number } = {},
): IdleShutdownWatch => {
  const timeoutMs = options.timeoutMs === undefined ? idleShutdownTimeoutMs() : options.timeoutMs;
  if (timeoutMs === null) return NO_WATCH;
  const checkEveryMs = options.checkEveryMs ?? Math.max(1_000, Math.floor(timeoutMs / 10));
  let lastActivity = Date.now();
  let fired = false;
  const timer = setInterval(() => {
    if (fired) return;
    const idleMs = Date.now() - lastActivity;
    if (idleMs < timeoutMs) return;
    fired = true;
    clearInterval(timer);
    idleLog.error('idle_timeout', { label, idleMs, timeoutMs });
    onIdle(idleMs);
  }, checkEveryMs);
  return {
    noteActivity: () => {
      lastActivity = Date.now();
    },
    stop: () => {
      fired = true;
      clearInterval(timer);
    },
  };
};

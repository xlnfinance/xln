import { writable } from 'svelte/store';

interface ErrorLogEntry {
  timestamp: number;
  message: string;
  source: string;
  details?: unknown;
}

function createErrorLogStore() {
  const { subscribe, update } = writable<ErrorLogEntry[]>([]);

  return {
    subscribe,
    log(message: string, source: string, details?: unknown) {
      update(logs => {
        const entry: ErrorLogEntry = {
          timestamp: Date.now(),
          message,
          source,
          details
        };
        // Keep last 100 errors
        const newLogs = [...logs, entry];
        return newLogs.slice(-100);
      });
    },
    clear() {
      update(() => []);
    }
  };
}

export const errorLog = createErrorLogStore();

function formatDetails(details: unknown): string {
  if (details === undefined) return '';
  try {
    return `\n  ${JSON.stringify(serializeDetails(details))}`;
  } catch {
    return '\n  [unserializable details]';
  }
}

function serializeDetails(value: unknown, seen = new Set<object>(), depth = 0): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      cause: value.cause === undefined ? undefined : serializeDetails(value.cause, seen, depth + 1),
    };
  }
  if (typeof value === 'bigint') return `BigInt(${value.toString()})`;
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'undefined') return undefined;
  if (typeof value === 'symbol' || typeof value === 'function') return String(value);
  if (typeof value !== 'object') return String(value);
  if (depth >= 8) return '[MaxDepth]';
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    const output = value.map((item) => serializeDetails(item, seen, depth + 1));
    seen.delete(value);
    return output;
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = serializeDetails(item, seen, depth + 1);
  }
  seen.delete(value);
  return output;
}

// Format error log as text
export function formatErrorLog(logs: ErrorLogEntry[]): string {
  return logs.map(entry => {
    const time = new Date(entry.timestamp).toISOString().slice(11, 23);
    const details = formatDetails(entry.details);
    return `[${time}] ${entry.source}: ${entry.message}${details}`;
  }).join('\n\n');
}

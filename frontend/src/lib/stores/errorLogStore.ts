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
    return `\n  ${JSON.stringify(details)}`;
  } catch {
    return '\n  [unserializable details]';
  }
}

// Format error log as text
export function formatErrorLog(logs: ErrorLogEntry[]): string {
  return logs.map(entry => {
    const time = new Date(entry.timestamp).toISOString().slice(11, 23);
    const details = formatDetails(entry.details);
    return `[${time}] ${entry.source}: ${entry.message}${details}`;
  }).join('\n\n');
}

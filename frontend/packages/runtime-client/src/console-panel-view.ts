// Framework-neutral view model for the workspace console panel. Owns the
// frame-log projection, filtering, copy/download text, level colors, and the
// whitelist command REPL. The canonical Svelte panel and the future React
// workspace panel both consume this; no store or DOM access lives here.

import type { EnvSnapshot, RuntimeReplica } from '@xln/core/api/public/runtime-module';

import { isUnknownRecord } from './boundary';

export type ConsoleLogLevel = 'debug' | 'log' | 'info' | 'warn' | 'error';
export type ConsoleFilterLevel = 'all' | ConsoleLogLevel;

export type ConsoleEntry = Readonly<{
  id: number;
  timestamp: string;
  level: ConsoleLogLevel;
  message: string;
  stack?: string;
}>;

export const CONSOLE_MAX_LOGS = 500;

export const formatConsoleTimestamp = (timestamp: number): string =>
  new Date(timestamp).toLocaleTimeString('en-US', {
    hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  });

const normalizeConsoleLevel = (level: string): ConsoleLogLevel =>
  level === 'debug' || level === 'warn' || level === 'error' ? level : 'log';

/** Tolerant frame-log decode: frames may carry `logs` or `frameLogs`, and a
 *  malformed entry contributes nothing rather than breaking the console. */
export const consoleFrameLogsOf = (
  frame: EnvSnapshot,
): ReadonlyArray<{ timestamp: number; level: string; message: string }> => {
  const frameRecord = isUnknownRecord(frame) ? frame : null;
  const candidate = frameRecord === null
    ? null
    : 'logs' in frameRecord ? frameRecord['logs']
    : 'frameLogs' in frameRecord ? frameRecord['frameLogs']
    : null;
  if (!Array.isArray(candidate)) return [];
  return candidate.flatMap(entry => {
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    return typeof record['timestamp'] === 'number' && typeof record['level'] === 'string' && typeof record['message'] === 'string'
      ? [{ timestamp: record['timestamp'], level: record['level'], message: record['message'] }]
      : [];
  });
};

export type ConsoleProjectionOptions = Readonly<{
  maxLogs?: number;
  formatTimestamp?: (timestamp: number) => string;
}>;

/** All frame logs up to the selected history index, newest last, bounded. */
export const projectConsoleFrameLogs = (
  history: readonly EnvSnapshot[],
  timeIndex: number | undefined,
  options: ConsoleProjectionOptions = {},
): ConsoleEntry[] => {
  if (history.length === 0 || timeIndex === undefined) return [];
  const maxLogs = options.maxLogs ?? CONSOLE_MAX_LOGS;
  const formatTimestamp = options.formatTimestamp ?? formatConsoleTimestamp;
  const endIndex = timeIndex >= 0 ? timeIndex : history.length - 1;
  const allLogs: ConsoleEntry[] = [];
  let id = 0;
  for (let frameIndex = 0; frameIndex <= endIndex && frameIndex < history.length; frameIndex++) {
    const frame = history[frameIndex];
    if (!frame) continue;
    for (const frameLog of consoleFrameLogsOf(frame)) {
      allLogs.push({
        id: id++,
        timestamp: formatTimestamp(frameLog.timestamp),
        level: normalizeConsoleLevel(frameLog.level),
        message: `[F${frameIndex}] ${frameLog.message}`,
      });
    }
  }
  return allLogs.slice(-maxLogs);
};

export const filterConsoleLogs = (
  logs: readonly ConsoleEntry[],
  filterLevel: ConsoleFilterLevel,
  search: string,
): ConsoleEntry[] => {
  const needle = search.trim().toLowerCase();
  return logs
    .filter(log => filterLevel === 'all' || log.level === filterLevel)
    .filter(log => !needle || log.message.toLowerCase().includes(needle));
};

export const formatConsoleLogText = (logs: readonly ConsoleEntry[]): string =>
  logs.map(log => `[${log.timestamp}] [${log.level.toUpperCase()}] ${log.message}`).join('\n');

export const consoleLevelColor = (level: ConsoleLogLevel): string => {
  switch (level) {
    case 'debug': return '#888';
    case 'log': return '#ccc';
    case 'info': return '#4a9eff';
    case 'warn': return '#ff9800';
    case 'error': return '#f44336';
  }
};

export const CONSOLE_SCENARIO_NAMES = ['simnet-grid', 'diamond-dybvig', 'phantom-grid', 'corporate-treasury'] as const;

export type ConsoleCommandsDeps = Readonly<{
  readEnv: () => RuntimeReplica | null;
  clear: () => void;
}>;

export type ConsoleCommands = {
  help: (cmd?: string) => string;
  clear: () => string;
  state: () => { entities: number; height: number; timestamp: number };
  entities: () => string[];
  inspect: (entityId: string) => string | unknown;
  scenario: { load: (name: string) => string; list: () => readonly string[] };
};

export const createConsoleCommands = (deps: ConsoleCommandsDeps): ConsoleCommands => ({
  help: cmd => {
    if (cmd && cmd in CONSOLE_COMMAND_HELP) return CONSOLE_COMMAND_HELP[cmd] || 'No help available';
    return `Available commands:\n${Object.keys(CONSOLE_COMMAND_HELP).map(name => `  ${name}`).join('\n')}\nType help(commandName) for details`;
  },
  clear: () => {
    deps.clear();
    return 'Console cleared';
  },
  state: () => {
    const env = deps.readEnv();
    if (!env) return { entities: 0, height: 0, timestamp: 0 };
    return { entities: env.state.eReplicas.size, height: env.state.height, timestamp: env.state.timestamp };
  },
  entities: () => {
    const env = deps.readEnv();
    return env ? Array.from(env.state.eReplicas.keys()) : [];
  },
  inspect: entityId => {
    const env = deps.readEnv();
    const replica = env?.state.eReplicas.get(entityId);
    if (!replica) return `Entity ${entityId} not found`;
    return replica;
  },
  scenario: {
    load: name => `Loading scenario: ${name} (not yet implemented)`,
    list: () => CONSOLE_SCENARIO_NAMES,
  },
});

export const CONSOLE_COMMAND_HELP: Record<string, string> = {
  help: 'help(command?) - Show available commands or help for specific command',
  clear: 'clear() - Clear console output',
  state: 'state() - Show current runtime state (entities count, height, timestamp)',
  entities: 'entities() - List all entity IDs',
  inspect: 'inspect(entityId) - Show detailed entity state',
  scenario: 'scenario.load(name) | scenario.list() - Load or list scenarios',
};

/** Whitelist REPL: exact regex dispatch, never eval. Unknown input throws. */
export const evalConsoleCommand = (commands: ConsoleCommands, cmd: string): unknown => {
  const trimmed = cmd.trim();
  const helpMatch = trimmed.match(/^help\(\s*['"]?(\w+)?['"]?\s*\)$/);
  if (helpMatch) return commands.help(helpMatch[1]);
  if (trimmed === 'clear()') return commands.clear();
  if (trimmed === 'state()') return commands.state();
  if (trimmed === 'entities()') return commands.entities();
  const inspectMatch = trimmed.match(/^inspect\(['"](.+)['"]\)$/);
  if (inspectMatch?.[1]) return commands.inspect(inspectMatch[1]);
  const scenarioLoadMatch = trimmed.match(/^scenario\.load\(['"](.+)['"]\)$/);
  if (scenarioLoadMatch?.[1]) return commands.scenario.load(scenarioLoadMatch[1]);
  if (trimmed === 'scenario.list()') return commands.scenario.list();
  throw new Error(`Unknown command: ${trimmed}. Type help() for available commands.`);
};

/** Tab-completion candidates for the current partial input. */
export const consoleCommandCompletions = (input: string): string[] => {
  const partial = input.trim();
  return Object.keys(CONSOLE_COMMAND_HELP).filter(name => name.startsWith(partial));
};

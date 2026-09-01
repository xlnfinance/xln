import { describe, expect, test } from 'bun:test';

import type { RuntimeReplica } from '../../../core/api/public/runtime-module';
import {
  CONSOLE_COMMAND_HELP,
  consoleCommandCompletions,
  consoleFrameLogsOf,
  consoleLevelColor,
  createConsoleCommands,
  evalConsoleCommand,
  filterConsoleLogs,
  formatConsoleLogText,
  projectConsoleFrameLogs,
  type ConsoleEntry,
} from '../../../frontend/packages/runtime-client/src/console-panel-view';

const frameWithLogs = (logs: unknown): object => ({ logs });
const entry = (id: number, level: ConsoleEntry['level'], message: string): ConsoleEntry => ({
  id, timestamp: '00:00:00', level, message,
});

describe('console panel view model', () => {
  test('projects frame logs up to the selected index with frame prefixes and level normalization', () => {
    const history = [
      frameWithLogs([{ timestamp: 1_000, level: 'debug', message: 'a' }, { timestamp: 2_000, level: 'silly', message: 'b' }]),
      { frameLogs: [{ timestamp: 3_000, level: 'warn', message: 'c' }] },
      frameWithLogs([{ timestamp: 4_000, level: 'error', message: 'never' }]),
    ] as never;
    const projected = projectConsoleFrameLogs(history, 1, { formatTimestamp: () => '00:00:00' });
    expect(projected.map(log => [log.level, log.message])).toEqual([
      ['debug', '[F0] a'],
      ['log', '[F0] b'],
      ['warn', '[F1] c'],
    ]);
    expect(projected.map(log => log.id)).toEqual([0, 1, 2]);
    // A negative time index means live: the whole history.
    expect(projectConsoleFrameLogs(history, -1, { formatTimestamp: () => '00:00:00' })).toHaveLength(4);
    expect(projectConsoleFrameLogs(history, undefined)).toEqual([]);
    expect(projectConsoleFrameLogs([], 0)).toEqual([]);
    // Malformed frame entries contribute nothing instead of breaking the console.
    expect(consoleFrameLogsOf(frameWithLogs([{ timestamp: 'x' }, null, { timestamp: 5, level: 'info', message: 'ok' }]) as never))
      .toEqual([{ timestamp: 5, level: 'info', message: 'ok' }]);
    expect(consoleFrameLogsOf({} as never)).toEqual([]);
  });

  test('bounds the projection to the newest maxLogs entries', () => {
    const history = Array.from({ length: 30 }, (_, index) =>
      frameWithLogs([{ timestamp: index, level: 'log', message: `m${index}` }])) as never;
    const projected = projectConsoleFrameLogs(history, 29, { maxLogs: 10, formatTimestamp: () => 't' });
    expect(projected).toHaveLength(10);
    expect(projected[0]?.message).toBe('[F20] m20');
    expect(projected[9]?.message).toBe('[F29] m29');
  });

  test('filters by level and case-insensitive search and formats copy/download text', () => {
    const logs = [entry(0, 'log', 'Payment settled'), entry(1, 'error', 'PAYMENT FAILED'), entry(2, 'warn', 'Credit near limit')];
    expect(filterConsoleLogs(logs, 'all', '')).toHaveLength(3);
    expect(filterConsoleLogs(logs, 'error', '')).toEqual([logs[1]]);
    expect(filterConsoleLogs(logs, 'all', 'payment')).toEqual([logs[0], logs[1]]);
    expect(filterConsoleLogs(logs, 'warn', 'credit')).toEqual([logs[2]]);
    expect(filterConsoleLogs(logs, 'warn', 'nomatch')).toEqual([]);
    expect(formatConsoleLogText([logs[1]])).toBe('[00:00:00] [ERROR] PAYMENT FAILED');
    expect(consoleLevelColor('error')).toBe('#f44336');
    expect(consoleLevelColor('debug')).toBe('#888');
  });

  test('runs the whitelist REPL without eval and throws loud on unknown input', () => {
    const env = {
      state: {
        eReplicas: new Map([['entity-1', { entityId: 'entity-1' }]]),
        height: 7,
        timestamp: 42,
      },
    } as unknown as RuntimeReplica;
    let cleared = false;
    const commands = createConsoleCommands({ readEnv: () => env, clear: () => { cleared = true; } });

    expect(evalConsoleCommand(commands, 'state()')).toEqual({ entities: 1, height: 7, timestamp: 42 });
    expect(evalConsoleCommand(commands, 'entities()')).toEqual(['entity-1']);
    expect(evalConsoleCommand(commands, 'inspect("entity-1")')).toEqual({ entityId: 'entity-1' });
    expect(evalConsoleCommand(commands, 'scenario.list()')).toEqual(['simnet-grid', 'diamond-dybvig', 'phantom-grid', 'corporate-treasury']);
    expect(evalConsoleCommand(commands, 'scenario.load("ahb")')).toBe('Loading scenario: ahb (not yet implemented)');
    expect(evalConsoleCommand(commands, 'clear()')).toBe('Console cleared');
    expect(cleared).toBe(true);
    expect(evalConsoleCommand(commands, 'help()')).toContain('Available commands:');
    expect(evalConsoleCommand(commands, "help('clear')")).toBe(CONSOLE_COMMAND_HELP.clear);
    // Canonical behavior: an unknown help topic falls through to the list.
    expect(evalConsoleCommand(commands, "help('bogus')")).toContain('Available commands:');
    expect(() => evalConsoleCommand(commands, 'eval("process.exit")')).toThrow('Unknown command: eval("process.exit")');
    // Canonical behavior: inspecting an unknown entity returns a message, not a throw.
    expect(evalConsoleCommand(commands, 'inspect("missing")')).toBe('Entity missing not found');
    // Null env keeps the REPL alive instead of throwing on inspection.
    const offline = createConsoleCommands({ readEnv: () => null, clear: () => undefined });
    expect(evalConsoleCommand(offline, 'state()')).toEqual({ entities: 0, height: 0, timestamp: 0 });
    expect(evalConsoleCommand(offline, 'entities()')).toEqual([]);
    expect(consoleCommandCompletions('sc')).toEqual(['scenario']);
    expect(consoleCommandCompletions('')).toHaveLength(6);
  });
});

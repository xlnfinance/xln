import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { safeStringify } from '../../../protocol/serialization';

const SCRIPT = resolve(process.cwd(), 'tools/progress-timeline.ts');

const withWorkspace = (run: (directory: string) => void): void => {
  const directory = mkdtempSync(join(tmpdir(), 'xln-progress-timeline-'));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const invoke = (directory: string, blocker?: string) => spawnSync('bun', [
  SCRIPT,
  '--percent=42',
  '--focus=exact test',
  '--next=targeted flow',
  ...(blocker ? [`--blocker=${blocker}`] : []),
], { cwd: directory, encoding: 'utf8', timeout: 10_000 });

describe('progress timeline', () => {
  test('appends one exact bounded heartbeat', () => withWorkspace(directory => {
    const result = invoke(directory);
    expect(result.status).toBe(0);
    const output = join(directory, '.logs', 'qa', 'agent-progress.jsonl');
    const rows = readFileSync(output, 'utf8').trim().split('\n');
    expect(rows).toHaveLength(1);
    const value: unknown = JSON.parse(rows[0] ?? 'null');
    expect(value).toMatchObject({ percent: 42, focus: 'exact test', blocker: null });
  }));

  test('rejects malformed prior evidence instead of silently dropping it', () => withWorkspace(directory => {
    const output = join(directory, '.logs', 'qa', 'agent-progress.jsonl');
    mkdirSync(join(directory, '.logs', 'qa'), { recursive: true });
    writeFileSync(output, '{"at":"invalid"}\n');
    const result = invoke(directory);
    expect(result.status).not.toBe(0);
    expect(String(result.stderr)).toContain('PROGRESS_ENTRY_0_FIELDS_INVALID');
  }));

  test('preserves known legacy heartbeats while appending the strict schema', () => withWorkspace(directory => {
    const output = join(directory, '.logs', 'qa', 'agent-progress.jsonl');
    mkdirSync(join(directory, '.logs', 'qa'), { recursive: true });
    writeFileSync(output, [
      '2026-08-15T15:45:02+03:00 | 97% | legacy heartbeat',
      safeStringify({ at: '2026-08-15T16:19:00+03:00', progress: 'legacy', status: 'kept on disk' }),
      safeStringify({
        time: '2026-08-15T16:20:00+03:00',
        progress: 40,
        focus: 'legacy exact heartbeat',
        blocker: null,
        next: 'strict heartbeat',
      }),
      '',
    ].join('\n'));

    const result = invoke(directory);
    expect(result.status).toBe(0);
    const rows = readFileSync(output, 'utf8').trim().split('\n');
    expect(rows).toHaveLength(4);
    expect(JSON.parse(rows[3] ?? 'null')).toMatchObject({ percent: 42, focus: 'exact test' });
  }));

  test('forces escalation after thirty minutes on one stable blocker', () => withWorkspace(directory => {
    const output = join(directory, '.logs', 'qa', 'agent-progress.jsonl');
    mkdirSync(join(directory, '.logs', 'qa'), { recursive: true });
    writeFileSync(output, safeStringify({
      at: '2020-01-01T00:00:00.000Z',
      percent: 40,
      focus: 'debug',
      blocker: 'same failure',
      next: 'ask owner',
    }) + '\n');
    const result = invoke(directory, 'same failure');
    expect(result.status).not.toBe(0);
    expect(String(result.stderr)).toContain('PROGRESS_BLOCKER_ESCALATION_REQUIRED');
  }));
});

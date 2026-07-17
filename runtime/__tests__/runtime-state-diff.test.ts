import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { safeParse, safeStringify } from '../protocol/serialization';
import {
  buildRuntimeStateDiffReport,
  buildRuntimeStateDiffReportFromJson,
} from '../qa/runtime-state-diff';

describe('runtime state diff', () => {
  test('canonical hashes ignore object and Map insertion order', () => {
    const left = {
      state: new Map<string, unknown>([
        ['z', { beta: 2n, alpha: 1 }],
        ['a', new Set(['right', 'left'])],
      ]),
    };
    const right = {
      state: new Map<string, unknown>([
        ['a', new Set(['left', 'right'])],
        ['z', { alpha: 1, beta: 2n }],
      ]),
    };

    const report = buildRuntimeStateDiffReport(left, right);

    expect(report.equal).toBe(true);
    expect(report.leftHash).toBe(report.rightHash);
    expect(report.firstDifference).toBeNull();
  });

  test('finds the deterministic first nested difference and bounds both values', () => {
    const longPrefix = 'p'.repeat(500);
    const left = {
      entities: new Map([
        ['0x02', { height: 4, payload: `${longPrefix}-left` }],
        ['0x01', { height: 3 }],
      ]),
    };
    const right = {
      entities: new Map([
        ['0x01', { height: 3 }],
        ['0x02', { height: 4, payload: `${longPrefix}-right` }],
      ]),
    };

    const first = buildRuntimeStateDiffReport(left, right, { maxValueChars: 96 });
    const second = buildRuntimeStateDiffReport(left, right, { maxValueChars: 96 });

    expect(first).toEqual(second);
    expect(first.equal).toBe(false);
    expect(first.leftHash).not.toBe(first.rightHash);
    expect(first.firstDifference?.path).toBe('$.entities{"0x02"}.payload');
    expect(first.firstDifference?.reason).toBe('value-mismatch');
    expect(first.firstDifference?.left.value.length).toBeLessThanOrEqual(96);
    expect(first.firstDifference?.right.value.length).toBeLessThanOrEqual(96);
    expect(first.firstDifference?.left.totalChars).toBeGreaterThan(500);
    expect(first.firstDifference?.right.totalChars).toBeGreaterThan(500);
  });

  test('reports the first missing array position', () => {
    const report = buildRuntimeStateDiffReport(
      { outputs: [{ hash: '0x01' }] },
      { outputs: [{ hash: '0x01' }, { hash: '0x02' }] },
    );

    expect(report.firstDifference).toMatchObject({
      path: '$.outputs[1]',
      reason: 'missing-left',
      left: { value: '<missing>', totalChars: 0 },
      right: { value: '{"hash":"0x02"}' },
    });
  });

  test('safeStringify JSON round-trips and invalid input fails loud in helper and CLI', () => {
    const leftJson = safeStringify({ amount: 7n, bytes: new Uint8Array([1, 2, 3]) });
    const rightJson = safeStringify({ amount: 8n, bytes: new Uint8Array([1, 2, 3]) });
    const report = buildRuntimeStateDiffReportFromJson(leftJson, rightJson);

    expect(report.firstDifference?.path).toBe('$.amount');
    expect(() => buildRuntimeStateDiffReportFromJson('{bad', rightJson)).toThrow(
      'RUNTIME_STATE_DIFF_LEFT_JSON_INVALID',
    );

    const root = mkdtempSync(join(tmpdir(), 'xln-runtime-state-diff-'));
    try {
      const leftPath = join(root, 'left.json');
      const rightPath = join(root, 'right.json');
      writeFileSync(leftPath, leftJson);
      writeFileSync(rightPath, rightJson);
      const result = Bun.spawnSync({
        cmd: [process.execPath, 'runtime/qa/runtime-state-diff-cli.ts', leftPath, rightPath],
        cwd: process.cwd(),
        stdout: 'pipe',
        stderr: 'pipe',
      });

      expect(result.exitCode).toBe(1);
      const cliReport = safeParse<ReturnType<typeof buildRuntimeStateDiffReport>>(result.stdout.toString());
      expect(cliReport).toEqual(report);

      writeFileSync(leftPath, '{bad');
      const invalid = Bun.spawnSync({
        cmd: [process.execPath, 'runtime/qa/runtime-state-diff-cli.ts', leftPath, rightPath],
        cwd: process.cwd(),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(invalid.exitCode).toBe(2);
      expect(invalid.stderr.toString()).toContain('RUNTIME_STATE_DIFF_LEFT_JSON_INVALID');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

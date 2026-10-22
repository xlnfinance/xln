import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeStringify } from '../../../protocol/serialization';
import { readPlaywrightFailureReport } from '../../../scripts/e2e/harness/e2e-failure-capsule';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

const expected = { file: 'tests/required.spec.ts', title: 'required acceptance case' };
const report = () => ({
  config: { rootDir: join(process.cwd(), 'tests') },
  errors: [] as { message: string }[],
  stats: { expected: 1, skipped: 0, unexpected: 0, flaky: 0 },
  suites: [
    {
      specs: [
        {
          file: 'required.spec.ts',
          title: expected.title,
          ok: true,
          tests: [{ status: 'expected', results: [{ status: 'passed' }] }],
        },
      ],
    },
  ],
});
const read = (data: ReturnType<typeof report>) => {
  const root = mkdtempSync(join(tmpdir(), 'xln-required-pass-'));
  roots.push(root);
  const path = join(root, 'report.json');
  writeFileSync(path, safeStringify(data));
  return readPlaywrightFailureReport(path, expected);
};

test('required shard accepts exactly its one executed passing test', () => {
  expect(read(report())).toBeNull();
});

test.each(['skipped', 'flaky', 'unexpected'] as const)('required shard rejects %s evidence', status => {
  const data = report();
  data.stats.expected = 0;
  data.stats[status] = 1;
  expect(() => read(data)).toThrow('E2E_PLAYWRIGHT_REQUIRED_PASS_INVALID');
});

test('required shard rejects zero tests and substring over-selection', () => {
  for (const count of [0, 2]) {
    const data = report();
    data.stats.expected = count;
    data.suites[0]!.specs = Array.from({ length: count }, () => data.suites[0]!.specs[0]!);
    expect(() => read(data)).toThrow('E2E_PLAYWRIGHT_REQUIRED_PASS_INVALID');
  }
});

test('required shard rejects a different title or file', () => {
  for (const field of ['title', 'file'] as const) {
    const data = report();
    data.suites[0]!.specs[0]![field] = 'different';
    expect(() => read(data)).toThrow('E2E_PLAYWRIGHT_REQUIRED_TEST_MISMATCH');
  }
});

test('required shard rejects skipped results despite forged passing totals', () => {
  const data = report();
  data.suites[0]!.specs[0]!.tests[0]!.results[0]!.status = 'skipped';
  expect(() => read(data)).toThrow('E2E_PLAYWRIGHT_REQUIRED_PASS_INVALID');
});

test('required shard rejects report-level errors despite passing totals', () => {
  const data = report();
  data.errors.push({ message: 'worker teardown failed' });
  expect(() => read(data)).toThrow('E2E_PLAYWRIGHT_REQUIRED_PASS_INVALID');
});

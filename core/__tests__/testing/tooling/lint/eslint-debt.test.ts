import { describe, expect, test } from 'bun:test';
import { ESLint } from 'eslint';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { assertEslintDebt, type EslintFile } from '../../../../scripts/checks/architecture/eslint/debt';

const root = resolve(import.meta.dir, '../../../../..');
const serializer = 'core/protocol/serialization/index.ts';
const approvedHash = '2ce06efcf0394912defbc97dd5cf74e07401c8a3b395569fadeaf757634b7008';

const lintFixture = async (
  fileName: string,
  source: string,
  verify: (report: readonly EslintFile[], directory: string) => void,
): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'xln-eslint-debt-'));
  try {
    const filePath = join(directory, fileName);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, source);
    const eslint = new ESLint({ cwd: directory, overrideConfigFile: join(root, 'eslint.config.js') });
    const report = await eslint.lintText(source, { filePath });
    verify(report, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

describe('Shared exact ESLint debt policy', () => {
  test('accepts only the two approved serializer findings under the unchanged full baseline', async () => {
    const eslint = new ESLint({ cwd: root });
    const report = await eslint.lintFiles([join(root, serializer)]);
    const result = assertEslintDebt(report, [serializer], root);
    expect(result.debtRows).toHaveLength(2);
    expect(result.debtRows.every(row => row.startsWith(`${serializer}|no-restricted-properties|`))).toBeTrue();
    expect(result.approvedDebtCount).toBe(315);
    expect(result.approvedDebtHash).toBe(approvedHash);
  });

  test('rejects a new raw JSON finding rather than inheriting the serializer allowance', async () => {
    const fileName = 'core/__lint-probe__.ts';
    await lintFixture(fileName, 'export const unsafe = JSON.stringify({ amount: 1n });\n', (report, directory) => {
      expect(report.flatMap(file => file.messages).map(message => message.ruleId)).toEqual(['no-restricted-properties']);
      expect(() => assertEslintDebt(report, [fileName], directory)).toThrow('ESLINT_DEBT_CHANGED expected=0/');
    });
  });

  test('rejects omitted approved findings instead of passing a partial scoped report', async () => {
    const source = await readFile(join(root, serializer), 'utf8');
    const removed = source.replace('JSON.stringify(value)', 'String(value)');
    expect(removed).not.toBe(source);
    await lintFixture(serializer, removed, (report, directory) => {
      expect(report.flatMap(file => file.messages)).toHaveLength(1);
      expect(() => assertEslintDebt(report, [serializer], directory)).toThrow('ESLINT_DEBT_CHANGED expected=2/');
    });
  });

  test('rejects changed approved source even when the finding count remains two', async () => {
    const source = await readFile(join(root, serializer), 'utf8');
    const changed = source.replace('JSON.stringify(value)', 'JSON.stringify([value])');
    expect(changed).not.toBe(source);
    await lintFixture(serializer, changed, (report, directory) => {
      expect(report.flatMap(file => file.messages)).toHaveLength(2);
      expect(() => assertEslintDebt(report, [serializer], directory)).toThrow('ESLINT_DEBT_CHANGED expected=2/');
    });
  });

  test('requires every declared scoped file to have actually been linted', async () => {
    const fileName = 'core/__lint-probe__.ts';
    await lintFixture(fileName, 'export const clean = 1;\n', (report, directory) => {
      expect(report.flatMap(file => file.messages)).toHaveLength(0);
      expect(() => assertEslintDebt(report, [fileName, serializer], directory)).toThrow('ESLINT_SCOPE_NOT_CHECKED');
    });
  });
});

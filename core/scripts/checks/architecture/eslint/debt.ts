/** One exact existing debt policy for full-repository and focused ESLint checks. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';

export type EslintFile = Readonly<{
  filePath: string;
  messages: readonly Readonly<{ ruleId: string | null; message: string; line: number }>[];
}>;

const DEBT_RULES = new Set(['import/no-duplicates', 'no-restricted-properties']);
const DEBT_COUNT = 315;
const DEBT_SHA256 = '2ce06efcf0394912defbc97dd5cf74e07401c8a3b395569fadeaf757634b7008';
const hashRows = (rows: readonly string[]): string => createHash('sha256').update(rows.join('\n')).digest('hex');

const approvedRows = (): string[] => {
  const value: unknown = JSON.parse(readFileSync(new URL('./debt.json', import.meta.url), 'utf8'));
  if (!Array.isArray(value) || !value.every((row): row is string => typeof row === 'string')) {
    throw new Error('ESLINT_DEBT_BASELINE_INVALID');
  }
  const rows = [...value].sort();
  if (rows.length !== DEBT_COUNT || hashRows(rows) !== DEBT_SHA256) throw new Error('ESLINT_DEBT_BASELINE_CHANGED');
  return rows;
};

export const normalizeEslintReport = (report: readonly EslintFile[], cwd = process.cwd()) => {
  const semanticErrors: string[] = [];
  const debtRows: string[] = [];
  for (const file of report) {
    const sourceLines = readFileSync(file.filePath, 'utf8').split(/\r?\n/);
    const fileName = relative(cwd, file.filePath);
    for (const message of file.messages) {
      if (!message.ruleId || !DEBT_RULES.has(message.ruleId)) {
        semanticErrors.push(`${fileName}:${message.line} ${message.ruleId ?? 'parse'} ${message.message}`);
      } else {
        const source = (sourceLines[message.line - 1] ?? '').trim().replace(/\s+/g, ' ');
        debtRows.push(`${fileName}|${message.ruleId}|${source}`);
      }
    }
  }
  return { semanticErrors, debtRows: debtRows.sort() };
};

export const assertEslintDebt = (report: readonly EslintFile[], scope?: readonly string[], cwd = process.cwd()) => {
  const { semanticErrors, debtRows } = normalizeEslintReport(report, cwd);
  if (semanticErrors.length) throw new Error(`ESLINT_SEMANTIC_FAILURE\n${semanticErrors.join('\n')}`);
  const approved = approvedRows();
  const scoped = scope ? new Set(scope) : null;
  const actualFiles = new Set(report.map(file => relative(cwd, file.filePath)));
  if (scoped && [...scoped].some(path => !actualFiles.has(path))) throw new Error('ESLINT_SCOPE_NOT_CHECKED');
  const expected = scoped ? approved.filter(row => scoped.has(row.slice(0, row.indexOf('|')))) : approved;
  const debtHash = hashRows(debtRows);
  if (debtRows.length !== expected.length || debtHash !== hashRows(expected)) {
    throw new Error(`ESLINT_DEBT_CHANGED expected=${expected.length}/${hashRows(expected)} ` +
      `actual=${debtRows.length}/${debtHash}. Remove fixed debt from the exact baseline; never add debt.`);
  }
  return { debtRows, debtHash, approvedDebtCount: DEBT_COUNT, approvedDebtHash: DEBT_SHA256 };
};

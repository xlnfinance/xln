import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { readFileSync, rmSync } from 'node:fs';
import { relative } from 'node:path';

type EslintMessage = {
  ruleId: string | null;
  message: string;
  line: number;
};

type EslintFile = {
  filePath: string;
  messages: EslintMessage[];
};

const DEBT_RULES = new Set(['import/no-duplicates', 'no-restricted-properties']);
const DEBT_COUNT = 429;
const DEBT_SHA256 = '4832247b2989535fd60e6feed421d4792b48fe034191b03121f14bdecc9f520f';
const outputPath = `${tmpdir()}/xln-eslint-${String(process.pid)}.json`;

const result = spawnSync(
  'bunx',
  ['eslint', 'runtime', '--ext', '.ts', '--format', 'json', '--output-file', outputPath],
  { cwd: process.cwd(), encoding: 'utf8' },
);

try {
  if (result.error) throw result.error;
  if (result.status === null) throw new Error(`ESLINT_DID_NOT_EXIT:${result.signal ?? 'unknown'}`);
  const report = JSON.parse(readFileSync(outputPath, 'utf8')) as EslintFile[];
  const semanticErrors: string[] = [];
  const debtRows: string[] = [];

  for (const file of report) {
    const sourceLines = readFileSync(file.filePath, 'utf8').split(/\r?\n/);
    for (const message of file.messages) {
      const fileName = relative(process.cwd(), file.filePath);
      if (!message.ruleId || !DEBT_RULES.has(message.ruleId)) {
        semanticErrors.push(`${fileName}:${message.line} ${message.ruleId ?? 'parse'} ${message.message}`);
        continue;
      }
      const source = (sourceLines[message.line - 1] ?? '').trim().replace(/\s+/g, ' ');
      debtRows.push(`${fileName}|${message.ruleId}|${source}`);
    }
  }

  if (semanticErrors.length > 0) {
    throw new Error(`ESLINT_SEMANTIC_FAILURE\n${semanticErrors.join('\n')}`);
  }

  debtRows.sort();
  const debtHash = new Bun.CryptoHasher('sha256').update(debtRows.join('\n')).digest('hex');
  if (debtRows.length !== DEBT_COUNT || debtHash !== DEBT_SHA256) {
    throw new Error(
      `ESLINT_DEBT_CHANGED expected=${DEBT_COUNT}/${DEBT_SHA256} ` +
      `actual=${debtRows.length}/${debtHash}. Remove fixed debt from the exact baseline; never add debt.`,
    );
  }

  console.log(`ESLINT_RATCHET_OK semantic=0 debt=${debtRows.length} sha256=${debtHash}`);
} finally {
  rmSync(outputPath, { force: true });
}

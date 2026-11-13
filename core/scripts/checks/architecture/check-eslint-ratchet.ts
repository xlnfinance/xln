import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { readFileSync, rmSync } from 'node:fs';
import { assertEslintDebt, type EslintFile } from './eslint/debt';
const outputPath = `${tmpdir()}/xln-eslint-${String(process.pid)}.json`;

const result = spawnSync('bunx', ['eslint', 'core', '--ext', '.ts', '--format', 'json', '--output-file', outputPath], {
  cwd: process.cwd(),
  encoding: 'utf8',
});

try {
  if (result.error) throw result.error;
  if (result.status === null) throw new Error(`ESLINT_DID_NOT_EXIT:${result.signal ?? 'unknown'}`);
  const report = JSON.parse(readFileSync(outputPath, 'utf8')) as EslintFile[];
  const { debtRows, debtHash } = assertEslintDebt(report);

  console.log(`ESLINT_RATCHET_OK semantic=0 debt=${debtRows.length} sha256=${debtHash}`);
} finally {
  rmSync(outputPath, { force: true });
}

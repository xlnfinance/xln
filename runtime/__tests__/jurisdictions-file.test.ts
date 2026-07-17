import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readJurisdictionsFile } from '../orchestrator/jurisdictions-file';

const tempRoots: string[] = [];

const tempPath = (contents?: string): string => {
  const root = mkdtempSync(join(tmpdir(), 'xln-jurisdictions-file-'));
  tempRoots.push(root);
  const filePath = join(root, 'jurisdictions.json');
  if (contents !== undefined) writeFileSync(filePath, contents, 'utf8');
  return filePath;
};

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('jurisdictions reader distinguishes a missing file from malformed JSON', () => {
  const missingPath = tempPath();
  expect(readJurisdictionsFile(missingPath)).toBeNull();

  const malformedPath = tempPath('{"version":');
  expect(() => readJurisdictionsFile(malformedPath)).toThrow(
    `JURISDICTIONS_FILE_INVALID:path=${malformedPath}:error=`,
  );
});

test('jurisdictions reader returns a parsed object', () => {
  const filePath = tempPath('{"version":"3","jurisdictions":{}}');
  expect(readJurisdictionsFile(filePath)).toEqual({ version: '3', jurisdictions: {} });
});

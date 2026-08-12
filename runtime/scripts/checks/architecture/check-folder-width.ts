#!/usr/bin/env bun

import { readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_DIRECT_TYPESCRIPT_FILES = 10;

export type FolderWidth = Readonly<{
  path: string;
  files: number;
}>;

export const FOLDER_WIDTH_DEBT: Readonly<Record<string, number>> = {
  'runtime/__tests__': 261,
};

export const collectFolderWidths = (root: string, directory = root): FolderWidth[] => {
  const entries = readdirSync(directory, { withFileTypes: true });
  const current = {
    path: relative(root, directory).replaceAll('\\', '/') || '.',
    files: entries.filter(entry => entry.isFile() && entry.name.endsWith('.ts')).length,
  };
  const children = entries
    .filter(entry => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap(entry => collectFolderWidths(root, resolve(directory, entry.name)));
  return [current, ...children];
};

export const evaluateFolderWidths = (
  widths: readonly FolderWidth[],
  debt: Readonly<Record<string, number>> = FOLDER_WIDTH_DEBT,
  maximum = MAX_DIRECT_TYPESCRIPT_FILES,
): string[] => {
  const byPath = new Map(widths.map(entry => [entry.path, entry.files]));
  const errors: string[] = [];

  for (const { path, files } of widths) {
    if (files <= maximum) continue;
    const allowance = debt[path];
    if (allowance === undefined) {
      errors.push(`FOLDER_TOO_WIDE ${path}:${files} > ${maximum}`);
    } else if (files !== allowance) {
      errors.push(`FOLDER_WIDTH_DEBT_CHANGED ${path}:${files} != ${allowance}`);
    }
  }

  for (const [path, allowance] of Object.entries(debt).sort(([left], [right]) => left.localeCompare(right))) {
    const files = byPath.get(path);
    if (files === undefined) {
      errors.push(`STALE_FOLDER_WIDTH_DEBT ${path}:missing allowance=${allowance}`);
    } else if (files <= maximum) {
      errors.push(`STALE_FOLDER_WIDTH_DEBT ${path}:${files} <= ${maximum}`);
    }
  }

  return errors.sort();
};

const run = (): void => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const widths = collectFolderWidths(repoRoot, resolve(repoRoot, 'runtime'));
  const errors = evaluateFolderWidths(widths);
  if (errors.length > 0) {
    throw new Error(`FOLDER_WIDTH_INVARIANT_FAILED:\n${errors.map(error => `- ${error}`).join('\n')}`);
  }
  const widest = Math.max(...widths.filter(entry => FOLDER_WIDTH_DEBT[entry.path] === undefined).map(entry => entry.files));
  const debt = Object.entries(FOLDER_WIDTH_DEBT)
    .map(([path, files]) => `${path}:${files}`)
    .join(',');
  console.log(`FOLDER_WIDTH_OK dirs=${widths.length} max=${widest}/${MAX_DIRECT_TYPESCRIPT_FILES} debt=${debt}`);
};

if (import.meta.main) run();

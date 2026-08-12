#!/usr/bin/env bun

import { readdirSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_DIRECT_SOURCE_FILES = 10;

export const SOURCE_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.cjs',
  '.css',
  '.cts',
  '.go',
  '.java',
  '.js',
  '.jsx',
  '.kt',
  '.kts',
  '.mjs',
  '.mts',
  '.py',
  '.rs',
  '.scss',
  '.sh',
  '.sol',
  '.svelte',
  '.swift',
  '.ts',
  '.tsx',
]);

const GENERATED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  'build',
  'coverage',
  'dist',
  'node_modules',
]);

const EXCLUDED_REPOSITORY_PATHS: ReadonlySet<string> = new Set([
  '.agents',
  '.archive',
  '.claude',
  '.codex',
  '.crush',
  '.e2e-mesh-db',
  '.logs',
  '.obsidian',
  '.playwright-mcp',
  '.tmp',
  '.vscode',
  '.xln-db',
  'data/tmp',
  'db',
  'frontend/.svelte-kit',
  'frontend/.svelte-kit-dev-http',
  'frontend/.svelte-kit-dev-https',
  'frontend/android/app/src/main/assets/public',
  'frontend/ios/App/App/public',
  'jurisdictions/artifacts',
  'jurisdictions/build-tron',
  'jurisdictions/cache',
  'jurisdictions/db-tmp',
  'jurisdictions/forge-cache',
  'jurisdictions/forge-out',
  'jurisdictions/lib',
  'jurisdictions/typechain-types',
  'packages/npm/xlnfinance/app',
  'packages/npm/xlnfinance/dist',
  'reports',
  'ui/public',
]);

export type FolderWidth = Readonly<{
  path: string;
  files: number;
}>;

export const FOLDER_WIDTH_DEBT: Readonly<Record<string, number>> = {
  brainvault: 11,
  'cli/lib': 13,
  frontend: 11,
  'frontend/src/lib/components/Entity': 70,
  'frontend/src/lib/components/Rcpan': 22,
  'frontend/src/lib/network3d': 14,
  'frontend/src/lib/stores': 13,
  'frontend/src/lib/view/panels': 20,
  'jurisdictions/contracts': 16,
  'jurisdictions/scripts': 14,
  'jurisdictions/test': 19,
  scripts: 25,
  'scripts/dev': 12,
  tests: 53,
  'tests/frontend': 70,
  'tests/utils': 20,
};

const normalizeRelativePath = (root: string, path: string): string =>
  relative(root, path).replaceAll('\\', '/') || '.';

const isExcludedRepositoryPath = (path: string): boolean => {
  for (const excluded of EXCLUDED_REPOSITORY_PATHS) {
    if (path === excluded || path.startsWith(`${excluded}/`)) return true;
  }
  return false;
};

const isSourceFile = (name: string): boolean => SOURCE_FILE_EXTENSIONS.has(extname(name));

export const collectFolderWidths = (root: string, directory = root): FolderWidth[] => {
  const entries = readdirSync(directory, { withFileTypes: true });
  const currentPath = normalizeRelativePath(root, directory);
  const current = {
    path: currentPath,
    files: entries.filter(entry => entry.isFile() && isSourceFile(entry.name)).length,
  };
  const children = entries
    .filter(entry => {
      if (!entry.isDirectory() || GENERATED_DIRECTORY_NAMES.has(entry.name)) return false;
      const childPath = normalizeRelativePath(root, resolve(directory, entry.name));
      return !isExcludedRepositoryPath(childPath);
    })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap(entry => collectFolderWidths(root, resolve(directory, entry.name)));
  return [current, ...children];
};

export const evaluateFolderWidths = (
  widths: readonly FolderWidth[],
  debt: Readonly<Record<string, number>> = FOLDER_WIDTH_DEBT,
  maximum = MAX_DIRECT_SOURCE_FILES,
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
  const widths = collectFolderWidths(repoRoot);
  const errors = evaluateFolderWidths(widths);
  if (errors.length > 0) {
    throw new Error(`FOLDER_WIDTH_INVARIANT_FAILED:\n${errors.map(error => `- ${error}`).join('\n')}`);
  }
  const sourceFiles = widths.reduce((sum, entry) => sum + entry.files, 0);
  const widest = Math.max(
    0,
    ...widths.filter(entry => FOLDER_WIDTH_DEBT[entry.path] === undefined).map(entry => entry.files),
  );
  const debt = Object.entries(FOLDER_WIDTH_DEBT)
    .map(([path, files]) => `${path}:${files}`)
    .join(',');
  console.log(
    `FOLDER_WIDTH_OK dirs=${widths.length} sourceFiles=${sourceFiles} ` +
    `max=${widest}/${MAX_DIRECT_SOURCE_FILES} debt=${debt}`,
  );
};

if (import.meta.main) run();

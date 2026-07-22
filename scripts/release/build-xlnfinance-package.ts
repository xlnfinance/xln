#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dir, '../..');
const PACKAGE_DIR = join(ROOT, 'packages/npm/xlnfinance');
const DIST_DIR = join(PACKAGE_DIR, 'dist');
const APP_DIR = join(PACKAGE_DIR, 'app');
const FRONTEND_BUILD = join(ROOT, 'frontend/build');
const skipBuild = process.argv.includes('--skip-build');
const shouldPack = process.argv.includes('--pack');

const run = (command: string, args: string[], cwd = ROOT): void => {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with ${result.status}`);
};

const jsonFile = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

const walkFiles = (root: string): string[] => readdirSync(root, { withFileTypes: true })
  .flatMap(entry => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? walkFiles(path) : entry.isFile() ? [path] : [];
  })
  .sort();

const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

const assertVersions = (): string => {
  const root = jsonFile<{ version: string }>(join(ROOT, 'package.json'));
  const packageFile = jsonFile<{ version: string }>(join(PACKAGE_DIR, 'package.json'));
  if (root.version !== packageFile.version) {
    throw new Error(`XLNFINANCE_VERSION_MISMATCH:root=${root.version}:package=${packageFile.version}`);
  }
  return root.version;
};

const buildPackage = (): void => {
  const version = assertVersions();
  if (!skipBuild) {
    run('bun', ['run', 'build']);
    run('bun', ['run', 'build'], join(ROOT, 'frontend'));
  }
  rmSync(DIST_DIR, { recursive: true, force: true });
  rmSync(APP_DIR, { recursive: true, force: true });
  mkdirSync(DIST_DIR, { recursive: true });
  run('bun', [
    'build',
    'runtime/server/index.ts',
    '--target=bun',
    `--outfile=${join(DIST_DIR, 'server.js')}`,
  ]);
  cpSync(FRONTEND_BUILD, APP_DIR, {
    recursive: true,
    filter: source => basename(source) !== '.DS_Store',
  });

  const files = [...walkFiles(DIST_DIR), ...walkFiles(APP_DIR)];
  const manifest = {
    schemaVersion: 1,
    version,
    files: files.map(path => ({
      path: relative(PACKAGE_DIR, path).replaceAll('\\', '/'),
      bytes: statSync(path).size,
      sha256: sha256(path),
    })),
  };
  writeFileSync(join(DIST_DIR, 'bundle-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`xlnfinance ${version}: ${manifest.files.length} files ready`);
};

buildPackage();
if (shouldPack) run('bun', ['pm', 'pack'], PACKAGE_DIR);

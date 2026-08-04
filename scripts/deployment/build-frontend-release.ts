#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { packageFrontendRelease } from './frontend-release-package';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

const option = (args: readonly string[], name: string): string | undefined => {
  const prefix = `--${name}=`;
  return args.find(arg => arg.startsWith(prefix))?.slice(prefix.length);
};

const gitCommit = (): string => {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`FRONTEND_RELEASE_GIT_COMMIT_UNAVAILABLE:${result.stderr.trim()}`);
  return result.stdout.trim();
};

const productVersion = (): string => {
  const value = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version?: unknown };
  if (typeof value.version !== 'string' || value.version.length === 0) {
    throw new Error('FRONTEND_RELEASE_PRODUCT_VERSION_MISSING');
  }
  return value.version;
};

const main = (): void => {
  const args = process.argv.slice(2);
  const unknown = args.filter(arg => ![
    '--build-root=', '--release-root=', '--source-commit=', '--product-version=',
  ].some(prefix => arg.startsWith(prefix)));
  if (unknown.length > 0) throw new Error(`FRONTEND_RELEASE_ARGUMENT_UNKNOWN:${unknown.join(',')}`);
  const sourceCommit = option(args, 'source-commit') ?? gitCommit();
  const version = option(args, 'product-version') ?? productVersion();
  const releaseId = `${version}-${sourceCommit.slice(0, 12)}`;
  const releaseRoot = resolve(option(args, 'release-root') ?? join(ROOT, 'frontend/releases', releaseId));
  const manifest = packageFrontendRelease({
    buildRoot: resolve(option(args, 'build-root') ?? join(ROOT, 'frontend/build')),
    releaseRoot,
    sourceCommit,
    productVersion: version,
  });
  console.log(`FRONTEND_RELEASE_BUILT id=${manifest.releaseId} root=${releaseRoot}`);
};

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

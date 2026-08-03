#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  activateFrontendRelease,
  pruneFrontendReleases,
  rollbackFrontendRelease,
} from './atomic-frontend-release';
import { verifyFrontendReleaseTree } from './frontend-release-files';
import { verifyActiveFrontendRelease } from './frontend-release-health';
import {
  FRONTEND_RELEASE_MANIFEST_FILE,
  parseFrontendReleaseManifest,
} from './frontend-release-schema';

const option = (args: readonly string[], name: string): string | undefined => {
  const prefix = `--${name}=`;
  return args.find(arg => arg.startsWith(prefix))?.slice(prefix.length);
};

const assertArguments = (args: readonly string[], positional: number): void => {
  const positionals = args.filter(arg => !arg.startsWith('--'));
  const options = args.filter(arg => arg.startsWith('--'));
  if (positionals.length !== positional) throw new Error('FRONTEND_RELEASE_ARGUMENT_COUNT_INVALID');
  if (options.some(arg => !arg.startsWith('--base-url='))) {
    throw new Error(`FRONTEND_RELEASE_ARGUMENT_UNKNOWN:${options.join(',')}`);
  }
};

const validatedRelease = (releaseRoot: string) => {
  const root = resolve(releaseRoot);
  const manifest = parseFrontendReleaseManifest(
    readFileSync(join(root, FRONTEND_RELEASE_MANIFEST_FILE), 'utf8'),
  );
  verifyFrontendReleaseTree(root, manifest);
  return { root, manifest };
};

const validateRelease = (releaseRoot: string): void => {
  const { root, manifest } = validatedRelease(releaseRoot);
  console.log(`FRONTEND_RELEASE_VALID id=${manifest.releaseId} root=${root}`);
};

const requiredBaseUrl = (args: readonly string[]): string => {
  const baseUrl = option(args, 'base-url');
  if (!baseUrl) throw new Error('FRONTEND_RELEASE_BASE_URL_REQUIRED');
  return baseUrl;
};

const requiredPositional = (args: readonly string[], index: number): string => {
  const value = args.filter(arg => !arg.startsWith('--'))[index];
  if (!value) throw new Error(`FRONTEND_RELEASE_POSITIONAL_MISSING:${index}`);
  return value;
};

const main = async (): Promise<void> => {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'validate') {
    assertArguments(args, 1);
    validateRelease(requiredPositional(args, 0));
    return;
  }
  if (command === 'activate') {
    assertArguments(args, 2);
    const frontendRoot = requiredPositional(args, 0);
    const releaseId = requiredPositional(args, 1);
    const result = await activateFrontendRelease(resolve(frontendRoot), releaseId, manifest =>
      verifyActiveFrontendRelease(requiredBaseUrl(args), manifest));
    console.log(`FRONTEND_RELEASE_ACTIVE current=${result.current} previous=${result.previous ?? 'none'}`);
    return;
  }
  if (command === 'health') {
    assertArguments(args, 1);
    const { manifest } = validatedRelease(requiredPositional(args, 0));
    await verifyActiveFrontendRelease(requiredBaseUrl(args), manifest);
    console.log(`FRONTEND_RELEASE_HEALTHY id=${manifest.releaseId}`);
    return;
  }
  if (command === 'rollback') {
    assertArguments(args, 1);
    const frontendRoot = requiredPositional(args, 0);
    const result = await rollbackFrontendRelease(resolve(frontendRoot), manifest =>
      verifyActiveFrontendRelease(requiredBaseUrl(args), manifest));
    console.log(`FRONTEND_RELEASE_ROLLED_BACK current=${result.current} previous=${result.previous ?? 'none'}`);
    return;
  }
  if (command === 'prune') {
    if (args.length < 2 || args.some(arg => arg.startsWith('--'))) {
      throw new Error('FRONTEND_RELEASE_PRUNE_ARGUMENTS_INVALID');
    }
    const frontendRoot = requiredPositional(args, 0);
    const releaseIds = args.slice(1);
    const pruned = pruneFrontendReleases(resolve(frontendRoot), releaseIds);
    console.log(`FRONTEND_RELEASES_PRUNED ids=${pruned.join(',')}`);
    return;
  }
  throw new Error(`FRONTEND_RELEASE_COMMAND_INVALID:${command ?? ''}`);
};

if (import.meta.main) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

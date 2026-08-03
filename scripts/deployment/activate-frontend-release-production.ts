#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { activateFrontendRelease } from './atomic-frontend-release';
import { buildFrontendNginxConfig } from './frontend-nginx-config';
import { verifyActiveFrontendRelease } from './frontend-release-health';
import { installFrontendReleaseInclude } from './nginx-site-release-include';

type FileSnapshot = Readonly<{ path: string; content: string | null }>;

const option = (name: string): string | undefined => {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find(arg => arg.startsWith(prefix))?.slice(prefix.length);
};

const requiredOption = (name: string): string => {
  const value = option(name);
  if (!value) throw new Error(`FRONTEND_PRODUCTION_OPTION_REQUIRED:${name}`);
  return value;
};

const snapshot = (path: string): FileSnapshot => ({
  path,
  content: existsSync(path) ? readFileSync(path, 'utf8') : null,
});

const writeAtomic = (path: string, content: string): void => {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, content);
  renameSync(temporary, path);
};

const restore = (file: FileSnapshot): void => {
  if (file.content === null) {
    if (existsSync(file.path)) unlinkSync(file.path);
    return;
  }
  writeAtomic(file.path, file.content);
};

const runRequired = (command: string, args: readonly string[]): void => {
  const result = spawnSync(command, [...args], { stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`FRONTEND_PRODUCTION_COMMAND_FAILED:${command}:${result.status}`);
};

const reloadNginx = (): void => {
  runRequired('nginx', ['-t']);
  runRequired('systemctl', ['reload', 'nginx']);
};

const main = async (): Promise<void> => {
  const frontendRoot = resolve(requiredOption('frontend-root'));
  const releaseId = requiredOption('release-id');
  const baseUrl = requiredOption('base-url');
  const sitePath = resolve(requiredOption('nginx-site'));
  const includePath = resolve(requiredOption('nginx-include'));
  const siteBefore = snapshot(sitePath);
  const includeBefore = snapshot(includePath);
  const siteSource = siteBefore.content;
  if (siteSource === null) throw new Error(`FRONTEND_NGINX_SITE_MISSING:${sitePath}`);

  const result = await activateFrontendRelease(frontendRoot, releaseId, async manifest => {
    try {
      writeAtomic(includePath, buildFrontendNginxConfig(frontendRoot));
      writeAtomic(sitePath, installFrontendReleaseInclude(siteSource, includePath));
      reloadNginx();
      await verifyActiveFrontendRelease(baseUrl, manifest);
    } catch (error) {
      restore(siteBefore);
      restore(includeBefore);
      reloadNginx();
      throw error;
    }
  });
  console.log(`FRONTEND_RELEASE_ACTIVE current=${result.current} previous=${result.previous ?? 'none'}`);
};

if (import.meta.main) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

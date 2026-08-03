#!/usr/bin/env bun
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { installFrontendReleaseInclude } from './nginx-site-release-include';

const option = (name: string): string | undefined => {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find(arg => arg.startsWith(prefix))?.slice(prefix.length);
};

const main = (): void => {
  const site = option('site');
  const include = option('include');
  if (!site) throw new Error('FRONTEND_NGINX_SITE_REQUIRED');
  if (!include) throw new Error('FRONTEND_NGINX_INCLUDE_REQUIRED');
  const destination = resolve(site);
  const source = readFileSync(destination, 'utf8');
  const transformed = installFrontendReleaseInclude(source, include);
  const temporary = `${destination}.tmp-${process.pid}`;
  writeFileSync(temporary, transformed);
  renameSync(temporary, destination);
  console.log(`FRONTEND_NGINX_SITE_UPDATED:${destination}`);
};

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

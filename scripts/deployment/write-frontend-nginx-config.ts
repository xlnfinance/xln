#!/usr/bin/env bun
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { buildFrontendNginxConfig } from './frontend-nginx-config';

const option = (name: string): string | undefined => {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find(arg => arg.startsWith(prefix))?.slice(prefix.length);
};

const main = (): void => {
  const frontendRoot = option('frontend-root');
  const output = option('output');
  if (!frontendRoot) throw new Error('FRONTEND_NGINX_ROOT_REQUIRED');
  if (!output) throw new Error('FRONTEND_NGINX_OUTPUT_REQUIRED');
  const destination = resolve(output);
  const temporary = `${destination}.tmp-${process.pid}`;
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(temporary, buildFrontendNginxConfig(frontendRoot));
  renameSync(temporary, destination);
  console.log(`FRONTEND_NGINX_CONFIG_WRITTEN:${destination}`);
};

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

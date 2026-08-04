#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FRONTEND_SURFACE_IDS } from '../../scripts/deployment/frontend-release-schema';

const FRONTEND_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const BUILD_ROOT = resolve(FRONTEND_ROOT, 'build');
const VITE_CLI = resolve(FRONTEND_ROOT, 'node_modules/vite/bin/vite.js');

const run = (args: readonly string[], env: NodeJS.ProcessEnv = process.env): void => {
  const result = spawnSync(process.execPath, [...args], {
    cwd: FRONTEND_ROOT,
    env: { ...env, XLN_BUN_EXECUTABLE: process.execPath },
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`FRONTEND_BUILD_COMMAND_FAILED:${args.join(' ')}:${result.status}`);
};

rmSync(BUILD_ROOT, { recursive: true, force: true });
run(['copy-static-files.js']);
for (const surface of FRONTEND_SURFACE_IDS) {
  run([VITE_CLI, 'build', '--config', 'vite.config.ts'], {
    ...process.env,
    XLN_FRONTEND_SURFACE: surface,
  });
}

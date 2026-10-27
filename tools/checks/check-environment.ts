import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = realpathSync(resolve(import.meta.dir, '../..'));

export const assertCheckEnvironment = (cwd = process.cwd(), version = Bun.version): void => {
  if (realpathSync(cwd) !== ROOT) {
    throw new Error(`CHECK_CWD_MISMATCH:running=${cwd}:required=${ROOT}`);
  }
  const { packageManager } = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
    packageManager?: unknown;
  };
  if (typeof packageManager !== 'string' || !/^bun@\d+\.\d+\.\d+$/.test(packageManager)) {
    throw new Error('CHECK_PACKAGE_MANAGER_INVALID');
  }
  const pinned = packageManager.slice(4);
  if (version !== pinned) throw new Error(`CHECK_BUN_VERSION_MISMATCH:running=${version}:pinned=${pinned}`);
};

if (import.meta.main) assertCheckEnvironment();

import { accessSync, constants, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { git, repository } from './git';

const activeDefaultHooks = (root: string): string[] => {
  const directory = resolve(root, git(root, ['rev-parse', '--git-path', 'hooks']).trim());
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter(name => {
      if (name.endsWith('.sample')) return false;
      try {
        accessSync(join(directory, name), constants.X_OK);
        return true;
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'EACCES') return false;
        throw error;
      }
    })
    .map(name => join(directory, name));
};

export const install = (cwd: string): void => {
  const { root } = repository(cwd);
  const configured = Bun.spawnSync(['git', 'config', '--show-origin', '--get-all', 'core.hooksPath'], { cwd: root });
  if (configured.exitCode !== 0 && configured.exitCode !== 1) throw new Error(configured.stderr.toString());
  const settings = configured.stdout.toString().trim().split('\n').filter(Boolean);
  const conflicts = settings.filter(
    line => resolve(root, line.slice(line.indexOf('\t') + 1)) !== join(root, '.githooks'),
  );
  if (conflicts.length) throw new Error(`VERIFY_HOOK_CONFIG_CONFLICT:\n${conflicts.join('\n')}`);
  if (!settings.length) {
    const hooks = activeDefaultHooks(root);
    if (hooks.length) throw new Error(`VERIFY_EXISTING_HOOKS_CONFLICT:\n${hooks.join('\n')}`);
  }
  accessSync(join(root, '.githooks', 'pre-push'), constants.X_OK);
  git(root, ['config', '--local', 'core.hooksPath', '.githooks']);
  console.log('VERIFY_HOOK_INSTALLED:core.hooksPath=.githooks');
};

if (import.meta.main) {
  try {
    install(process.cwd());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

import { readdirSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

export const discoverDeploymentTests = (directory: string, repositoryRoot: string): string[] => {
  const visit = (path: string): string[] =>
    readdirSync(path, { withFileTypes: true }).flatMap(entry => {
      const child = join(path, entry.name);
      if (entry.isDirectory()) return visit(child);
      return entry.isFile() && /^standalone-deployment.*\.test\.ts$/u.test(entry.name) ? [child] : [];
    });
  const files = visit(directory)
    .sort()
    .sort((left, right) => {
      const a = basename(left),
        b = basename(right);
      return a < b ? -1 : a > b ? 1 : 0;
    });
  if (files.length === 0) throw new Error('DEPLOYMENT_NATIVE_TASK_TESTS_MISSING');
  // Basename order preserves the previous flat runner's sequence after moves.
  return files.map(path => relative(repositoryRoot, path).replaceAll('\\', '/'));
};

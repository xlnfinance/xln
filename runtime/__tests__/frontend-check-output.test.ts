import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { filterViteBuildCheckLine } from '../../frontend/scripts/vite-build-check';

const repoRoot = process.cwd();

describe('frontend check output', () => {
  test('frontend check uses bun and filters npm preview hint only', () => {
    const packageJson = JSON.parse(readFileSync(join(repoRoot, 'frontend/package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const checkScript = packageJson.scripts['check'];
    const svelteConfig = readFileSync(join(repoRoot, 'frontend/svelte.config.js'), 'utf8');
    const rootPageConfig = readFileSync(join(repoRoot, 'frontend/src/routes/+page.ts'), 'utf8');
    const copyStatic = readFileSync(join(repoRoot, 'frontend/copy-static-files.js'), 'utf8');

    expect(checkScript).toContain('bun copy-static-files.js');
    expect(checkScript).toContain('bun scripts/vite-build-check.ts');
    expect(checkScript).not.toContain('node copy-static-files.js');
    expect(checkScript).not.toContain('vite build');
    expect(svelteConfig).toContain("fallback: 'index.html'");
    expect(rootPageConfig).toContain('export const prerender = false;');
    expect(copyStatic).toContain("process.env.XLN_STATIC_VERBOSE === '1'");
    expect(copyStatic).toContain("stdio: llmsVerbose ? 'inherit' : 'pipe'");
    expect(copyStatic).toContain('llms static context regenerated');
  });

  test('vite check wrapper removes the npm preview banner without swallowing build output', () => {
    expect(filterViteBuildCheckLine('Run npm run preview to preview your production build locally.')).toBeNull();
    expect(filterViteBuildCheckLine('built in 15.48s')).toBe('built in 15.48s');
    expect(filterViteBuildCheckLine('error: build failed')).toBe('error: build failed');
  });
});

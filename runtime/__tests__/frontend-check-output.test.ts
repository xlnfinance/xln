import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = process.cwd();

describe('frontend check output', () => {
  test('frontend check type-checks and builds every canonical surface', () => {
    const packageJson = JSON.parse(readFileSync(join(repoRoot, 'frontend/package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const checkScript = packageJson.scripts['check'];
    const viteConfig = readFileSync(join(repoRoot, 'frontend/vite.config.ts'), 'utf8');
    const copyStatic = readFileSync(join(repoRoot, 'frontend/copy-static-files.js'), 'utf8');

    expect(checkScript).toBe('tsc -p tsconfig.json --noEmit && bun run build');
    expect(packageJson.scripts['build']).toBe('bun scripts/build-surfaces.ts');
    expect(viteConfig).toContain('canonicalRoutePlugin(contract)');
    expect(viteConfig).toContain('createWalletBuildPlugin(staticRoot, contract)');
    expect(copyStatic).toContain("process.env.XLN_STATIC_VERBOSE === '1'");
    expect(copyStatic).toContain("stdio: llmsVerbose ? 'inherit' : 'pipe'");
    expect(copyStatic).toContain('llms static context regenerated');
  });

  test('clean checkouts regenerate ignored LLM context and validate bundled contracts', () => {
    const copyStatic = readFileSync(join(repoRoot, 'frontend/copy-static-files.js'), 'utf8');
    const workflow = readFileSync(join(repoRoot, '.github/workflows/build-and-test.yml'), 'utf8');
    expect(copyStatic).not.toContain('LLMS_CONTEXT_STATIC_MISSING');
    expect(copyStatic).toContain('if (!rebuildRequested && llmsContextPresent)');
    expect(copyStatic).toContain('CONTRACT_STATIC_MISSING');
    expect(copyStatic).toContain('CONTRACT_SOURCE_REQUIRED');
    expect(copyStatic).toContain("process.argv.includes('--contracts-only')");
    expect(copyStatic).toContain("process.argv.includes('--require-all-contract-sources')");
    expect(workflow).toContain('bun frontend/copy-static-files.js --contracts-only --require-all-contract-sources');
    expect(workflow).toContain('git diff --exit-code -- frontend/static/contracts');
    expect(workflow).toContain("hashFiles('bun.lock', 'package.json', 'frontend/bun.lock', 'frontend/package.json')");
    expect(workflow).toContain('bun install --frozen-lockfile');
    expect(workflow).toContain('path: ~/.bun/install/cache');
  });

  test('require-all-contract-sources rejects stale bundled artifacts', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'xln-contract-static-'));
    const fixtureFrontend = join(fixture, 'frontend');
    try {
      mkdirSync(join(fixtureFrontend, 'static', 'contracts'), { recursive: true });
      writeFileSync(join(fixtureFrontend, 'copy-static-files.js'), readFileSync(join(repoRoot, 'frontend/copy-static-files.js')));
      writeFileSync(join(fixtureFrontend, 'docs-catalog.js'), readFileSync(join(repoRoot, 'frontend/docs-catalog.js')));
      for (const contract of ['Account', 'Depository', 'EntityProvider', 'HankoVerifier', 'DeltaTransformer', 'ERC20Mock']) {
        writeFileSync(join(fixtureFrontend, 'static', 'contracts', `${contract}.json`), '{}\n');
      }

      const bundled = Bun.spawnSync([process.execPath, join(fixtureFrontend, 'copy-static-files.js'), '--contracts-only'], {
        cwd: fixture,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(bundled.exitCode).toBe(0);

      const strict = Bun.spawnSync([
        process.execPath,
        join(fixtureFrontend, 'copy-static-files.js'),
        '--contracts-only',
        '--require-all-contract-sources',
      ], { cwd: fixture, stdout: 'pipe', stderr: 'pipe' });
      expect(strict.exitCode).not.toBe(0);
      expect(new TextDecoder().decode(strict.stderr)).toContain('CONTRACT_SOURCE_REQUIRED');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

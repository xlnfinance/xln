import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPOSITORY_ROOT = resolve(import.meta.dir, '../..');
const DEPLOY_SCRIPT = resolve(REPOSITORY_ROOT, 'scripts/deployment/deploy-platform.sh');
const source = (): string => readFileSync(DEPLOY_SCRIPT, 'utf8');

describe('atomic frontend deploy entrypoint', () => {
  test('is valid Bash and rejects remote frontend activation outside production mode', () => {
    const syntax = spawnSync('bash', ['-n', DEPLOY_SCRIPT], { cwd: REPOSITORY_ROOT, encoding: 'utf8' });
    expect(syntax.status).toBe(0);

    const unsafe = spawnSync('bash', [DEPLOY_SCRIPT, '--remote', 'example.invalid', '--frontend'], {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
    });
    expect(unsafe.status).toBe(1);
    expect(unsafe.stderr).toContain('REMOTE_FRONTEND_ATOMIC_ACTIVATION_REQUIRES_PRODUCTION');
  });

  test('checksums and validates staging before the atomic production activator', () => {
    const script = source();
    const checksum = script.indexOf('FRONTEND_RELEASE_ARCHIVE_HASH_MISMATCH');
    const validate = script.indexOf('frontend-release-cli.ts validate');
    const promote = script.indexOf('mv \\\"\\$STAGED_RELEASE\\\" \\\"\\$FINAL_RELEASE\\\"');
    const activate = script.indexOf('activate-frontend-release-production.ts');

    expect(checksum).toBeGreaterThan(0);
    expect(validate).toBeGreaterThan(checksum);
    expect(promote).toBeGreaterThan(validate);
    expect(activate).toBeGreaterThan(promote);
    expect(script).toContain('test -s frontend/current/release-manifest.json');
  });

  test('contains no in-place frontend replacement path', () => {
    const script = source();
    expect(script).not.toMatch(/rm -rf\s+(?:--\s+)?["']?frontend\/build/);
    expect(script).not.toMatch(/tar\s+[^\n]*-C\s+["']?frontend(?:\/build)?["']?/);
    expect(script).not.toContain('root /root/xln/frontend/build;');
  });
});

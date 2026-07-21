import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  buildManagedRuntimeChildSecretEnv,
  childSecretFdEnv,
  parseChildSecretPayload,
  writeInheritedChildSecrets,
} from '../orchestrator/child-secrets';
import { spawnBunChild } from '../orchestrator/custody-bootstrap';

const readStream = async (stream: NodeJS.ReadableStream): Promise<string> => {
  let value = '';
  for await (const chunk of stream) value += String(chunk);
  return value;
};

describe('orchestrator child secret channel', () => {
  test('passes secrets through inherited FD without exposing them in argv', async () => {
    const secret = 'fd-only-runtime-seed alpha beta gamma';
    const code = [
      "import { readInheritedChildSecrets } from './runtime/orchestrator/child-secrets.ts';",
      "process.stdout.write(JSON.stringify({ secrets: readInheritedChildSecrets(), argv: process.argv }));",
    ].join('');
    const child = spawn(process.execPath, ['-e', code], {
      cwd: process.cwd(),
      env: { ...process.env, ...childSecretFdEnv() },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdoutPromise = readStream(child.stdout);
    const stderrPromise = readStream(child.stderr);
    await writeInheritedChildSecrets(child, { runtimeSeed: secret });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    const stdout = await stdoutPromise;
    const stderr = await stderrPromise;

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    const result = JSON.parse(stdout) as { secrets: Record<string, string>; argv: string[] };
    expect(result.secrets).toEqual({ runtimeSeed: secret });
    expect(result.argv.join(' ')).not.toContain(secret);
  });

  test('managed runtime FD is the sole seed source even when the parent has a different seed', async () => {
    const parentSeed = 'parent-operator-runtime-seed';
    const childSeed = 'derived-h1-runtime-seed';
    const childAuthSeed = 'derived-h1-radapter-auth-seed-32-bytes';
    const code = [
      "import { readInheritedChildSecrets, resolveChildSecret } from './runtime/orchestrator/child-secrets.ts';",
      "import { registerRuntimeAdapterAuthSeed, resolveRuntimeAdapterAuthSeed } from './runtime/radapter/auth.ts';",
      'const secrets = readInheritedChildSecrets();',
      "const seed = resolveChildSecret(secrets, 'runtimeSeed', process.env['XLN_RUNTIME_SEED'] || '');",
      "const radapterAuthSeed = resolveChildSecret(secrets, 'radapterAuthSeed', process.env['XLN_RADAPTER_AUTH_SEED'] || '');",
      'registerRuntimeAdapterAuthSeed(radapterAuthSeed);',
      "delete process.env['XLN_RADAPTER_AUTH_SEED'];",
      "process.stdout.write(JSON.stringify({ seed, authSeedMatches: resolveRuntimeAdapterAuthSeed(null) === radapterAuthSeed, keep: process.env['KEEP_FOR_CHILD'] || '', root: process.env['XLN_MESH_ROOT_SEED'] || '', custody: process.env['CUSTODY_SEED'] || '', daemon: process.env['CUSTODY_DAEMON_RUNTIME_SEED'] || '', auth: process.env['CUSTODY_DAEMON_AUTH_SEED'] || '', radapter: process.env['XLN_RADAPTER_AUTH_SEED'] || '' }));",
    ].join('');
    const child = spawn(process.execPath, ['-e', code], {
      cwd: process.cwd(),
      env: buildManagedRuntimeChildSecretEnv({
        ...process.env,
        KEEP_FOR_CHILD: 'kept',
        XLN_RUNTIME_SEED: parentSeed,
        XLN_MESH_ROOT_SEED: 'parent-mesh-root-seed',
        XLN_MESH_RUNTIME_SEEDS_JSON: JSON.stringify({ H1: childSeed }),
        XLN_MESH_RADAPTER_AUTH_SEEDS_JSON: JSON.stringify({ H1: 'h1-auth-seed' }),
        CUSTODY_SEED: 'parent-custody-seed',
        CUSTODY_DAEMON_RUNTIME_SEED: 'parent-daemon-runtime-seed',
        CUSTODY_DAEMON_AUTH_SEED: 'parent-daemon-auth-seed',
        XLN_RADAPTER_AUTH_SEED: 'parent-radapter-auth-seed',
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdoutPromise = readStream(child.stdout);
    const stderrPromise = readStream(child.stderr);
    await writeInheritedChildSecrets(child, {
      runtimeSeed: childSeed,
      radapterAuthSeed: childAuthSeed,
    });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    const stdout = await stdoutPromise;
    const stderr = await stderrPromise;

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toEqual({
      seed: childSeed,
      authSeedMatches: true,
      keep: 'kept',
      root: '',
      custody: '',
      daemon: '',
      auth: '',
      radapter: '',
    });
  });

  test('managed child secret handshake fails with the child spawn error', async () => {
    const child = spawnBunChild(
      'missing-bun-child',
      ['-e', 'process.exit(0)'],
      { PATH: '' },
      { runtimeSeed: 'spawn-failure-secret' },
    );
    await expect(child.startupSecretsWritten).rejects.toThrow('CHILD_SECRET_CHILD_SPAWN_FAILED');
  });

  test('managed custody child reliably receives the exact startup signer through the FD', async () => {
    const code = [
      "import { readInheritedChildSecrets } from './runtime/orchestrator/child-secrets.ts';",
      'process.stdout.write(JSON.stringify(readInheritedChildSecrets()));',
    ].join('');
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const child = spawnBunChild(`startup-signer-test-${attempt}`, ['-e', code], {}, {
        startupSignerSeed: 'custody-startup-seed',
        startupSignerLabel: 'custody-startup-label',
      });
      await child.startupSecretsWritten;
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.proc.once('error', reject);
        child.proc.once('close', resolve);
      });

      expect(exitCode).toBe(0);
      expect(JSON.parse(child.stdoutLines.join(''))).toEqual({
        startupSignerSeed: 'custody-startup-seed',
        startupSignerLabel: 'custody-startup-label',
      });
    }
  });

  test('rejects malformed or empty inherited payloads', () => {
    expect(() => parseChildSecretPayload('')).toThrow('CHILD_SECRET_PAYLOAD_SIZE_INVALID');
    expect(() => parseChildSecretPayload('[]')).toThrow('CHILD_SECRET_PAYLOAD_OBJECT_REQUIRED');
    expect(() => parseChildSecretPayload('{"runtimeSeed":""}')).toThrow(
      'CHILD_SECRET_PAYLOAD_ENTRY_INVALID:runtimeSeed',
    );
  });

  test('managed hub, market maker, and custody argv contain no secrets', () => {
    const root = process.cwd();
    const orchestrator = readFileSync(join(root, 'runtime/orchestrator/orchestrator.ts'), 'utf8');
    const custody = readFileSync(join(root, 'runtime/orchestrator/custody-bootstrap.ts'), 'utf8');

    expect(orchestrator).not.toContain("'--seed', child.seed");
    expect(orchestrator).not.toContain("'--seed', marketMakerChild.seed");
    expect(orchestrator.match(/buildManagedRuntimeChildSecretEnv\(process\.env\)/g)).toHaveLength(2);
    expect(orchestrator).not.toContain('...childSecretFdEnv(),');
    expect(custody.match(/buildManagedRuntimeChildSecretEnv\(process\.env, false\)/g)).toHaveLength(2);
    expect(custody).not.toContain("'--seed', options.seed");
    expect(custody).not.toContain("'--auth-key', daemonAuthKey");
  });
});

import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  childSecretFdEnv,
  parseChildSecretPayload,
  writeInheritedChildSecrets,
} from '../orchestrator/child-secrets';

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
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
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
    expect(custody).not.toContain("'--seed', options.seed");
    expect(custody).not.toContain("'--auth-key', daemonAuthKey");
  });
});

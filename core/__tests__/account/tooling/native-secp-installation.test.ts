import { expect, test } from 'bun:test';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeStringify } from '../../../protocol/serialization';

test('a missing server secp256k1 installation fails before signature-data rejection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xln-native-secp-'));
  try {
    const entry = join(directory, 'crypto.js');
    const built = Bun.spawnSync({
      cmd: [
        process.execPath,
        'build',
        join(import.meta.dir, '../../../account/crypto.ts'),
        '--target=bun',
        '--external',
        'secp256k1',
        '--outfile',
        entry,
      ],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(built.exitCode).toBe(0);
    // This is a real isolated installation without the required native
    // package. No loader stub or malformed-signature fake supplies the error.
    const child = Bun.spawnSync({
      cmd: [
        process.execPath,
        '--no-install',
        '--eval',
        `import { recoverAddressFromDigestSignature } from ${safeStringify(entry)};
        recoverAddressFromDigestSignature(new Uint8Array(32), new Uint8Array(64), 0);`,
      ],
      cwd: directory,
      env: { ...process.env, NODE_PATH: '' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(child.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(child.stderr)).toContain('secp256k1');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Node ESM signs and recovers through the installed native server backend', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xln-native-esm-'));
  try {
    const entry = join(directory, 'crypto.mjs');
    const built = Bun.spawnSync({
      cmd: [
        process.execPath,
        'build',
        join(import.meta.dir, '../../../account/crypto.ts'),
        '--target=node',
        '--external',
        'secp256k1',
        '--outfile',
        entry,
      ],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(built.exitCode).toBe(0);
    // Use the real installation, not a loader replacement. ESM deliberately
    // provides no global require; missing native packages must still fail.
    await symlink(join(import.meta.dir, '../../../../node_modules'), join(directory, 'node_modules'));
    const child = Bun.spawnSync({
      cmd: [
        'node',
        '--input-type=module',
        '--eval',
        `
        import { signDigestBytesWithPrivateKey, recoverAddressFromDigestSignature } from ${safeStringify(entry)};
        const key = new Uint8Array(32); key[31] = 1;
        const digest = new Uint8Array(32);
        const { signature, recovery } = signDigestBytesWithPrivateKey(key, digest);
        const address = recoverAddressFromDigestSignature(digest, signature, recovery);
        if (address !== '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf') throw new Error('NATIVE_ESM_RECOVERY_MISMATCH:' + address);
        console.log('NATIVE_ESM_OK');
      `,
      ],
      cwd: directory,
      env: { ...process.env, NODE_PATH: '' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(child.stderr.toString()).toBe('');
    expect(child.exitCode).toBe(0);
    expect(child.stdout.toString()).toContain('NATIVE_ESM_OK');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

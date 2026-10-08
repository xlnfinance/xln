import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Wallet } from 'ethers';
import { safeStringify } from '../../core/protocol/serialization';
import { BRAINVAULT_V1_SPEC_ID } from '../../brainvault/src/core/primitives/spec';

const run = async (command: unknown) => {
  const child = Bun.spawn([process.execPath, 'core/api/server/ownership/brainvault-native-worker.ts'], {
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  });
  child.stdin.write(safeStringify(command));
  child.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(stderr === '').toBe(true);
  return { exitCode, rows: stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) };
};

test('private custody worker derives real V1, durably persists and reloads the same external signer', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'xln-native-custody-'));
  const path = join(directory, 'owner.json');
  try {
    const absent = await run({ op: 'load', path });
    expect(absent.exitCode).toBe(0);
    expect(absent.rows).toEqual([{ type: 'absent' }]);
    const derived = await run({ op: 'derive', path, input: {
      specId: BRAINVAULT_V1_SPEC_ID, name: 'alice', passphrase: 'secret123456', shardInput: 1, workers: 1,
    } });
    expect(derived.exitCode).toBe(0);
    expect(derived.rows.filter(row => row.type === 'progress').length).toBe(1);
    const ready = derived.rows.find(row => row.type === 'custody-ready');
    expect(Boolean(ready)).toBe(true);
    expect(ready.signerId).toBe('0x93bab14ed871462d414a7c0357bf1a76de741397');
    expect(new Wallet(ready.privateKey).address.toLowerCase() === ready.signerId).toBe(true);
    expect(/^0x[0-9a-f]{128}$/.test(ready.entitySeed)).toBe(true);
    expect(Object.keys(ready.publicDerivation).sort()).toEqual([
      'backend', 'derivationTimeMs', 'ethereumAddress', 'factor', 'shardCount', 'specId', 'workers',
    ]);
    expect('mnemonic24' in ready).toBe(false);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const restored = await run({ op: 'load', path });
    expect(restored.exitCode).toBe(0);
    const recovered = restored.rows.find(row => row.type === 'custody-ready');
    expect(Boolean(recovered)).toBe(true);
    expect(recovered.signerId === ready.signerId && recovered.privateKey === ready.privateKey
      && recovered.entitySeed === ready.entitySeed).toBe(true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 60_000);

test('private custody worker fails closed on invalid spec without persisting an owner', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'xln-native-custody-reject-'));
  const path = join(directory, 'owner.json');
  try {
    const result = await run({ op: 'derive', path, input: {
      specId: 'not-canonical', name: 'alice', passphrase: 'do-not-echo-this', shardInput: 1, workers: 1,
    } });
    expect(result.exitCode).toBe(1);
    expect(result.rows).toEqual([{ type: 'failed', code: 'BRAINVAULT_SPEC_MISMATCH' }]);
    expect(await Bun.file(path).exists()).toBe(false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test('private custody worker rejects malformed IPC before derivation or owner persistence', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'xln-native-custody-malformed-'));
  const path = join(directory, 'owner.json');
  const input = { specId: BRAINVAULT_V1_SPEC_ID, name: 'alice', passphrase: 'never-echo-this-secret', shardInput: 1, workers: 1 };
  const commands: unknown[] = [
    null, [], { op: 'unknown', path }, { op: 'load', path: 12 },
    { op: 'load', path, input }, { op: 'derive', path },
    { op: 'derive', path, input: [] }, { op: 'derive', path, input: { ...input, extra: true } },
    { op: 'derive', path, input: { ...input, name: 12 } },
    { op: 'derive', path, input: { ...input, passphrase: '' } },
    { op: 'derive', path, input: { ...input, workers: 257 } },
    { op: 'derive', path, input: { ...input, shardInput: 1.5 } },
  ];
  try {
    for (const command of commands) {
      const result = await run(command);
      expect(result.exitCode).toBe(1);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].type).toBe('failed');
      expect(result.rows[0].code).toMatch(/^BRAINVAULT_[A-Z_]+$/);
      expect(safeStringify(result.rows)).not.toContain(input.passphrase);
      expect(await Bun.file(path).exists()).toBe(false);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

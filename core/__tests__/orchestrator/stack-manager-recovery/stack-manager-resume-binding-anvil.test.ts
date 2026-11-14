import { safeStringify } from '../../../protocol/serialization';
import { expect, test } from 'bun:test';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startResumeNode, until } from './stack-manager-resume-support';

test('resume rejects mismatched bindings and absent native evidence before spending', async () => {
  const fixture = await startResumeNode(4);
  let child = fixture.start('new', 'interrupted');
  const identityPath = join(fixture.directory, 'resume-usdc/manifest.json.execution.json');
  const journal = join(fixture.directory, 'resume-usdc/journal.jsonl');
  try {
    await until(async () => fixture.killed() || child.exitCode !== null, 'binding-cut');
    expect(await child.exited).not.toBe(0);
    const nonce = await fixture.provider.send('eth_getTransactionCount', [fixture.signer.address, 'latest']);
    const original = await readFile(identityPath, 'utf8');
    const cases = [
      {
        name: 'policy',
        request: { ...fixture.request, confirmations: 13 },
        code: 'STACK_MANAGER_EXECUTION_IDENTITY_MISMATCH',
      },
      {
        name: 'foundation',
        request: { ...fixture.request, foundationRecipient: '0x1111111111111111111111111111111111111111' },
        code: 'FOUNDATION_LISTING_SIGNER_MISMATCH',
      },
      {
        name: 'signer',
        request: { ...fixture.request, signerId: '0x1111111111111111111111111111111111111111' },
        code: 'SIGNER_KEY_MISMATCH',
      },
      { name: 'chain', request: { ...fixture.request, expectedChainId: 31338 }, code: 'HHE708' },
      {
        name: 'asset',
        request: { ...fixture.request, stablecoin: { kind: 'existing', address: fixture.signer.address } },
        code: 'DEPLOYMENT_TOKEN_CODE_MISSING',
      },
    ];
    for (const item of cases) {
      await writeFile(fixture.config, safeStringify(item.request));
      child = fixture.start('resume', item.name);
      expect(await child.exited).toBe(1);
      expect(await fixture.read(`${item.name}.log`)).toContain(item.code);
      expect(await fixture.provider.send('eth_getTransactionCount', [fixture.signer.address, 'latest'])).toBe(nonce);
    }
    await writeFile(fixture.config, safeStringify(fixture.request));
    for (const [name, change, code] of [
      ['unexpected-field', { abandoned: true }, 'STACK_MANAGER_EXECUTION_IDENTITY_MISMATCH'],
      ['obsolete', { schemaVersion: 0 }, 'STACK_MANAGER_DEPLOYMENT_IDENTITY_INVALID'],
      ['candidate', { sources: {} }, 'STACK_MANAGER_EXECUTION_IDENTITY_MISMATCH'],
    ] as const) {
      await writeFile(identityPath, safeStringify({ ...JSON.parse(original), ...change }));
      child = fixture.start('resume', name);
      expect(await child.exited).toBe(1);
      expect(await fixture.read(`${name}.log`)).toContain(code);
      expect(await fixture.provider.send('eth_getTransactionCount', [fixture.signer.address, 'latest'])).toBe(nonce);
    }
    await rename(identityPath, `${identityPath}.preserved`);
    child = fixture.start('resume', 'missing-identity');
    expect(await child.exited).toBe(1);
    expect(await fixture.read('missing-identity.log')).toContain('DEPLOYMENT_IDENTITY_INVALID');
    await rename(`${identityPath}.preserved`, identityPath);
    await writeFile(identityPath, original);
    await rename(journal, `${journal}.preserved`);
    child = fixture.start('resume', 'missing-journal');
    expect(await child.exited).toBe(1);
    expect(await fixture.read('missing-journal.log')).toContain('ENOENT');
    await rename(`${journal}.preserved`, journal);
    expect(await fixture.provider.send('eth_getTransactionCount', [fixture.signer.address, 'latest'])).toBe(nonce);
    expect(await Bun.file(fixture.catalog).exists()).toBeFalse();
    // Explicitly changing only transport is safe after live chain and sealed identity validation.
    await writeFile(fixture.config, safeStringify({ ...fixture.request, rpcUrl: fixture.directRpcUrl }));
    child = fixture.start('resume', 'valid-new-transport');
    await until(
      async () =>
        child.exitCode !== null ||
        (await fixture.read('valid-new-transport.log')).includes('STACK_MANAGER_PHASE:verifying'),
      'binding-valid-resume',
    );
    await fixture.provider.send('anvil_mine', ['0xb']);
    expect(await child.exited).toBe(0);
    expect(
      Number(BigInt(await fixture.provider.send('eth_getTransactionCount', [fixture.signer.address, 'latest']))),
    ).toBe(fixture.initialNonce + 11);
    console.log(`IGNITION_BINDING_EVIDENCE:${fixture.directory}`);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await child.exited;
    }
    await fixture.close();
  }
}, 180_000);

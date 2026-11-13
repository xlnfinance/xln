import { expect, test } from 'bun:test';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startStandaloneNode, assertVariantLaneLocked } from './standalone-deployment-support';
import { until } from '../stack-manager-recovery/stack-manager-resume-support';
import { safeStringify } from '../../../protocol/serialization';

const assertNoCredential = async (directory: string, secret: string): Promise<void> => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await assertNoCredential(path, secret);
    else expect(await readFile(path, 'utf8')).not.toContain(secret);
  }
};

test('native task verifies eleven existing-USDC operations at depth twelve and reports exact fees without a catalog', async () => {
  const fixture = await startStandaloneNode(0);
  const catalogSentinel = 'This deliberately invalid catalog must never be read by deployment.';
  await writeFile(fixture.catalog, catalogSentinel);
  const rpcCredential = 'fixture_private_rpc_9327';
  const privateRpc = `${fixture.request.rpcUrl}/${rpcCredential}?api_key=${rpcCredential}`;
  let child = fixture.start('new', 'native-fresh', privateRpc);
  try {
    const balance = await fixture.provider.getBalance(fixture.signer.address);
    await until(async () => child.exitCode !== null || (await fixture.read('native-fresh.log')).includes('XLN_DEPLOY_PHASE:verifying'), 'native-verifying');
    if (child.exitCode !== null) throw new Error(await fixture.read('native-fresh.log'));
    const sendsBeforeCompetitor = fixture.submissions();
    await assertVariantLaneLocked(fixture);
    expect(fixture.submissions()).toBe(sendsBeforeCompetitor);
    await fixture.provider.send('anvil_mine', ['0xa']);
    await Bun.sleep(500);
    expect(child.exitCode).toBeNull();
    expect(JSON.parse(await readFile(join(fixture.nativeDirectory, 'result.json'), 'utf8')).status).toBe('running');
    await fixture.provider.send('anvil_mine', ['0x1']);
    expect(await child.exited).toBe(0);
    const result = JSON.parse(await readFile(join(fixture.nativeDirectory, 'result.json'), 'utf8'));
    expect(result.status).toBe('complete');
    expect(result.expenses.broadcasts).toBe(11);
    expect(result.expenses.mined).toBe(11);
    expect(result.manifest.registeredTokens.USDC).toEqual({ address: fixture.request.stablecoin.address, tokenId: 1, decimals: 6 });
    expect(balance - await fixture.provider.getBalance(fixture.signer.address)).toBe(BigInt(result.expenses.attemptTransactionFeesWei));
    expect(await readFile(fixture.catalog, 'utf8')).toBe(catalogSentinel);
    expect(await fixture.read('native-fresh.log')).not.toContain(rpcCredential);
    expect(await fixture.read('native-fresh.json')).not.toContain(rpcCredential);
    await assertNoCredential(fixture.nativeDirectory, rpcCredential);
    const journal = await readFile(join(fixture.nativeDirectory, 'journal.jsonl'), 'utf8');
    expect(journal).toContain('#registerStablecoin');
    const nonce = await fixture.provider.send('eth_getTransactionCount', [fixture.signer.address, 'latest']);
    const sends = fixture.submissions();
    const identityPath = join(fixture.nativeDirectory, 'manifest.json.execution.json');
    const identityBytes = await readFile(identityPath, 'utf8');
    const changed = JSON.parse(identityBytes);
    expect(changed.sources['core/hanko/codec.ts']).toMatch(/^[0-9a-f]{64}$/);
    changed.sources['core/hanko/codec.ts'] = '0'.repeat(64);
    try {
      await writeFile(identityPath, safeStringify(changed));
      child = fixture.start('resume', 'changed-hanko-source');
      expect(await child.exited).not.toBe(0);
      expect(await fixture.read('changed-hanko-source.log')).toContain('STACK_MANAGER_EXECUTION_IDENTITY_MISMATCH');
      expect(fixture.submissions()).toBe(sends);
    } finally { await writeFile(identityPath, identityBytes); }
    await rm(join(fixture.nativeDirectory, 'manifest.json'));
    child = fixture.start('resume', 'native-resume');
    expect(await child.exited).toBe(0);
    const resumed = JSON.parse(await readFile(join(fixture.nativeDirectory, 'result.json'), 'utf8'));
    expect(resumed.manifest).toEqual(result.manifest);
    expect(resumed.expenses).toEqual(result.expenses);
    expect(fixture.submissions()).toBe(sends);
    expect(await fixture.provider.send('eth_getTransactionCount', [fixture.signer.address, 'latest'])).toBe(nonce);
    expect(await readFile(fixture.catalog, 'utf8')).toBe(catalogSentinel);
    console.log(`STANDALONE_FRESH_EVIDENCE:${fixture.nativeDirectory}:operations=11:depth=12`);
  } finally {
    if (child.exitCode === null) { child.kill('SIGTERM'); await child.exited; }
    await fixture.close();
  }
}, 180_000);

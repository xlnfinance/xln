import { safeStringify } from '../../../protocol/serialization';
import { expect, test } from 'bun:test';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startResumeNode, until } from './stack-manager-resume-support';
import { computeJurisdictionGossipHash } from '../../../jurisdiction/gossip/announcement';

type Fixture = Awaited<ReturnType<typeof startResumeNode>>;
const finish = async (fixture: Fixture, child: ReturnType<Fixture['start']>, name: string) => {
  await until(
    async () =>
      child.exitCode !== null || (await fixture.read(`${name}.log`)).includes('STACK_MANAGER_PHASE:verifying'),
    name,
  );
  await fixture.provider.send('anvil_mine', ['0xb']);
  expect(await child.exited).toBe(0);
  return JSON.parse(await fixture.read(`${name}.json`));
};

test('resume ignores only diagnostic dirty changes while rejecting a changed source hash before spending', async () => {
  const fixture = await startResumeNode(4);
  let child = fixture.start('new', 'interrupted');
  try {
    await until(async () => fixture.killed() || child.exitCode !== null, 'dirty-cut');
    expect(await child.exited).not.toBe(0);
    const identityPath = join(fixture.directory, 'resume-usdc/manifest.json.execution.json');
    const original = await readFile(identityPath, 'utf8');
    const identity = JSON.parse(original);
    const nonce = await fixture.provider.send('eth_getTransactionCount', [fixture.signer.address, 'latest']);
    await writeFile(
      identityPath,
      safeStringify({
        ...identity,
        sources: { ...identity.sources, 'jurisdictions/scripts/deploy-stack.cjs': '0'.repeat(64) },
      }),
    );
    child = fixture.start('resume', 'wrong-source');
    expect(await child.exited).toBe(1);
    expect(await fixture.read('wrong-source.log')).toContain('STACK_MANAGER_EXECUTION_IDENTITY_MISMATCH');
    expect(await fixture.provider.send('eth_getTransactionCount', [fixture.signer.address, 'latest'])).toBe(nonce);
    await writeFile(identityPath, original);
    const resultPath = join(fixture.directory, 'resume-usdc/result.json');
    const diagnostic = JSON.parse(await readFile(resultPath, 'utf8'));
    await writeFile(
      resultPath,
      safeStringify({ ...diagnostic, candidate: { ...diagnostic.candidate, dirty: !diagnostic.candidate.dirty } }),
    );
    child = fixture.start('resume', 'dirty-only');
    await finish(fixture, child, 'dirty-only');
    expect(
      Number(BigInt(await fixture.provider.send('eth_getTransactionCount', [fixture.signer.address, 'latest']))),
    ).toBe(fixture.initialNonce + 11);
    expect(await readFile(identityPath, 'utf8')).toBe(original);
    console.log(`IGNITION_DIRTY_DIAGNOSTIC_EVIDENCE:${fixture.directory}`);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await child.exited;
    }
    await fixture.close();
  }
}, 60_000);

for (const publication of ['local', 'community']) {
  test(`${publication} completed resume changes transport without changing advertised RPC or publication`, async () => {
    const fixture = await startResumeNode(0);
    let child = fixture.startApi(
      'new',
      'initial',
      publication === 'community' ? 'catalog-published' : undefined,
      publication,
    );
    try {
      await until(
        async () =>
          child.exitCode !== null || (await fixture.read('initial.log')).includes('STACK_MANAGER_PHASE:verifying'),
        'published-transport',
      );
      await fixture.provider.send('anvil_mine', ['0xb']);
      expect(await child.exited).toBe(publication === 'community' ? 137 : 0);
      const original = await fixture.read('jurisdictions.json');
      const catalog = JSON.parse(original);
      const nonce = await fixture.provider.send('eth_getTransactionCount', [fixture.signer.address, 'latest']);
      child = fixture.startApi('resume', 'new-transport', undefined, publication, { rpcUrl: fixture.directRpcUrl });
      expect(await child.exited).toBe(0);
      expect(await fixture.read('jurisdictions.json')).toBe(original);
      expect(JSON.parse(original).jurisdictions['resume-usdc'].rpc).toBe(fixture.request.rpcUrl);
      expect(await fixture.provider.send('eth_getTransactionCount', [fixture.signer.address, 'latest'])).toBe(nonce);
      expect(await fixture.read('new-transport.log')).not.toContain('STACK_MANAGER_PUBLISH_CALLBACK');
      const result = JSON.parse(await fixture.read('new-transport.json'));
      if (publication === 'community') {
        expect(catalog.jurisdictionAnnouncements).toHaveLength(1);
        expect(computeJurisdictionGossipHash(result.publication.announcement)).toBe(
          computeJurisdictionGossipHash(catalog.jurisdictionAnnouncements[0]),
        );
        expect(result.publication.status).toBe('queued');
      }
      console.log(`IGNITION_PUBLISHED_TRANSPORT_EVIDENCE:${publication}:${fixture.directory}`);
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await child.exited;
      }
      await fixture.close();
    }
  }, 60_000);
}

test('completed resume reconstructs a missing manifest with zero native balance and zero sends', async () => {
  const fixture = await startResumeNode(0);
  let child = fixture.start('new', 'fresh');
  try {
    const result = await finish(fixture, child, 'fresh');
    const submissions = fixture.submissions();
    expect(submissions).toBe(11);
    const nonce = await fixture.provider.send('eth_getTransactionCount', [fixture.signer.address, 'latest']);
    const catalog = await fixture.read('jurisdictions.json');
    await fixture.provider.send('anvil_setBalance', [fixture.signer.address, '0x0']);
    await rm(join(fixture.directory, 'resume-usdc/manifest.json'));
    await rm(join(fixture.directory, 'resume-usdc/result.json'));
    child = fixture.start('resume', 'empty-completed');
    expect(await child.exited).toBe(0);
    expect(JSON.parse(await fixture.read('empty-completed.json'))).toEqual(result);
    expect(fixture.submissions()).toBe(submissions);
    expect(await fixture.read('jurisdictions.json')).toBe(catalog);
    expect(await fixture.provider.send('eth_getBalance', [fixture.signer.address, 'latest'])).toBe('0x0');
    expect(await fixture.provider.send('eth_getTransactionCount', [fixture.signer.address, 'latest'])).toBe(nonce);
    console.log(`IGNITION_EMPTY_COMPLETED_EVIDENCE:${fixture.directory}`);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await child.exited;
    }
    await fixture.close();
  }
}, 60_000);

for (const cut of [0, 4]) {
  test(`${cut === 0 ? 'fresh' : 'incomplete'} deployment rejects an empty native balance before sending`, async () => {
    const fixture = await startResumeNode(cut);
    let child: ReturnType<Fixture['start']> | undefined;
    try {
      if (cut) {
        child = fixture.start('new', 'interrupted');
        await until(async () => fixture.killed() || child!.exitCode !== null, 'empty-partial-cut');
        expect(await child.exited).not.toBe(0);
      }
      const nonce = await fixture.provider.send('eth_getTransactionCount', [fixture.signer.address, 'latest']);
      const submissions = fixture.submissions();
      await fixture.provider.send('anvil_setBalance', [fixture.signer.address, '0x0']);
      child = fixture.start(cut ? 'resume' : 'new', 'empty');
      expect(await child.exited).toBe(1);
      expect(await fixture.read('empty.log')).toContain('STACK_MANAGER_SIGNER_GAS_BALANCE_EMPTY');
      expect(fixture.submissions()).toBe(submissions);
      expect(await fixture.provider.send('eth_getTransactionCount', [fixture.signer.address, 'latest'])).toBe(nonce);
      expect(await Bun.file(fixture.catalog).exists()).toBeFalse();
      console.log(`IGNITION_EMPTY_PREFLIGHT_EVIDENCE:${cut}:${fixture.directory}`);
    } finally {
      if (child?.exitCode === null) {
        child.kill('SIGTERM');
        await child.exited;
      }
      await fixture.close();
    }
  }, 60_000);
}

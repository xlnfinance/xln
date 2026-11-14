import { safeStringify } from '../../../protocol/serialization';
import { expect, test } from 'bun:test';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startResumeNode, until } from './stack-manager-resume-support';

type Fixture = Awaited<ReturnType<typeof startResumeNode>>;
type Caller = ReturnType<Fixture['start'] | Fixture['startApi']>;

for (const caller of ['cli', 'api']) {
  test(`${caller} local completed resume rejects only a changed advertised RPC without sends or catalog overwrite`, async () => {
    const fixture = await startResumeNode(0);
    let child: Caller = fixture.start('new', 'fresh');
    try {
      await until(
        async () =>
          child.exitCode !== null || (await fixture.read('fresh.log')).includes('STACK_MANAGER_PHASE:verifying'),
        'rpc-conflict-fresh',
      );
      await fixture.provider.send('anvil_mine', ['0xb']);
      expect(await child.exited).toBe(0);
      expect(fixture.submissions()).toBe(11);
      const catalog = JSON.parse(await fixture.read('jurisdictions.json'));
      catalog.jurisdictions['resume-usdc'].rpc = 'http://127.0.0.1:1';
      const changed = safeStringify(catalog);
      await writeFile(fixture.catalog, changed);
      const nonce = await fixture.provider.send('eth_getTransactionCount', [fixture.signer.address, 'latest']);
      console.log(`IGNITION_LOCAL_RPC_CONFLICT_EVIDENCE:${caller}:${fixture.directory}`);
      child = caller === 'cli' ? fixture.start('resume', 'rpc-conflict') : fixture.startApi('resume', 'rpc-conflict');
      expect(await child.exited).toBe(1);
      expect(await fixture.read('rpc-conflict.log')).toContain('STACK_MANAGER_JURISDICTION_KEY_CONFLICT');
      expect(fixture.submissions()).toBe(11);
      expect(await fixture.provider.send('eth_getTransactionCount', [fixture.signer.address, 'latest'])).toBe(nonce);
      expect(await fixture.read('jurisdictions.json')).toBe(changed);
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await child.exited;
      }
      await fixture.close();
    }
  }, 60_000);
}

test('local publication seal restores its advertised RPC with new transport and no catalog or result', async () => {
  const fixture = await startResumeNode(0);
  let child: Caller = fixture.start('new', 'fresh');
  try {
    await until(
      async () =>
        child.exitCode !== null || (await fixture.read('fresh.log')).includes('STACK_MANAGER_PHASE:verifying'),
      'publication-window',
    );
    await fixture.provider.send('anvil_mine', ['0xb']);
    expect(await child.exited).toBe(0);
    expect(fixture.submissions()).toBe(11);
    const original = JSON.parse(await fixture.read('jurisdictions.json'));
    const sealPath = join(fixture.directory, 'resume-usdc/publication.json');
    const seal = await readFile(sealPath, 'utf8');
    await rename(fixture.catalog, `${fixture.catalog}.preserved`);
    await rename(
      join(fixture.directory, 'resume-usdc/result.json'),
      join(fixture.directory, 'resume-usdc/result.json.preserved'),
    );
    const rpcUrl = `${fixture.request.rpcUrl}/changed-transport`;
    child = fixture.startApi('resume', 'sealed-window', undefined, 'local', { rpcUrl });
    expect(await child.exited).toBe(0);
    expect(fixture.submissions()).toBe(11);
    const actual = JSON.parse(await fixture.read('jurisdictions.json'));
    expect(actual.jurisdictions['resume-usdc']).toEqual(original.jurisdictions['resume-usdc']);
    expect(actual.jurisdictions['resume-usdc'].rpc).toBe(fixture.request.rpcUrl);
    expect(await readFile(sealPath, 'utf8')).toBe(seal);
    expect(await fixture.read('sealed-window.log')).not.toContain('STACK_MANAGER_PUBLISH_CALLBACK');
    console.log(`IGNITION_PUBLICATION_WINDOW_EVIDENCE:${fixture.directory}`);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await child.exited;
    }
    await fixture.close();
  }
}, 60_000);

test('completed admission binds its catalog path and rejects publication escalation without spending', async () => {
  const fixture = await startResumeNode(0);
  let child: Caller = fixture.start('new', 'fresh');
  try {
    await until(
      async () =>
        child.exitCode !== null || (await fixture.read('fresh.log')).includes('STACK_MANAGER_PHASE:verifying'),
      'sealed-admission',
    );
    await fixture.provider.send('anvil_mine', ['0xb']);
    expect(await child.exited).toBe(0);
    const catalog = await fixture.read('jurisdictions.json');
    const publication = await fixture.read('resume-usdc/publication.json');
    const originalResult = await fixture.read('resume-usdc/result.json');
    const archive = join(JSON.parse(originalResult).invocation, 'result.json');
    const nonce = await fixture.provider.send('eth_getTransactionCount', [fixture.signer.address, 'latest']);
    const submissions = fixture.submissions();
    expect(submissions).toBe(11);

    const otherCatalog = join(fixture.directory, 'unbound-catalog.json');
    child = fixture.start('resume', 'other-catalog', 'resume-usdc', otherCatalog);
    expect(await child.exited).toBe(1);
    expect(await fixture.read('other-catalog.log')).toContain('STACK_MANAGER_PUBLICATION_IDENTITY_MISMATCH');
    expect(await Bun.file(otherCatalog).exists()).toBeFalse();

    child = fixture.startApi('resume', 'scope-change', undefined, 'community');
    expect(await child.exited).toBe(1);
    expect(await fixture.read('scope-change.log')).toContain('STACK_MANAGER_JURISDICTION_PUBLICATION_CONFLICT');
    expect(await fixture.read('scope-change.log')).not.toContain('STACK_MANAGER_PUBLISH_CALLBACK');
    expect(fixture.submissions()).toBe(submissions);
    expect(await fixture.provider.send('eth_getTransactionCount', [fixture.signer.address, 'latest'])).toBe(nonce);
    expect(await fixture.read('jurisdictions.json')).toBe(catalog);
    expect(await fixture.read('resume-usdc/publication.json')).toBe(publication);
    expect(await readFile(archive, 'utf8')).toBe(originalResult);
    expect(JSON.parse(await fixture.read('resume-usdc/result.json')).status).toBe('complete');
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await child.exited;
    }
    await fixture.close();
  }
}, 60_000);

import { safeStringify } from '../../../protocol/serialization';
import { expect, test } from 'bun:test';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startResumeNode, until } from './stack-manager-resume-support';

for (const cut of ['hanko-validation', 'listing-prepared'] as const) {
  test(`resumes a native child cut at ${cut} without omitting the listing graph`, async () => {
    const fixture = await startResumeNode(cut, 2);
    let child = fixture.start('new', 'interrupted');
    try {
      await until(async () => fixture.killed() || child.exitCode !== null, cut);
      expect(await child.exited).not.toBe(0);
      expect(fixture.killed()).toBeTrue();
      const nonce = Number(
        BigInt(await fixture.provider.send('eth_getTransactionCount', [fixture.signer.address, 'latest'])),
      );
      expect(nonce).toBe(fixture.initialNonce + 10);
      expect(await Bun.file(join(fixture.directory, 'resume-usdc/manifest.json.listing.json')).exists()).toBe(
        cut === 'listing-prepared',
      );
      expect(await Bun.file(fixture.catalog).exists()).toBeFalse();
      child = fixture.start('resume', 'resumed');
      await until(
        async () =>
          child.exitCode !== null || (await fixture.read('resumed.log')).includes('STACK_MANAGER_PHASE:verifying'),
        'stage-resume',
      );
      await fixture.provider.send('anvil_mine', ['0xb']);
      expect(await child.exited).toBe(0);
      expect(
        Number(BigInt(await fixture.provider.send('eth_getTransactionCount', [fixture.signer.address, 'latest']))),
      ).toBe(fixture.initialNonce + 11);
      console.log(`IGNITION_STAGE_EVIDENCE:${cut}:${fixture.directory}`);
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await child.exited;
      }
      await fixture.close();
    }
  }, 180_000);
}

for (const cut of ['verifying', 'persisting', 'catalog-published'] as const) {
  test(`resumes after the real caller is killed at ${cut}`, async () => {
    const fixture = await startResumeNode(0);
    const publication = cut === 'catalog-published' ? 'community' : 'local';
    let child = fixture.startApi('new', 'interrupted', cut, publication);
    try {
      await until(
        async () =>
          child.exitCode !== null || (await fixture.read('interrupted.log')).includes('STACK_MANAGER_PHASE:verifying'),
        'finalization-cut',
      );
      if (cut !== 'verifying') await fixture.provider.send('anvil_mine', ['0xb']);
      expect(await child.exited).not.toBe(0);
      expect(await fixture.read('interrupted.json')).toBe('');
      expect(await Bun.file(fixture.catalog).exists()).toBe(cut === 'catalog-published');
      const original = JSON.parse(await fixture.read('resume-usdc/result.json'));
      expect(original.status).toBe(cut === 'verifying' ? 'running' : 'complete');
      expect(original.phase).toBe(cut === 'verifying' ? 'verifying' : 'complete');
      if (cut === 'catalog-published') {
        const catalog = JSON.parse(await fixture.read('jurisdictions.json'));
        expect(catalog.jurisdictions['resume-usdc'].contracts.entityProvider).toBeTruthy();
        expect(catalog.jurisdictionAnnouncements).toHaveLength(1);
      }
      const nonce = await fixture.provider.send('eth_getTransactionCount', [fixture.signer.address, 'latest']);
      expect(Number(BigInt(nonce))).toBe(fixture.initialNonce + 11);
      await fixture.provider.send('anvil_mine', ['0xb']);
      child = fixture.startApi('resume', 'resumed', undefined, publication);
      expect(await child.exited).toBe(0);
      expect(await fixture.provider.send('eth_getTransactionCount', [fixture.signer.address, 'latest'])).toBe(nonce);
      if (cut === 'catalog-published')
        expect(await fixture.read('resumed.log')).not.toContain('STACK_MANAGER_PUBLISH_CALLBACK');
      const invocations = await readdir(join(fixture.directory, 'resume-usdc/invocations'));
      const statuses = await Promise.all(
        invocations.map(async id => JSON.parse(await fixture.read(`resume-usdc/invocations/${id}/result.json`)).status),
      );
      expect(statuses.sort()).toEqual(cut === 'verifying' ? ['complete', 'interrupted'] : ['complete', 'complete']);
      console.log(`IGNITION_FINALIZATION_EVIDENCE:${cut}:${fixture.directory}`);
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await child.exited;
      }
      await fixture.close();
    }
  }, 180_000);
}

test('completed resume preserves unrelated entries and rejects a conflicting catalog without spending', async () => {
  const fixture = await startResumeNode(0);
  let child = fixture.start('new', 'fresh');
  try {
    await until(
      async () =>
        child.exitCode !== null || (await fixture.read('fresh.log')).includes('STACK_MANAGER_PHASE:verifying'),
      'catalog-fresh',
    );
    await fixture.provider.send('anvil_mine', ['0xb']);
    expect(await child.exited).toBe(0);
    const catalog = JSON.parse(await fixture.read('jurisdictions.json'));
    catalog.jurisdictions['unrelated'] = { ...catalog.jurisdictions['resume-usdc'], name: 'Unrelated', primary: false };
    await writeFile(fixture.catalog, safeStringify(catalog, 2));
    const original = await readFile(fixture.catalog, 'utf8');
    const nonce = await fixture.provider.send('eth_getTransactionCount', [fixture.signer.address, 'latest']);
    await rm(join(fixture.directory, 'resume-usdc/result.json'));
    child = fixture.start('resume', 'missing-result');
    expect(await child.exited).toBe(0);
    expect(await readFile(fixture.catalog, 'utf8')).toBe(original);
    catalog.jurisdictions['resume-usdc'].name = 'Conflicting owner entry';
    await writeFile(fixture.catalog, safeStringify(catalog, 2));
    const conflicting = await readFile(fixture.catalog, 'utf8');
    child = fixture.start('resume', 'conflict');
    expect(await child.exited).toBe(1);
    expect(await fixture.read('conflict.log')).toContain('STACK_MANAGER_JURISDICTION_KEY_CONFLICT');
    expect(await readFile(fixture.catalog, 'utf8')).toBe(conflicting);
    expect(await fixture.provider.send('eth_getTransactionCount', [fixture.signer.address, 'latest'])).toBe(nonce);
    console.log(`IGNITION_CATALOG_EVIDENCE:${fixture.directory}`);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await child.exited;
    }
    await fixture.close();
  }
}, 180_000);

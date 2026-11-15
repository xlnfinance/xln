import { expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startStandaloneNode } from '../support/standalone-deployment-support';
import { launchDeployment } from '../support/standalone-deployment-process-support';
import { awaitVerification, waitForSends } from '../support/standalone-deployment-transactions-support';
import { until } from '../../stack-manager-recovery/stack-manager-resume-support';

test('a confirmed external use of the pending native nonce stops resume before a different CREATE', async () => {
  const fixture = await startStandaloneNode(0);
  await fixture.provider.send('evm_setAutomine', [false]);
  let session = launchDeployment(fixture, 'nonce-original');
  try {
    const [first] = await waitForSends(fixture, session, 1);
    const original = await fixture.provider.getTransaction(first.transaction.hash);
    await session.stop();
    await fixture.provider.send('anvil_dropTransaction', [first.transaction.hash]);
    const external = await fixture.signer.sendTransaction({
      to: fixture.signer.address,
      value: 0,
      nonce: fixture.initialNonce,
      gasLimit: 21_000n,
      maxFeePerGas: original!.maxFeePerGas! * 2n,
      maxPriorityFeePerGas: original!.maxPriorityFeePerGas! * 2n,
    });
    await fixture.provider.send('evm_setAutomine', [true]);
    await fixture.provider.send('anvil_mine', ['0x1']);
    expect((await external.wait())!.status).toBe(1);
    const before = fixture.submissions();
    session = launchDeployment(fixture, 'nonce-resume', { mode: 'resume' });
    await until(
      async () => session.outcome() !== undefined || fixture.submissions() > before,
      'external-nonce-conflict',
    );
    expect(fixture.submissions()).toBe(before);
    expect(await session.exited).not.toBe(0);
    expect(await session.log()).toContain('STACK_MANAGER_SENDER_NONCE_CONFLICT');
  } finally {
    await session.stop();
    await fixture.close();
  }
}, 60_000);

test.each(['init-only', 'first-future'] as const)(
  'a %s valid journal prefix cannot silently redeploy an already mined attempt',
  async prefix => {
    const fixture = await startStandaloneNode(0);
    let session = launchDeployment(fixture, 'prefix-original');
    try {
      await awaitVerification(session);
      await session.stop();
      const journalPath = join(fixture.nativeDirectory, 'journal.jsonl');
      const original = await readFile(journalPath, 'utf8');
      await writeFile(join(fixture.directory, 'journal-before-truncation.jsonl'), original);
      const initialized = original
        .split('\n')
        .filter(Boolean)
        .slice(0, prefix === 'init-only' ? 1 : 2)
        .join('\n');
      await writeFile(journalPath, `${initialized}\n`);
      const before = fixture.submissions();
      session = launchDeployment(fixture, 'prefix-resume', { mode: 'resume' });
      await until(
        async () => session.outcome() !== undefined || fixture.submissions() > before,
        'truncated-prefix-conflict',
      );
      expect(fixture.submissions()).toBe(before);
      expect(await session.exited).not.toBe(0);
      expect(await session.log()).toMatch(
        /STACK_MANAGER_(IGNITION_JOURNAL_(INCOMPLETE|INVALID)|SENDER_NONCE_CONFLICT)/,
      );
      expect(await readFile(journalPath, 'utf8')).toBe(`${initialized}\n`);
    } finally {
      await session.stop();
      await fixture.close();
    }
  },
  60_000,
);

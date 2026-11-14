import { expect, test } from 'bun:test';
import { cp, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { startResumeNode, until } from './stack-manager-resume-support';

const replaceNativeJournal = async (directory: string) => {
  const attempt = join(directory, 'resume-usdc');
  const execution = await readFile(join(attempt, 'manifest.json.execution.json'), 'utf8');
  const native = join(attempt, 'journal.jsonl');
  const journal = await readFile(native, 'utf8');
  await rename(native, join(attempt, 'journal-before-foreign-copy.jsonl'));
  await cp(join(directory, 'other-usdc/journal.jsonl'), native);
  return { attempt, execution, journal };
};

test('resume rejects another same-chain signer attempt native journal before sending or admitting', async () => {
  const fixture = await startResumeNode(4);
  let child = fixture.start('new', 'attempt-a');
  try {
    await until(async () => fixture.killed() || child.exitCode !== null, 'attempt-a-partial');
    expect(await child.exited).not.toBe(0);
    child = fixture.start('new', 'attempt-b', 'other-usdc', join(fixture.directory, 'other-catalog.json'));
    await until(
      async () =>
        child.exitCode !== null || (await fixture.read('attempt-b.log')).includes('STACK_MANAGER_PHASE:verifying'),
      'attempt-b-complete',
    );
    await fixture.provider.send('anvil_mine', ['0xb']);
    expect(await child.exited).toBe(0);
    const { attempt, execution, journal } = await replaceNativeJournal(fixture.directory);
    const nonce = await fixture.provider.send('eth_getTransactionCount', [fixture.signer.address, 'latest']);
    console.log(`IGNITION_FOREIGN_JOURNAL_EVIDENCE:${fixture.directory}`);
    child = fixture.start('resume', 'foreign-journal');
    expect(await child.exited).toBe(1);
    expect(await fixture.read('foreign-journal.log')).toContain('STACK_MANAGER_IGNITION_ATTEMPT_MISMATCH');
    expect(await fixture.provider.send('eth_getTransactionCount', [fixture.signer.address, 'latest'])).toBe(nonce);
    expect(await Bun.file(fixture.catalog).exists()).toBeFalse();
    expect(await readFile(join(attempt, 'journal-before-foreign-copy.jsonl'), 'utf8')).toBe(journal);
    expect(await readFile(join(attempt, 'manifest.json.execution.json'), 'utf8')).toBe(execution);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await child.exited;
    }
    await fixture.close();
  }
}, 60_000);

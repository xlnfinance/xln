import { expect, test } from 'bun:test';
import { Transaction } from 'ethers';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { safeStringify } from '../../../protocol/serialization';
import { startStandaloneNode } from './standalone-deployment-support';
import { launchDeployment } from './standalone-deployment-process-support';
import { observeRpc } from './standalone-deployment-rpc-support';
import { finish, readJson, journalMessages } from './standalone-deployment-transactions-support';
import { until } from '../stack-manager-recovery/stack-manager-resume-support';

test('completed resume rejects a native winning receipt re-included in a different block', async () => {
  const fixture = await startStandaloneNode(0);
  let snapshot = '';
  let raw = '';
  const observer = observeRpc(fixture, { before: async request => {
    if (request.method !== 'eth_sendRawTransaction') return;
    const transaction = Transaction.from(request.params[0]);
    if (transaction.nonce !== fixture.initialNonce + 10) return;
    raw = request.params[0];
    snapshot = await fixture.provider.send('evm_snapshot', []);
  } });
  let session = launchDeployment(fixture, 'completed-before-reorg', { rpcUrl: observer.url });
  try {
    const original = await finish(fixture, session);
    const archive = join(original.invocation, 'result.json');
    const archiveBytes = await readFile(archive, 'utf8');
    const journal = await readFile(join(fixture.nativeDirectory, 'journal.jsonl'), 'utf8');
    const hash = Transaction.from(raw).hash!;
    const before = await fixture.provider.send('eth_getTransactionReceipt', [hash]);
    expect(await fixture.provider.send('evm_revert', [snapshot])).toBeTrue();
    await fixture.provider.send('anvil_mine', ['0x1']);
    expect(await fixture.provider.send('eth_sendRawTransaction', [raw])).toBe(hash);
    const after = await fixture.provider.send('eth_getTransactionReceipt', [hash]);
    expect(after.blockHash).not.toBe(before.blockHash);
    expect(BigInt(after.blockNumber)).toBe(BigInt(before.blockNumber) + 1n);
    await fixture.provider.send('anvil_mine', ['0xb']);
    const sent = fixture.submissions();
    session = launchDeployment(fixture, 'completed-after-reorg', { mode: 'resume' });
    const exitCode = await session.exited;
    const result = await readJson(join(fixture.nativeDirectory, 'result.json'));
    await writeFile(join(fixture.directory, 'reinclude-proof.json'), safeStringify({ before, after, exitCode, original, result }, 2));
    expect(exitCode).not.toBe(0);
    expect(result.status).toBe('failed');
    expect(result.error.code).toBe('STACK_MANAGER_IGNITION_RECEIPT_CONFLICT');
    expect(await readFile(archive, 'utf8')).toBe(archiveBytes);
    expect(result.invocation).not.toBe(original.invocation);
    expect(await readFile(join(fixture.nativeDirectory, 'journal.jsonl'), 'utf8')).toBe(journal);
    expect(fixture.submissions()).toBe(sent);
    expect(await Bun.file(fixture.catalog).exists()).toBeFalse();
    console.log(`STANDALONE_REINCLUDE_EVIDENCE:${fixture.directory}/reinclude-proof.json`);
  } finally { await session.stop(); await observer.close(); await fixture.close(); }
}, 60_000);

test('resume rejects a completed creation removed before the dependent send', async () => {
  const fixture = await startStandaloneNode(0);
  const snapshot = await fixture.provider.send('evm_snapshot', []);
  let held = false;
  let release = () => {};
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const observer = observeRpc(fixture, { before: async request => {
    if (request.method === 'eth_sendRawTransaction' && Transaction.from(request.params[0]).nonce === fixture.initialNonce + 1) {
      held = true;
      await barrier;
    }
  } });
  let session = launchDeployment(fixture, 'creation-before-reorg', { rpcUrl: observer.url });
  try {
    await until(async () => held || session.outcome() !== undefined, 'dependent-send-held');
    expect(held).toBeTrue();
    const messages = await journalMessages(fixture);
    const confirmed = messages.filter(message => message.type === 'TRANSACTION_CONFIRM');
    expect(confirmed).toHaveLength(1);
    const hash = confirmed[0].hash;
    const before = await fixture.provider.send('eth_getTransactionReceipt', [hash]);
    const codeBefore = await fixture.provider.getCode(before.contractAddress);
    expect(codeBefore).not.toBe('0x');
    await session.stop();
    await observer.close();
    expect(await fixture.provider.send('evm_revert', [snapshot])).toBeTrue();
    const after = await fixture.provider.send('eth_getTransactionReceipt', [hash]);
    const codeAfter = await fixture.provider.getCode(before.contractAddress);
    expect(after).toBeNull();
    expect(codeAfter).toBe('0x');
    const sends = fixture.submissions();
    session = launchDeployment(fixture, 'creation-after-reorg', { mode: 'resume' });
    const exitCode = await session.exited;
    const result = await readJson(join(fixture.nativeDirectory, 'result.json'));
    await writeFile(join(fixture.directory, 'creation-reorg-proof.json'), safeStringify({ before, after, codeBefore, codeAfter, exitCode, result }, 2));
    expect(exitCode).not.toBe(0);
    expect(result.status).toBe('failed');
    expect(result.error.code).toBe('STACK_MANAGER_IGNITION_RECEIPT_CONFLICT');
    expect(fixture.submissions()).toBe(sends);
    expect(await Bun.file(fixture.catalog).exists()).toBeFalse();
    console.log(`STANDALONE_CREATION_REORG_EVIDENCE:${fixture.directory}/creation-reorg-proof.json`);
  } finally { await session.stop(); await observer.close(); release(); await fixture.close(); }
}, 60_000);

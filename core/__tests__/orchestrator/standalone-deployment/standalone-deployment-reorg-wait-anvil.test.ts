import { expect, test } from 'bun:test';
import { Contract, Transaction } from 'ethers';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { safeStringify } from '../../../protocol/serialization';
import { startStandaloneNode } from './standalone-deployment-support';
import { launchDeployment } from './standalone-deployment-process-support';
import { observeRpc } from './standalone-deployment-rpc-support';
import { awaitVerification, readJson, journalMessages } from './standalone-deployment-transactions-support';

for (const mode of ['removed', 'moved'] as const) test(`final wait rejects a ${mode} listing receipt instead of cached confirmation depth`, async () => {
  const fixture = await startStandaloneNode(0);
  let snapshot = '';
  let raw = '';
  let hash = '';
  let armed = false;
  let before: any;
  let after: any;
  const observer = observeRpc(fixture, {
    before: async request => {
      if (request.method !== 'eth_sendRawTransaction' || Transaction.from(request.params[0]).nonce !== fixture.initialNonce + 10) return;
      raw = request.params[0];
      hash = Transaction.from(raw).hash!;
      snapshot = await fixture.provider.send('evm_snapshot', []);
    },
    after: async (request, result) => {
      if (!armed || request.method !== 'eth_getTransactionReceipt' || request.params[0] !== hash || !result) return;
      armed = false;
      before = result;
      expect(await fixture.provider.send('evm_revert', [snapshot])).toBeTrue();
      if (mode === 'moved') {
        await fixture.provider.send('anvil_mine', ['0x1']);
        expect(await fixture.provider.send('eth_sendRawTransaction', [raw])).toBe(hash);
        await fixture.provider.send('anvil_mine', ['0xb']);
      }
      after = await fixture.provider.send('eth_getTransactionReceipt', [hash]);
    },
  });
  const session = launchDeployment(fixture, `wait-${mode}`, { rpcUrl: observer.url });
  try {
    await awaitVerification(session);
    const manifest = await readJson(join(fixture.nativeDirectory, 'manifest.json'));
    await fixture.provider.send('anvil_mine', ['0xa']);
    armed = true;
    const exitCode = await session.exited;
    expect(before).toBeDefined();
    if (mode === 'removed') expect(after).toBeNull();
    else expect(after.blockHash).not.toBe(before.blockHash);
    const ep = new Contract(manifest.contracts.entityProvider, ['function entityActionNonces(bytes32) view returns (uint256)'], fixture.provider);
    const foundationNonce = await ep.getFunction('entityActionNonces')(`0x${'0'.repeat(63)}1`);
    const result = await readJson(join(fixture.nativeDirectory, 'result.json'));
    const code = await fixture.provider.getCode(manifest.contracts.entityProvider);
    await writeFile(join(fixture.directory, `wait-${mode}-proof.json`), safeStringify({ before, after, exitCode, code, foundationNonce, result }, 2));
    expect(exitCode).not.toBe(0);
    expect(result.status).toBe('failed');
    expect(result.error.code).toMatch(/RECEIPT/);
    expect(fixture.submissions()).toBe(11);
    expect(await Bun.file(fixture.catalog).exists()).toBeFalse();
    console.log(`STANDALONE_WAIT_REORG_EVIDENCE:${fixture.directory}/wait-${mode}-proof.json`);
  } finally { await session.stop(); await observer.close(); await fixture.close(); }
}, 60_000);

test('a live reorg of a journal-confirmed creation stops before signing the dependent transaction', async () => {
  const fixture = await startStandaloneNode(0);
  const snapshot = await fixture.provider.send('evm_snapshot', []);
  let before: any;
  let codeBefore = '';
  let reorged = false;
  const observer = observeRpc(fixture, { after: async (request, result) => {
    if (reorged || request.method !== 'eth_getTransactionReceipt' || !result) return;
    const confirmations = (await journalMessages(fixture)).filter(message => message.type === 'TRANSACTION_CONFIRM');
    if (!confirmations.some(message => message.hash === request.params[0])) return;
    reorged = true;
    before = result;
    codeBefore = await fixture.provider.getCode(result.contractAddress);
    expect(await fixture.provider.send('evm_revert', [snapshot])).toBeTrue();
  } });
  const session = launchDeployment(fixture, 'live-creation-reorg', { rpcUrl: observer.url });
  try {
    const exitCode = await session.exited;
    expect(reorged).toBeTrue();
    const after = await fixture.provider.send('eth_getTransactionReceipt', [before.transactionHash]);
    const codeAfter = await fixture.provider.getCode(before.contractAddress);
    const result = await readJson(join(fixture.nativeDirectory, 'result.json'));
    await writeFile(join(fixture.directory, 'live-creation-reorg-proof.json'), safeStringify({ before, after, codeBefore, codeAfter, exitCode, result }, 2));
    expect(exitCode).not.toBe(0);
    expect(result.error.code).toBe('STACK_MANAGER_IGNITION_RECEIPT_CONFLICT');
    expect(codeBefore).not.toBe('0x');
    expect(codeAfter).toBe('0x');
    expect(after).toBeNull();
    expect(fixture.submissions()).toBe(1);
    expect(await Bun.file(fixture.catalog).exists()).toBeFalse();
    console.log(`STANDALONE_LIVE_REORG_EVIDENCE:${fixture.directory}/live-creation-reorg-proof.json`);
  } finally { await session.stop(); await observer.close(); await fixture.close(); }
}, 60_000);

import { expect, test } from 'bun:test';
import { toBeHex } from 'ethers';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { safeStringify } from '../../../protocol/serialization';
import { startStandaloneNode } from './standalone-deployment-support';
import { launchDeployment } from './standalone-deployment-process-support';
import { observeRpc } from './standalone-deployment-rpc-support';
import { awaitVerification, readJson } from './standalone-deployment-transactions-support';

test('a real reorg during expense balance observation cannot publish stale verified success', async () => {
  const fixture = await startStandaloneNode(0);
  const beforeDeployment = await fixture.provider.send('evm_snapshot', []);
  let armed = false;
  let replacement: { beforeHash: string; afterHash: string; height: string } | undefined;
  const observer = observeRpc(fixture, { after: async request => {
    if (!armed || request.method !== 'eth_getBalance') return;
    armed = false;
    const before = await fixture.provider.send('eth_getBlockByNumber', ['latest', false]);
    expect(await fixture.provider.send('evm_revert', [beforeDeployment])).toBeTrue();
    const origin = BigInt(await fixture.provider.send('eth_blockNumber', []));
    await fixture.provider.send('anvil_mine', [toBeHex(BigInt(before.number) - origin)]);
    const after = await fixture.provider.send('eth_getBlockByNumber', ['latest', false]);
    expect(after.number).toBe(before.number);
    expect(after.hash).not.toBe(before.hash);
    replacement = { beforeHash: before.hash, afterHash: after.hash, height: before.number };
  } });
  const session = launchDeployment(fixture, 'late-reorg', { rpcUrl: observer.url });
  try {
    await awaitVerification(session);
    const manifest = await readJson(join(fixture.nativeDirectory, 'manifest.json'));
    const beforeReceipt = await fixture.provider.send('eth_getTransactionReceipt', [manifest.evmContracts.account.transactionHash]);
    const codeBefore = await fixture.provider.getCode(manifest.contracts.account);
    armed = true;
    await fixture.provider.send('anvil_mine', ['0xb']);
    const code = await session.exited;
    expect(replacement).toBeDefined();
    const hash = manifest.evmContracts.account.transactionHash;
    expect(await fixture.provider.getTransactionReceipt(hash)).toBeNull();
    expect(await fixture.provider.getCode(manifest.contracts.account)).toBe('0x');
    const result = await readJson(join(fixture.nativeDirectory, 'result.json'));
    await writeFile(join(fixture.directory, 'late-reorg-proof.json'), safeStringify({ replacement,
      beforeReceipt, codeBefore, afterReceipt: null, codeAfter: '0x', exitCode: code, terminalStatus: result.status, missingReceipt: hash, result }, 2));
    expect(code).not.toBe(0);
    expect(result.status).toBe('failed');
    expect(result.error.code).toMatch(/(RECEIPT|CANONICAL|SNAPSHOT|BYTECODE)/);
    expect(fixture.submissions()).toBe(11);
    expect(await Bun.file(fixture.catalog).exists()).toBeFalse();
    console.log(`STANDALONE_REORG_EVIDENCE:${fixture.directory}/late-reorg-proof.json`);
  } finally { await session.stop(); await observer.close(); await fixture.close(); }
}, 60_000);

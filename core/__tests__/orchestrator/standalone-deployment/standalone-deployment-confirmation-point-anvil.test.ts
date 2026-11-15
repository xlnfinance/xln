import { expect, test } from 'bun:test';
import { Transaction, keccak256 } from 'ethers';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { safeStringify } from '../../../protocol/serialization';
import { startStandaloneNode } from './support/standalone-deployment-support';
import { launchDeployment } from './support/standalone-deployment-process-support';
import { observeRpc } from './support/standalone-deployment-rpc-support';
import { awaitVerification, readJson } from './support/standalone-deployment-transactions-support';

test('depth eleven stays running; a tip advancing during receipt observation completes at a static canonical point', async () => {
  const fixture = await startStandaloneNode(0);
  let hash = '';
  let armed = false;
  let race: any;
  const observer = observeRpc(fixture, {
    before: async request => {
      if (request.method !== 'eth_sendRawTransaction') return;
      const transaction = Transaction.from(request.params[0]);
      if (transaction.nonce === fixture.initialNonce + 10) hash = transaction.hash!;
    },
    after: async (request, result) => {
      if (!armed || request.method !== 'eth_getTransactionReceipt' || request.params[0] !== hash || !result) return;
      armed = false;
      const before = await fixture.provider.send('eth_getBlockByNumber', ['latest', false]);
      expect(BigInt(before.number) - BigInt(result.blockNumber) + 1n).toBe(11n);
      expect((await readJson(join(fixture.nativeDirectory, 'result.json'))).status).toBe('running');
      await fixture.provider.send('anvil_mine', ['0x1']);
      const after = await fixture.provider.send('eth_getBlockByNumber', ['latest', false]);
      race = { before: { number: before.number, hash: before.hash }, after: { number: after.number, hash: after.hash }, receipt: result };
    },
  });
  const session = launchDeployment(fixture, 'static-confirmed-tip', { rpcUrl: observer.url });
  try {
    await awaitVerification(session);
    await fixture.provider.send('anvil_mine', ['0xa']);
    await Bun.sleep(250);
    expect(session.outcome()).toBeUndefined();
    expect((await readJson(join(fixture.nativeDirectory, 'result.json'))).status).toBe('running');
    armed = true;
    const observed = new Set<string>();
    while (session.outcome() === undefined) {
      const status = (await readJson(join(fixture.nativeDirectory, 'result.json'))).status;
      expect(['running', 'complete']).toContain(status);
      observed.add(status);
      await Bun.sleep(25);
    }
    expect(await session.exited).toBe(0);
    expect(race).toBeDefined();
    const result = await readJson(join(fixture.nativeDirectory, 'result.json'));
    const tip = await fixture.provider.send('eth_getBlockByNumber', ['latest', false]);
    expect(tip.hash).toBe(race.after.hash);
    expect(result.verification.point).toEqual({ number: Number(BigInt(tip.number)), hash: tip.hash });
    expect(result.expenses.balance.currentBlockHash).toBe(tip.hash);
    expect(result.expenses.balance.currentBlockNumber).toBe(result.verification.point.number);
    expect(result.expenses.balance.unaccountedDeltaWei).toBe('0');
    const receipts = [];
    for (const operation of Object.values(result.manifest.evmContracts) as any[]) {
      const receipt = await fixture.provider.send('eth_getTransactionReceipt', [operation.transactionHash]);
      expect(BigInt(tip.number) - BigInt(receipt.blockNumber) + 1n >= 12n).toBeTrue();
      receipts.push(receipt);
    }
    expect(receipts).toHaveLength(11);
    const runtimeHashes = Object.fromEntries(await Promise.all(Object.entries(result.manifest.contracts).map(async ([name, address]) =>
      [name, keccak256(await fixture.provider.getCode(String(address), result.verification.point.number))])));
    expect(Object.keys(runtimeHashes)).toHaveLength(8);
    expect(fixture.submissions()).toBe(11);
    expect(await Bun.file(fixture.catalog).exists()).toBeFalse();
    await writeFile(join(fixture.directory, 'confirmation-point-proof.json'), safeStringify({ race, observed: [...observed], tip: { number: tip.number, hash: tip.hash }, receipts, runtimeHashes, result }, 2));
    console.log(`STANDALONE_CONFIRMATION_POINT_EVIDENCE:${fixture.directory}/confirmation-point-proof.json`);
  } finally { await session.stop(); await observer.close(); await fixture.close(); }
}, 60_000);

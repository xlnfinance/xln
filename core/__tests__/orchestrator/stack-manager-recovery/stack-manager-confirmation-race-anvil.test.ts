import { safeStringify } from '../../../protocol/serialization';
import { expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startResumeNode, until } from './stack-manager-resume-support';
import { decodeJurisdictionStackManifest } from '../../../jurisdiction/adapter/stack-manager/validation';

type Fixture = Awaited<ReturnType<typeof startResumeNode>>;
type RpcMessage = { id: number; method: string; params: string[] };
type Race = { reads: number; hash: string; released: boolean; trace: unknown[] };
const delay = (milliseconds: number) => Bun.sleep(milliseconds);

const holdRealReceipt = async (fixture: Fixture, race: Race, message: RpcMessage, body: string) => {
  if (race.hash && message.params[0] !== race.hash) return;
  race.hash = message.params[0]!;
  race.reads += 1;
  if (race.reads > 2) return;
  race.trace.push({ hold: race.reads, request: message, realResponse: JSON.parse(body) });
  if (race.reads === 2) {
    await fixture.provider.send('anvil_mine', ['0xb']);
    race.trace.push({ minedExactlyElevenBlocks: true, tip: await fixture.provider.send('eth_blockNumber', []) });
  }
  // Delay real responses across ethers' 250ms perform-cache lifetime. Values
  // are forwarded unchanged; the second response races the actual mined tip.
  await delay(400);
  if (race.reads === 2) race.released = true;
};

const createRaceProxy = (fixture: Fixture, race: Race) =>
  Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const payload = await request.text();
      const input = JSON.parse(payload);
      const messages: RpcMessage[] = Array.isArray(input) ? input : [input];
      const response = await fetch(fixture.request.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
      });
      const body = await response.text();
      const verifying = (await fixture.read('race.log')).includes('STACK_MANAGER_PHASE:verifying');
      const receipt = messages.find(message => message.method === 'eth_getTransactionReceipt');
      if (verifying && receipt) await holdRealReceipt(fixture, race, receipt, body);
      if (verifying && messages.some(message => message.method === 'eth_blockNumber')) {
        race.trace.push({ blockRequest: messages, realResponse: JSON.parse(body), afterRelease: race.released });
      }
      return new Response(body, { headers: { 'content-type': 'application/json' } });
    },
  });

const captureChainProof = async (fixture: Fixture, callerPid: number, exitCode: number | null, race: Race) => {
  const manifest = decodeJurisdictionStackManifest(JSON.parse(await fixture.read('resume-usdc/manifest.json')));
  const tip = BigInt(await fixture.provider.send('eth_blockNumber', []));
  const receipts = await Promise.all(
    Object.values(manifest.evmContracts).map(async operation => {
      const receipt = await fixture.provider.send('eth_getTransactionReceipt', [operation.transactionHash]);
      const block = await fixture.provider.send('eth_getBlockByNumber', [receipt.blockNumber, false]);
      return {
        hash: receipt.transactionHash,
        blockNumber: receipt.blockNumber,
        depth: Number(tip - BigInt(receipt.blockNumber) + 1n),
        status: receipt.status,
        canonical: receipt.blockHash === block.hash,
      };
    }),
  );
  const proof = {
    callerPid,
    exitCode,
    phaseLog: await fixture.read('race.log'),
    catalogExists: await Bun.file(fixture.catalog).exists(),
    tip: Number(tip),
    receipts,
    submissions: fixture.submissions(),
    race,
  };
  await writeFile(join(fixture.directory, 'confirmation-race-proof.json'), safeStringify(proof, 2));
  return proof;
};

test('production Stack Manager admits at twelve when mined tip advances between receipt and block subscription', async () => {
  const fixture = await startResumeNode(0);
  const race: Race = { reads: 0, hash: '', released: false, trace: [] };
  const proxy = createRaceProxy(fixture, race);
  const child = fixture.startApi('new', 'race', undefined, 'local', { rpcUrl: `http://127.0.0.1:${proxy.port}` });
  try {
    await until(async () => race.released || child.exitCode !== null, 'receipt-race-release');
    expect(race.released).toBeTrue();
    await Promise.race([child.exited, delay(8_000)]);
    const proof = await captureChainProof(fixture, child.pid, child.exitCode, race);
    console.log(`IGNITION_CONFIRMATION_RACE_EVIDENCE:${fixture.directory}`);
    expect(proof.receipts).toHaveLength(11);
    expect(Math.min(...proof.receipts.map(receipt => receipt.depth))).toBe(12);
    expect(proof.receipts.every(receipt => receipt.status === '0x1' && receipt.canonical)).toBeTrue();
    expect(proof.submissions).toBe(11);
    expect(child.exitCode).toBe(0);
    expect(proof.catalogExists).toBeTrue();
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await child.exited;
    }
    await proxy.stop(true);
    await fixture.close();
  }
}, 60_000);

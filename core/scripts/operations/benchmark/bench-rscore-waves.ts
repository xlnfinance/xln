/**
 * Honest throughput of the Rust account engine over the real process wire:
 * restore N hub-owned accounts, then drive waves of direct payments through
 * Prepare -> Commit exactly the way the orchestrator integration will.
 * Measures end-to-end tx/s including IPC framing and result decode — this is
 * the ceiling the TS orchestrator can buy by delegating account application.
 *
 * Usage: bun core/scripts/operations/benchmark/bench-rscore-waves.ts \
 *          [accounts=1000] [waves=20] [txsPerWave=10000] [workers=8]
 */
import { join } from 'node:path';

import { RscoreProcessClient, type RscoreWireValue } from '../../../rscore/client';

const BINARY = join(import.meta.dir, '../../../../rscore/target/release/xln-rscore');

const accounts = Number(process.argv[2] ?? '1000');
const waves = Number(process.argv[3] ?? '20');
const txsPerWave = Number(process.argv[4] ?? '10000');
const workers = Number(process.argv[5] ?? '8');

const entityHex = (index: number): string => `0x${index.toString(16).padStart(64, '0')}`;

const accountIdBytes = (index: number): Uint8Array => {
  const bytes = new Uint8Array(32);
  new DataView(bytes.buffer).setUint32(28, index + 1);
  return bytes;
};

// Hub is LEFT of every account; counterparty entity index offset by 1<<20.
const HUB = entityHex(1);
const seed = (index: number): RscoreWireValue[] => {
  const user = entityHex((1 << 20) + index + 2);
  const [left, right] = HUB < user ? [HUB, user] : [user, HUB];
  return [
    accountIdBytes(index),
    hexToBytes(left), // owner = left side of the pair
    hexToBytes(left),
    hexToBytes(right),
    31_337,
    new Uint8Array(20).fill(0x88),
    new Uint8Array(32).fill(0x99),
    [10, 20],
    [[1, '1000000000', '0', '0', '500000000', '500000000', '0', '0', '0', '0']],
    [],
    [0, 0],
  ];
};

const hexToBytes = (value: string): Uint8Array => {
  const clean = value.slice(2);
  const bytes = new Uint8Array(clean.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
};

const directPayment = (
  inputIndex: number,
  accountIndex: number,
  amount: bigint,
  leftPays: boolean,
): RscoreWireValue[] => {
  const user = entityHex((1 << 20) + accountIndex + 2);
  const [left, right] = HUB < user ? [HUB, user] : [user, HUB];
  const [from, to] = leftPays ? [left, right] : [right, left];
  return [
    inputIndex,
    accountIdBytes(accountIndex),
    leftPays ? 0 : 1, // proposer side
    [1_700_000_000_000 + inputIndex, 1_700_000_000_000 + inputIndex, 100, 0],
    [0, 1, amount.toString(), [to], null, from, to, 0, null],
  ];
};

const main = async (): Promise<void> => {
  const client = new RscoreProcessClient(BINARY, {
    engineGeneration: Buffer.alloc(8, 0xa0),
    runtimeId: Buffer.alloc(20, 0x10),
    sessionId: Buffer.alloc(16, 0x20),
  });
  await client.hello(workers);
  const seeds = Array.from({ length: accounts }, (_, index) => seed(index));
  const restoreStarted = performance.now();
  await client.restore(0, seeds);
  console.log(`restore accounts=${accounts} ms=${Math.ceil(performance.now() - restoreStarted)}`);

  let applied = 0;
  const started = performance.now();
  for (let wave = 0; wave < waves; wave += 1) {
    const jobs = Array.from({ length: txsPerWave }, (_, index) =>
      directPayment(index, (wave * 7 + index) % accounts, 5n, (wave + index) % 2 === 0));
    const prepared = (await client.prepare(jobs)) as unknown[];
    const results = prepared[2] as unknown[];
    if (wave === 0 && Array.isArray(results[0])) {
      const verdict = (results[0] as unknown[])[2];
      if (Number((verdict as unknown[])[0]) !== 0) console.log('first reject:', JSON.stringify(verdict));
    }
    for (const row of results) {
      const verdict = (row as unknown[])[2] as unknown[];
      if (Number((verdict as unknown[])[0]) === 0) applied += 1;
    }
    await client.commit(client.requestIdBytes(client.lastRequestId));
  }
  const elapsedMs = performance.now() - started;
  const total = waves * txsPerWave;
  console.log(
    `waves=${waves} txs=${total} applied=${applied} elapsedMs=${Math.ceil(elapsedMs)} ` +
    `txPerSec=${Math.round(total / (elapsedMs / 1_000))} workers=${workers}`,
  );
  await client.shutdown();
};

await main();

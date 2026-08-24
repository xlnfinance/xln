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

import { EMPTY_ACCOUNT_J_CLAIM_ROOT } from '../../../account/j-claims/j-claim-codec';
import { RscoreProcessClient, type RscoreWireValue } from '../../../rscore/client';
import { swapMarketPolicyWire } from '../../../rscore/shadow-wire';
import { safeStringify } from '../../../protocol/serialization';

const BINARY = join(import.meta.dir, '../../../../rscore/target/release/xln-rscore');

const accounts = Number(process.argv[2] ?? '1000');
const waves = Number(process.argv[3] ?? '20');
const txsPerWave = Number(process.argv[4] ?? '10000');
const workers = Number(process.argv[5] ?? '8');
/**
 * Attach a realistic replica shell to every seed and every job, so the engine
 * commits the Entity's account leaf rather than the bare financial root. This
 * is what parity mode actually costs.
 */
const withShell = process.argv[6] === 'shell';



const entityHex = (index: number): string => `0x${index.toString(16).padStart(64, '0')}`;

// The account id IS the counterparty entity id (engine enforces the binding),
// so the bench addresses accounts by the user entity itself.
const USER_OFFSET = 1 << 20;
const userHex = (index: number): string => entityHex(USER_OFFSET + index + 2);
const accountIdBytes = (index: number): Uint8Array => hexToBytes(userHex(index));

// Hub owns every account; users are the counterparties.
const HUB = entityHex(1);
const seed = (index: number): RscoreWireValue[] => {
  const user = userHex(index);
  const [left, right] = HUB < user ? [HUB, user] : [user, HUB];
  return [
    accountIdBytes(index),
    hexToBytes(HUB), // owner = the hub entity this engine process serves
    hexToBytes(left),
    hexToBytes(right),
    31_337,
    new Uint8Array(20).fill(0x88),
    new Uint8Array(32).fill(0x99),
    [10, 20],
    [[1, '1000000000', '0', '0', '500000000', '500000000', '0', '0', '0', '0']],
    [],
    [0, 0],
    EMPTY_CARRIED,
    withShell ? shellWire(index, 0) : null,
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


// Sections the engine carries but never interprets; all empty for a fresh
// payment-profile account (roots zero, J-claim accumulators at genesis).
const EMPTY_CLAIM: RscoreWireValue[] = [hexToBytes(EMPTY_ACCOUNT_J_CLAIM_ROOT), 0];
const EMPTY_CARRIED: RscoreWireValue[] = [
  new Uint8Array(32),
  [], // resting swap offers: owned by the engine, shipped in full
  new Uint8Array(32), new Uint8Array(32), new Uint8Array(32),
  [], // rebalance fee policies: owned by the engine, shipped in full
  EMPTY_CLAIM, EMPTY_CLAIM,
];

/** A hub account's shell, in the shape the Entity projects it. */
const shellWire = (accountIndex: number, height: number): RscoreWireValue => {
  const text = (value: string): RscoreWireValue => [4, value];
  const number = (value: number): RscoreWireValue => [2, String(value)];
  const digest = `0x${(accountIndex + height).toString(16).padStart(64, '0')}`;
  return [
    [8, [
      ['status', text('active')],
      ['currentHeight', number(height)],
      ['rollbackCount', number(0)],
      ['currentFrameHash', text(digest)],
      ['counterpartyFrameHanko', text(digest)],
      ['pendingWithdrawals', text(`0x${'00'.repeat(32)}`)],
      ['proofHeader', [8, [
        ['fromEntity', text(HUB)],
        ['toEntity', text(userHex(accountIndex))],
        ['nextProofNonce', number(height)],
      ]]],
      ['shadow', [8, [
        ['rebalance', [8, [
          ['policyRoot', text(`0x${'00'.repeat(32)}`)],
          ['submittedAtByTokenRoot', text(`0x${'00'.repeat(32)}`)],
        ]]],
      ]]],
    ]],
    [],
  ];
};

const directPayment = (
  inputIndex: number,
  accountIndex: number,
  amount: bigint,
  leftPays: boolean,
): RscoreWireValue[] => {
  const user = userHex(accountIndex);
  const [left, right] = HUB < user ? [HUB, user] : [user, HUB];
  const [from, to] = leftPays ? [left, right] : [right, left];
  return [
    inputIndex,
    accountIdBytes(accountIndex),
    leftPays ? 0 : 1, // proposer side
    [1_700_000_000_000 + inputIndex, 1_700_000_000_000 + inputIndex, 100, 0, 100],
    [0, 1, amount.toString(), [to], null, from, to, 0, null],
    withShell ? shellWire(accountIndex, inputIndex) : null,
  ];
};

const main = async (): Promise<void> => {
  const client = new RscoreProcessClient(BINARY, {
    engineGeneration: Buffer.alloc(8, 0xa0),
    runtimeId: Buffer.alloc(20, 0x10),
    sessionId: Buffer.alloc(16, 0x20),
  });
  await client.hello(workers, swapMarketPolicyWire());
  const seeds = Array.from({ length: accounts }, (_, index) => seed(index));
  const restoreStarted = performance.now();
  await client.restore(0, seeds);
  console.log(`restore accounts=${accounts} ms=${Math.ceil(performance.now() - restoreStarted)}`);

  let applied = 0;
  let engineUs = 0;
  let commitMs = 0;
  const started = performance.now();
  for (let wave = 0; wave < waves; wave += 1) {
    const jobs = Array.from({ length: txsPerWave }, (_, index) =>
      directPayment(index, (wave * 7 + index) % accounts, 5n, (wave + index) % 2 === 0));
    const prepared = (await client.prepare(jobs)) as unknown[];
    const results = prepared[2] as unknown[];
    if (wave === 0 && Array.isArray(results[0])) {
      const verdict = (results[0] as unknown[])[2];
      if (Number((verdict as unknown[])[0]) !== 0) console.log('first reject:', safeStringify(verdict));
    }
    for (const row of results) {
      const verdict = (row as unknown[])[2] as unknown[];
      if (Number((verdict as unknown[])[0]) === 0) applied += 1;
    }
    engineUs += Number(prepared[5]);
    const commitStarted = performance.now();
    await client.commit(client.requestIdBytes(client.lastRequestId));
    commitMs += performance.now() - commitStarted;
  }
  const elapsedMs = performance.now() - started;
  const total = waves * txsPerWave;
  console.log(
    `waves=${waves} txs=${total} applied=${applied} elapsedMs=${Math.ceil(elapsedMs)} ` +
    `txPerSec=${Math.round(total / (elapsedMs / 1_000))} workers=${workers} ` +
    `engineMs=${Math.round(engineUs / 1000)} commitMs=${Math.round(commitMs)} ` +
    `engineUsPerTx=${(engineUs / total).toFixed(2)} shell=${withShell}`,
  );
  await client.shutdown();
};

await main();

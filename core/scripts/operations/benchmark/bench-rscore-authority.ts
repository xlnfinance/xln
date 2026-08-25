/**
 * What the authoritative Rust engine actually costs, over the real process
 * wire, on the path the runtime will use.
 *
 * The engine owns the accounts here: it derives its own signer from the seed
 * it is handed, admits payments into its own mempools, and signs the frames.
 * Every reply is decoded through the strict wave decoder — the same one the
 * driver uses — so the numbers include the cost of producing something the
 * runtime could relay, not just of mutating memory.
 *
 * Two phases, measured apart, because a hub pays for both:
 *   propose — admit N payments, sign N account frames, commit the wave
 *   ack     — apply the counterparties' acks to those frames, commit
 * The counterparties are TypeScript: it derives their keys, signs their acks
 * with real hankos, and the engine verifies them. Building those acks is not
 * in the engine's time.
 *
 * Not measured here, deliberately: applying frames that counterparties
 * proposed (needs a second authority per counterparty entity), the runtime's
 * own WAL, and everything TypeScript does around the call. This is the
 * engine's ceiling, not the system's throughput.
 *
 * Usage: bun core/scripts/operations/benchmark/bench-rscore-authority.ts \
 *          [accounts=1000] [waves=10] [paymentsPerWave=1000] [workers=8]
 */
import { join } from 'node:path';

import { deriveSignerAddressSync, deriveSignerKeySync } from '../../../account/crypto';
import { buildSingleSignerHanko } from '../../../hanko/batch';
import { EMPTY_ACCOUNT_J_CLAIM_ROOT } from '../../../account/j-claims/j-claim-codec';
import { generateLazyEntityId } from '../../../entity/factory';
import { RscoreProcessClient, type RscoreWireValue } from '../../../rscore/client';
import { swapMarketPolicyWire, waveAdmitOp, waveInputOp } from '../../../rscore/shadow-wire';
import { decodeWave, type Wave } from '../../../rscore/wave-decode';

const BINARY = join(import.meta.dir, '../../../../rscore/target/release/xln-rscore');

const accounts = Number(process.argv[2] ?? '1000');
const waves = Number(process.argv[3] ?? '10');
const paymentsPerWave = Number(process.argv[4] ?? '1000');
const workers = Number(process.argv[5] ?? '8');

const SEED = `0x${'7a'.repeat(32)}`;
const HUB_SIGNER = '1';
const CHAIN_ID = 31_337;
const DEPOSITORY = new Uint8Array(20).fill(0x88);
const WATCH_SEED = new Uint8Array(32).fill(0x99);

const hexToBytes = (value: string): Uint8Array => {
  const clean = value.startsWith('0x') ? value.slice(2) : value;
  const bytes = new Uint8Array(clean.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
};

const EMPTY_CLAIM: RscoreWireValue[] = [hexToBytes(EMPTY_ACCOUNT_J_CLAIM_ROOT), 0];
const EMPTY_CARRIED: RscoreWireValue[] = [
  new Uint8Array(32),
  [],
  new Uint8Array(32), new Uint8Array(32), new Uint8Array(32),
  [],
  EMPTY_CLAIM, EMPTY_CLAIM,
];

/**
 * A counterparty the engine will have to authenticate: a real lazy entity
 * over a real key, so its acks carry hankos the engine verifies rather than
 * bytes it is asked to trust.
 */
type User = { entityId: string; privateKey: Uint8Array };

const user = (index: number): User => {
  const signerId = `bench-user-${index}`;
  const address = deriveSignerAddressSync(SEED, signerId);
  return {
    entityId: generateLazyEntityId([address], 1n).toLowerCase(),
    privateKey: deriveSignerKeySync(SEED, signerId),
  };
};

const seedWire = (hub: string, counterparty: string): RscoreWireValue[] => {
  const [left, right] = hub < counterparty ? [hub, counterparty] : [counterparty, hub];
  return [
    hexToBytes(counterparty),
    hexToBytes(hub),
    hexToBytes(left),
    hexToBytes(right),
    CHAIN_ID,
    DEPOSITORY,
    WATCH_SEED,
    [10, 20],
    // One funded token: collateral on both sides, so a wave of payments is
    // limited by the engine and not by capacity.
    [[1, '1000000000', '0', '0', '500000000', '500000000', '0', '0', '0', '0']],
    [],
    [0, 0],
    EMPTY_CARRIED,
    null,
  ];
};

const paymentTx = (hub: string, counterparty: string, amount: bigint): RscoreWireValue[] =>
  [0, 1, amount.toString(), [counterparty], null, hub, counterparty, 0, null];

const ackRow = (
  inputIndex: number,
  counterparty: string,
  height: number,
  stateHash: string,
  hanko: string,
): RscoreWireValue => [
  inputIndex,
  hexToBytes(counterparty),
  hexToBytes(counterparty),
  [1, height, hexToBytes(stateHash), hexToBytes(hanko)],
];

type Phase = { wallMs: number; engineUs: number; decodeMs: number; commitMs: number; rows: number };

const emptyPhase = (): Phase => ({ wallMs: 0, engineUs: 0, decodeMs: 0, commitMs: 0, rows: 0 });

const perSecond = (rows: number, ms: number): number => (ms <= 0 ? 0 : Math.round(rows / (ms / 1_000)));

const report = (name: string, phase: Phase): void => {
  const wireMs = Math.max(0, phase.wallMs - phase.engineUs / 1_000 - phase.decodeMs - phase.commitMs);
  console.log(
    `${name} rows=${phase.rows} perSec=${perSecond(phase.rows, phase.wallMs)} ` +
    `wallMs=${Math.round(phase.wallMs)} engineMs=${Math.round(phase.engineUs / 1_000)} ` +
    `wireMs=${Math.round(wireMs)} decodeMs=${Math.round(phase.decodeMs)} ` +
    `commitMs=${Math.round(phase.commitMs)} usPerRow=${(phase.wallMs * 1_000 / Math.max(1, phase.rows)).toFixed(1)}`,
  );
};

const runWave = async (
  client: RscoreProcessClient,
  hub: string,
  ops: RscoreWireValue[],
  timestamp: number,
  propose: boolean,
  phase: Phase,
): Promise<Wave> => {
  const started = performance.now();
  const { result, token } = await client.prepareAccountWave({
    entities: [{
      ownerEntityId: hexToBytes(hub),
      timestamp,
      jHeight: 100,
      entityTimestamp: timestamp,
      finalizedJHeight: 100,
      propose,
      ops,
    }],
  });
  const decodeStarted = performance.now();
  const wave = decodeWave(result);
  const commitStarted = performance.now();
  await client.commit(token);
  const finished = performance.now();
  phase.wallMs += finished - started;
  phase.engineUs += wave.engineMicros;
  phase.decodeMs += commitStarted - decodeStarted;
  phase.commitMs += finished - commitStarted;
  return wave;
};

const main = async (): Promise<void> => {
  const client = new RscoreProcessClient(BINARY, {
    engineGeneration: Buffer.alloc(8, 0xa0),
    runtimeId: Buffer.alloc(20, 0x10),
    sessionId: Buffer.alloc(16, 0x20),
  });
  const hello = (await client.hello(workers, swapMarketPolicyWire(), {
    privateKey: deriveSignerKeySync(SEED, HUB_SIGNER),
    signerId: HUB_SIGNER,
  })) as unknown[];
  const hub = `0x${Buffer.from(hello[5] as Uint8Array).toString('hex')}`.toLowerCase();
  // The engine says which entity it derived; TypeScript derives the same one
  // from the same seed and refuses to bench an engine signing as anyone else.
  const expected = generateLazyEntityId(
    [deriveSignerAddressSync(SEED, HUB_SIGNER)],
    1n,
  ).toLowerCase();
  if (hub !== expected) throw new Error(`BENCH_AUTHORITY_ENTITY_MISMATCH:${hub}:${expected}`);

  const users = Array.from({ length: accounts }, (_, index) => user(index));
  const restoreStarted = performance.now();
  await client.restore(0, users.map(row => seedWire(hub, row.entityId)));
  const restoreMs = performance.now() - restoreStarted;

  const propose = emptyPhase();
  const ack = emptyPhase();
  let signedFrames = 0;
  let ackCommits = 0;
  let buildMs = 0;
  let heights = new Map<string, number>();

  for (let index = 0; index < waves; index += 1) {
    const timestamp = 1_700_000_000_000 + index * 1_000;
    const selected = Array.from({ length: paymentsPerWave }, (_, offset) =>
      users[(index * paymentsPerWave + offset) % accounts]!);
    // One admission per account per wave: two payments for one account in one
    // wave would ride in a single frame and the count would flatter the rate.
    const unique = [...new Map(selected.map(row => [row.entityId, row])).values()];

    let buildStarted = performance.now();
    const admissions = unique.map(row =>
      waveAdmitOp(row.entityId, [paymentTx(hub, row.entityId, 5n)] as never));
    buildMs += performance.now() - buildStarted;

    const proposed = await runWave(client, hub, admissions, timestamp, true, propose);
    propose.rows += proposed.proposals.length;

    // The counterparties sign, outside the engine's time: this is what a real
    // peer would send back, and the engine verifies every one of them.
    buildStarted = performance.now();
    const acks: RscoreWireValue[] = [];
    let inputIndex = 0;
    for (const proposal of proposed.proposals) {
      const frame = proposal.frame;
      if (frame === null) continue;
      const counterparty = proposal.accountId;
      const key = users.find(row => row.entityId === counterparty)?.privateKey;
      if (!key) throw new Error(`BENCH_UNKNOWN_COUNTERPARTY:${counterparty}`);
      signedFrames += 1;
      heights.set(counterparty, frame.height);
      acks.push(waveInputOp(ackRow(
        inputIndex,
        counterparty,
        frame.height,
        frame.stateHash,
        buildSingleSignerHanko(counterparty, frame.stateHash, key),
      )));
      inputIndex += 1;
    }
    buildMs += performance.now() - buildStarted;

    const applied = await runWave(client, hub, acks, timestamp + 1, false, ack);
    ack.rows += applied.applied.length;
    for (const row of applied.applied) {
      if (row.verdict.kind === 'ackCommitted') ackCommits += 1;
      else throw new Error(`BENCH_ACK_NOT_COMMITTED:${row.verdict.kind}:${JSON.stringify(row.verdict)}`);
    }
  }

  console.log(`restore accounts=${accounts} ms=${Math.round(restoreMs)} workers=${workers}`);
  report('propose', propose);
  report('ack    ', ack);
  // A payment through this hub costs it one signed frame and one verified ack.
  const paymentMs = propose.wallMs + ack.wallMs;
  console.log(
    `authority signedFrames=${signedFrames} ackCommits=${ackCommits} ` +
    `signedFramesPerSec=${perSecond(signedFrames, propose.wallMs)} ` +
    `hubPaymentsPerSec=${perSecond(signedFrames, paymentMs)} ` +
    `tsAckBuildMs=${Math.round(buildMs)} workers=${workers} accounts=${accounts}`,
  );
  await client.shutdown();
};

await main();

// What the mutants over j/ left alive and what review of #116 found: a log is read as strictly as its event says, a
// reading is for one block by its hash, and the cursor holds against a lagging node.
import { describe, expect, test } from "bun:test";
import { err } from "../kernel/core/result.ts";
import { address, decodeLog, decodeLogs, type Bytes32, type RawLog } from "./log.ts";
import { observe, readingKey, readingsOf, type Reading } from "./observe.ts";
import { advance, prepare, watching, type Batch } from "./watch.ts";
import { blockOf, blocksBetween, DEPOSITORY, entityOf, hashOf, hexOf, logOf, must } from "./fixtures.ts";

// ids with hex letters in them: upper case is a different string only then
const LEFT = entityOf(0xabn);
const RIGHT = entityOf(0xcdn);
const words = (n: number): string => `0x${"00".repeat(32 * n)}`;
const upper = (t: Bytes32): Bytes32 => `0x${t.slice(2).toUpperCase()}` as Bytes32;

const adv = (block: bigint, index: bigint, epoch: bigint, fork = 0n) =>
  logOf("AccountEpochAdvanced", { left: LEFT, right: RIGHT, ondeltaEpoch: epoch }, block, index, fork);

const started = (block: bigint, index: bigint) => logOf("DisputeStarted", {
  sender: RIGHT, counterentity: LEFT, nonce: 7n, proposerIsLeft: true, proofbodyHash: hexOf(1n), watchSeed: hexOf(2n),
  starterInitialArguments: "0x", starterCounterArguments: "0x", starterCounterProofCommitment: hexOf(3n),
  disputeTimeout: 5n, disputeStartTimestamp: 6n, leftResponseSeconds: 60n, rightResponseSeconds: 60n,
}, block, index);

const countered = (block: bigint, index: bigint) => logOf("CounterDisputeRegistered", {
  sender: LEFT, counterentity: RIGHT, nonce: 9n, proposerIsLeft: false, proofbodyHash: hexOf(4n),
}, block, index);

const finalized = (block: bigint, index: bigint) => logOf("DisputeFinalized", {
  sender: RIGHT, counterentity: LEFT, nonce: 7n, finalProofbodyHash: hexOf(5n), finalizationEvidenceHash: hexOf(6n),
}, block, index);

const refused = (log: RawLog): boolean => !decodeLog(DEPOSITORY, log).ok;

const reading = (block: bigint, fork = 0n): Reading =>
  ({ block, blockHash: hashOf(block, fork), left: LEFT, right: RIGHT });

describe("j/strict how strictly a log is read", () => {
  test("R-WATCH-CLOSED a topic that is not lowercase bytes32 is a fault, not an event of Entities nobody hosts", () => {
    const good = adv(2n, 0n, 1n);
    const log: RawLog = { ...good, topics: [good.topics[0] as Bytes32, upper(LEFT), upper(RIGHT)] };
    expect(refused(log)).toBe(true);
    const fin = finalized(2n, 0n);
    const shout = (at: number) => ({ ...fin, topics: fin.topics.map((t, i) => (i === at ? upper(t) : t)) });
    [1, 2].forEach((at) => expect(refused(shout(at))).toBe(true));
  });

  test("R-WATCH-CLOSED a topic more than the event has is a fault, for each of the four events", () => {
    [adv(2n, 0n, 1n), started(2n, 0n), countered(2n, 0n), finalized(2n, 0n)].forEach((log) =>
      expect(refused({ ...log, topics: [...log.topics, LEFT] })).toBe(true));
  });

  test("R-WATCH-CLOSED data of the wrong length is a fault for a counter and a finalize, a word more or fewer", () => {
    [countered(2n, 0n), finalized(2n, 0n)].forEach((log) => {
      expect(refused({ ...log, data: words(1) })).toBe(true);
      expect(refused({ ...log, data: words(3) })).toBe(true);
      expect(refused({ ...log, data: words(2) })).toBe(false);
    });
  });

  test("R-WATCH-CLOSED a dispute start shorter than its slots is a fault, as is half a word", () => {
    const log = started(2n, 0n);
    expect(refused({ ...log, data: words(1) })).toBe(true);
    expect(refused({ ...log, data: words(11) })).toBe(true);
    expect(refused({ ...log, data: `${log.data}00` })).toBe(true);
    expect(refused({ ...log, data: `0x${log.data.slice(2, -1)}` })).toBe(true);
  });

  test("R-WATCH-CLOSED an address is exactly twenty bytes", () => {
    expect(address("0x01").ok).toBe(false);
    expect(address(`0x${"0".repeat(38)}`).ok).toBe(false);
  });
});

describe("j/strict what a reading is, and how it is held to the log", () => {
  const row = (block: bigint, epoch: bigint, nonce: bigint, fork = 0n) =>
    [readingKey(reading(block, fork)), { epoch, nonce }] as const;

  test("R-WATCH-TELL a reading names its block by number and hash, so the chain is asked for that block", () => {
    const events = must(decodeLogs(DEPOSITORY, [adv(2n, 0n, 1n)]));
    expect(readingsOf(events, [LEFT])).toEqual([reading(2n)]);
  });

  test("R-WATCH-TELL a row filed under another fork's block is no reading", () => {
    expect(readingKey(reading(2n))).not.toBe(readingKey(reading(2n, 1n)));
    const events = must(decodeLogs(DEPOSITORY, [adv(2n, 0n, 1n)]));
    expect(observe(events, [LEFT], new Map([row(2n, 1n, 5n, 1n)])).ok).toBe(false);
    expect(observe(events, [LEFT], new Map([row(2n, 1n, 5n)])).ok).toBe(true);
  });

  test("R-WATCH-TELL a finalize or a counter alone asks the chain for nothing", () => {
    const events = must(decodeLogs(DEPOSITORY, [finalized(2n, 0n), countered(2n, 1n)]));
    expect(readingsOf(events, [LEFT, RIGHT])).toEqual([]);
  });

  test("R-WATCH-TELL a reading behind the log is a fault as much as one ahead", () => {
    const events = must(decodeLogs(DEPOSITORY, [adv(4n, 0n, 3n)]));
    const behind = err({ _tag: "reading_off" as const, reading: reading(4n), logged: 3n, read: 2n });
    const ahead = err({ _tag: "reading_off" as const, reading: reading(4n), logged: 3n, read: 4n });
    expect(observe(events, [LEFT], new Map([row(4n, 2n, 5n)]))).toEqual(behind);
    expect(observe(events, [LEFT], new Map([row(4n, 4n, 5n)]))).toEqual(ahead);
  });
});

describe("j/strict the cursor and the head", () => {
  const w = must(watching(DEPOSITORY, 2n, blockOf(9n)));

  test("R-WATCH-DEPTH a head behind the cursor with no new blocks is an empty batch, not a fault", () => {
    const prepared = must(prepare(w, { head: 5n, blocks: [], logs: [] }));
    expect(must(advance(w, prepared, [LEFT], new Map())).watch).toEqual(w);
  });

  test("R-WATCH-DEPTH a head behind the cursor with a new block is too early", () => {
    const early: Batch = { head: 5n, blocks: [blockOf(10n)], logs: [] };
    expect(prepare(w, early)).toEqual(err({ _tag: "beyond_depth", block: 10n, finalized: 3n }));
  });

  test("R-WATCH-ORDER a log that names a block of the batch by its hash but claims another number is refused", () => {
    const base = must(watching(DEPOSITORY, 0n, blockOf(0n)));
    const liar: RawLog = { ...adv(2n, 0n, 1n), block: 3n };
    const batch: Batch = { head: 9n, blocks: blocksBetween(0n, 3n), logs: [liar] };
    expect(prepare(base, batch)).toEqual(err({ _tag: "log_without_block", block: 3n, index: 0n }));
  });
});

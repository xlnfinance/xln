import { describe, expect, test } from "bun:test";
import { err, ok } from "../kernel/core/result.ts";
import { tokenOf } from "../account/fixtures.ts";
import { bytes32, decodeLogs, type ChainEvent } from "./log.ts";
import { observe, readingKey, readingsOf, type Accounts, type Addressed, type Reading } from "./observe.ts";
import { bodyHashOf, DEPOSITORY, entityOf, hashOf, hexOf, logOf, must } from "./fixtures.ts";

/** The proof the started dispute of `started` opened with: its author and body hash. */
const OPENED = { proposerIsLeft: true, bodyHash: bodyHashOf(1n) } as const;

const LEFT = entityOf(0x11n);
const RIGHT = entityOf(0x52n);
const THIRD = entityOf(0x99n);

const advance = (block: bigint, index: bigint, epoch: bigint, left = LEFT, right = RIGHT) =>
  logOf("AccountEpochAdvanced", { left, right, ondeltaEpoch: epoch }, block, index);

const started = (block: bigint, index: bigint, sender = RIGHT, counterentity = LEFT) =>
  logOf("DisputeStarted", {
    sender, counterentity, nonce: 7n, proposerIsLeft: true, proofbodyHash: hexOf(1n), watchSeed: hexOf(2n),
    starterInitialArguments: "0x", starterCounterArguments: "0x", starterCounterProofCommitment: hexOf(3n),
    disputeTimeout: 5n, disputeStartTimestamp: 6n, leftResponseSeconds: 60n, rightResponseSeconds: 60n,
  }, block, index);

const countered = (block: bigint, index: bigint, sender = LEFT, counterentity = RIGHT) =>
  logOf("CounterDisputeRegistered", {
    sender, counterentity, nonce: 9n, proposerIsLeft: false, proofbodyHash: hexOf(4n),
  }, block, index);

const finalized = (block: bigint, index: bigint, sender = RIGHT, counterentity = LEFT) =>
  logOf("DisputeFinalized", {
    sender, counterentity, nonce: 7n, finalProofbodyHash: hexOf(5n), finalizationEvidenceHash: hexOf(6n),
  }, block, index);

const settled = (block: bigint, index: bigint, rows: readonly (readonly [bigint, bigint, bigint])[], left = LEFT) =>
  logOf("AccountSettled", {
    settled: [[left, RIGHT, rows.map(([token, collateral, ondelta]) =>
      [token, 1n, 2n, collateral, [0n, ondelta]]), 7n]],
  }, block, index);

const eventsOf = (...logs: Parameters<typeof decodeLogs>[1]): readonly ChainEvent[] =>
  must(decodeLogs(DEPOSITORY, logs));

type Row = readonly [string, { epoch: bigint; nonce: bigint }];

const readAt = (block: bigint, epoch: bigint, nonce: bigint, left = LEFT, right = RIGHT): Row =>
  [readingKey({ block, blockHash: hashOf(block), left, right }), { epoch, nonce }];

const accountsOf = (...rows: readonly Row[]): Accounts => new Map(rows);

const toward = (to: typeof LEFT, event: Addressed["event"]): Addressed => ({ to, event });

describe("j/observe", () => {
  test("R-WATCH-TELL an epoch advance is a j_epoch for each hosted party, with the nonce the chain stores", () => {
    const events = eventsOf(advance(2n, 3n, 1n));
    const accounts = accountsOf(readAt(2n, 1n, 5n));
    expect(observe(events, [LEFT, RIGHT], accounts)).toEqual(ok([
      toward(LEFT, { _tag: "j_epoch", peer: RIGHT, epoch: 1n, stored: 5n }),
      toward(RIGHT, { _tag: "j_epoch", peer: LEFT, epoch: 1n, stored: 5n }),
    ]));
  });

  test("R-WATCH-TELL the advance a finalize made carries the hash of the proof body the chain logged for it", () => {
    const events = eventsOf(advance(2n, 3n, 1n), started(2n, 4n, LEFT, RIGHT), finalized(2n, 5n));
    const accounts = accountsOf(readAt(2n, 1n, 5n));
    const [heard] = must(observe(events, [LEFT], accounts)).filter((a) => a.event._tag === "j_epoch");
    expect(heard).toEqual(
      toward(LEFT, { _tag: "j_epoch", peer: RIGHT, epoch: 1n, stored: 5n, finalBodyHash: bodyHashOf(5n) }),
    );
  });

  test("R-WATCH-TELL an advance with no finalize after it in its block, or one of another Account, has no hash", () => {
    const epochs = (...logs: Parameters<typeof decodeLogs>[1]) =>
      must(observe(eventsOf(...logs), [LEFT], accountsOf(readAt(2n, 1n, 5n))))
        .filter((a) => a.event._tag === "j_epoch");
    const plain = [toward(LEFT, { _tag: "j_epoch", peer: RIGHT, epoch: 1n, stored: 5n })];
    expect(epochs(advance(2n, 3n, 1n), finalized(3n, 0n))).toEqual(plain);
    expect(epochs(finalized(2n, 0n), advance(2n, 1n, 1n))).toEqual(plain);
    expect(epochs(advance(2n, 3n, 1n), finalized(2n, 5n, LEFT, THIRD))).toEqual(plain);
  });

  test("R-WATCH-TELL of two advances before a finalize in one block only the later one is the finalize's", () => {
    const events = eventsOf(advance(2n, 0n, 1n), advance(2n, 1n, 2n), finalized(2n, 2n));
    const heard = must(observe(events, [LEFT], accountsOf(readAt(2n, 2n, 5n))));
    expect(heard.map((a) => (a.event._tag === "j_epoch" ? a.event.finalBodyHash : "other")))
      .toEqual([undefined, bodyHashOf(5n), "other"]);
  });

  test("R-WATCH-TELL an Entity that is not hosted, or is not a party, hears nothing", () => {
    const events = eventsOf(advance(2n, 3n, 1n));
    const accounts = accountsOf(readAt(2n, 1n, 5n));
    expect(observe(events, [THIRD], accounts)).toEqual(ok([]));
    expect(observe(events, [], accounts)).toEqual(ok([]));
    expect(observe(events, [RIGHT], accounts)).toEqual(ok([
      toward(RIGHT, { _tag: "j_epoch", peer: LEFT, epoch: 1n, stored: 5n }),
    ]));
  });

  test("R-WATCH-TELL a dispute start is a j_dispute naming the side that started it, in the chain's epoch", () => {
    const accounts = accountsOf(readAt(3n, 4n, 7n));
    expect(observe(eventsOf(started(3n, 0n)), [LEFT, RIGHT], accounts)).toEqual(ok([
      toward(LEFT, { _tag: "j_dispute", peer: RIGHT, epoch: 4n, by: "right", nonce: 7n, timeout: 5n, ...OPENED }),
      toward(RIGHT, { _tag: "j_dispute", peer: LEFT, epoch: 4n, by: "right", nonce: 7n, timeout: 5n, ...OPENED }),
    ]));
    expect(observe(eventsOf(started(3n, 0n, LEFT, RIGHT)), [LEFT], accounts)).toEqual(ok([
      toward(LEFT, { _tag: "j_dispute", peer: RIGHT, epoch: 4n, by: "left", nonce: 7n, timeout: 5n, ...OPENED }),
    ]));
  });

  test("R-WATCH-TELL an event's epoch is the end-of-block epoch less the advances logged after it in the block", () => {
    const events = eventsOf(started(3n, 0n), advance(3n, 1n, 2n), started(3n, 2n));
    const accounts = accountsOf(readAt(3n, 2n, 8n));
    const heard = observe(events, [LEFT], accounts);
    expect(heard).toEqual(ok([
      toward(LEFT, { _tag: "j_dispute", peer: RIGHT, epoch: 1n, by: "right", nonce: 7n, timeout: 5n, ...OPENED }),
      toward(LEFT, { _tag: "j_epoch", peer: RIGHT, epoch: 2n, stored: 8n }),
      toward(LEFT, { _tag: "j_dispute", peer: RIGHT, epoch: 2n, by: "right", nonce: 7n, timeout: 5n, ...OPENED }),
    ]));
  });

  test("R-WATCH-TELL an advance of another Account in the same block does not move this Account's epoch", () => {
    const events = eventsOf(started(3n, 0n), advance(3n, 1n, 5n, LEFT, THIRD));
    const accounts = accountsOf(readAt(3n, 4n, 7n), readAt(3n, 5n, 1n, LEFT, THIRD));
    expect(observe(events, [LEFT], accounts)).toEqual(ok([
      toward(LEFT, { _tag: "j_dispute", peer: RIGHT, epoch: 4n, by: "right", nonce: 7n, timeout: 5n, ...OPENED }),
      toward(LEFT, { _tag: "j_epoch", peer: THIRD, epoch: 5n, stored: 1n }),
    ]));
  });

  // The title is a register killer from before R-DISPUTE-WATCH: only the registrar was told then; the peer is now too.
  test("R-WATCH-TELL a finalize is a j_dispute_over for each hosted party; a counter only for its registrar", () => {
    expect(observe(eventsOf(finalized(4n, 0n)), [LEFT, RIGHT], accountsOf())).toEqual(ok([
      toward(LEFT, { _tag: "j_dispute_over", peer: RIGHT }),
      toward(RIGHT, { _tag: "j_dispute_over", peer: LEFT }),
    ]));
    expect(observe(eventsOf(countered(4n, 0n)), [LEFT], accountsOf())).toEqual(ok([
      toward(LEFT, { _tag: "j_countered", peer: RIGHT, nonce: 9n, proposerIsLeft: false, bodyHash: bodyHashOf(4n) }),
    ]));
  });

  test("R-WATCH-STALL a finalize held back is told late, after its advance, with its secrets just ahead of it", () => {
    const logs = eventsOf(advance(4n, 0n, 1n), finalized(4n, 1n));
    const moved = logs[0] ?? expect.unreachable("no advance");
    const final = logs[1] ?? expect.unreachable("no finalize");
    const read = { ...final, shown: { _tag: "read", secrets: [must(bytes32(hexOf(8n)))] } } as ChainEvent;
    const accounts = accountsOf(readAt(4n, 1n, 5n));
    const context = [moved, read];
    const order = (told: readonly ChainEvent[], late: ReadonlySet<ChainEvent>) =>
      must(observe(told, [LEFT], accounts, { context, late })).map((a) => a.event)
        .map((event) => (event._tag === "j_dispute_over" ? `${event._tag}:${event.late === true}` : event._tag));
    expect(order(context, new Set())).toEqual(["j_secret", "j_epoch", "j_dispute_over:false"]);
    expect(order([read], new Set([read]))).toEqual(["j_secret", "j_dispute_over:true"]);
  });

  test("R-DISPUTE-WATCH a counter is a j_countered for each hosted party and not the end of the dispute", () => {
    expect(observe(eventsOf(countered(4n, 0n)), [LEFT, RIGHT], accountsOf())).toEqual(ok([
      toward(LEFT, { _tag: "j_countered", peer: RIGHT, nonce: 9n, proposerIsLeft: false, bodyHash: bodyHashOf(4n) }),
      toward(RIGHT, { _tag: "j_countered", peer: LEFT, nonce: 9n, proposerIsLeft: false, bodyHash: bodyHashOf(4n) }),
    ]));
  });

  test("R-DISPUTE-FREEZE a revealed secret is a j_secret for every hosted Entity and asks no reading", () => {
    const shown = logOf("SecretRevealed", { hashlock: hexOf(7n), revealer: THIRD, secret: hexOf(8n) }, 4n, 0n);
    const events = eventsOf(shown, advance(4n, 1n, 1n));
    expect(readingsOf(events, [])).toEqual([]);
    const secret = must(bytes32(hexOf(8n)));
    expect(observe(events.slice(0, 1), [LEFT, THIRD], accountsOf())).toEqual(ok([
      toward(LEFT, { _tag: "j_secret", secret }),
      toward(THIRD, { _tag: "j_secret", secret }),
    ]));
    expect(observe(events.slice(0, 1), [], accountsOf())).toEqual(ok([]));
  });

  test("R-WATCH-TELL a reading that is missing is a fault, and so is one that contradicts the log's epoch", () => {
    const reading: Reading = { block: 2n, blockHash: hashOf(2n), left: LEFT, right: RIGHT };
    expect(observe(eventsOf(advance(2n, 0n, 1n)), [LEFT], accountsOf())).toEqual(err({ _tag: "no_reading", reading }));
    expect(observe(eventsOf(started(2n, 0n)), [LEFT], accountsOf())).toEqual(err({ _tag: "no_reading", reading }));
    expect(observe(eventsOf(advance(2n, 0n, 1n)), [LEFT], accountsOf(readAt(2n, 3n, 5n)))).toEqual(
      err({ _tag: "reading_off", reading, logged: 1n, read: 3n }),
    );
  });

  test("R-WATCH-TELL readings are asked only for what a hosted Entity needs, once each, in event order", () => {
    const events = eventsOf(
      advance(2n, 0n, 1n), started(2n, 1n), advance(2n, 2n, 2n, LEFT, THIRD), finalized(2n, 3n), countered(2n, 4n),
    );
    expect(readingsOf(events, [LEFT])).toEqual([
      { block: 2n, blockHash: hashOf(2n), left: LEFT, right: RIGHT },
      { block: 2n, blockHash: hashOf(2n), left: LEFT, right: THIRD },
    ]);
    expect(readingsOf(events, [THIRD])).toEqual([{ block: 2n, blockHash: hashOf(2n), left: LEFT, right: THIRD }]);
    expect(readingsOf(events, [])).toEqual([]);
  });

  test("R-J-COLLATERAL an AccountSettled is a j_collateral per token for each hosted party, no reading needed", () => {
    const events = eventsOf(settled(5n, 0n, [[1n, 100n, 100n], [3n, 7n, 0n]]));
    expect(readingsOf(events, [LEFT, RIGHT])).toEqual([]);
    expect(observe(events, [LEFT, RIGHT], accountsOf())).toEqual(ok([
      toward(LEFT, { _tag: "j_collateral", peer: RIGHT, token: tokenOf(1n), collateral: 100n, ondelta: 100n }),
      toward(LEFT, { _tag: "j_collateral", peer: RIGHT, token: tokenOf(3n), collateral: 7n, ondelta: 0n }),
      toward(RIGHT, { _tag: "j_collateral", peer: LEFT, token: tokenOf(1n), collateral: 100n, ondelta: 100n }),
      toward(RIGHT, { _tag: "j_collateral", peer: LEFT, token: tokenOf(3n), collateral: 7n, ondelta: 0n }),
    ]));
    expect(observe(events, [RIGHT], accountsOf())).toEqual(ok([
      toward(RIGHT, { _tag: "j_collateral", peer: LEFT, token: tokenOf(1n), collateral: 100n, ondelta: 100n }),
      toward(RIGHT, { _tag: "j_collateral", peer: LEFT, token: tokenOf(3n), collateral: 7n, ondelta: 0n }),
    ]));
    expect(observe(events, [THIRD], accountsOf())).toEqual(ok([]));
  });

  test("R-J-COLLATERAL the snapshots of one Account stay in the chain's order among its other events", () => {
    const events = eventsOf(
      settled(5n, 0n, [[1n, 100n, 100n]]), advance(5n, 1n, 1n), settled(5n, 2n, [[1n, 90n, 90n]]),
    );
    const heard = observe(events, [LEFT], accountsOf(readAt(5n, 1n, 6n)));
    expect(heard.ok && heard.value.map(({ event }) => (event._tag === "j_collateral" ? event.collateral : event._tag)))
      .toEqual([100n, "j_epoch", 90n]);
  });
});

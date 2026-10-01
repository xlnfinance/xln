import { describe, expect, test } from "bun:test";
import { err, ok } from "../kernel/core/result.ts";
import { decodeLogs, type ChainEvent } from "./log.ts";
import { observe, readingKey, readingsOf, type Accounts, type Addressed, type Reading } from "./observe.ts";
import { DEPOSITORY, entityOf, hexOf, logOf, must } from "./fixtures.ts";

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

const eventsOf = (...logs: Parameters<typeof decodeLogs>[1]): readonly ChainEvent[] =>
  must(decodeLogs(DEPOSITORY, logs));

type Row = readonly [string, { epoch: bigint; nonce: bigint }];

const readAt = (block: bigint, epoch: bigint, nonce: bigint, left = LEFT, right = RIGHT): Row =>
  [readingKey({ block, left, right }), { epoch, nonce }];

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
      toward(LEFT, { _tag: "j_dispute", peer: RIGHT, epoch: 4n, by: "right" }),
      toward(RIGHT, { _tag: "j_dispute", peer: LEFT, epoch: 4n, by: "right" }),
    ]));
    expect(observe(eventsOf(started(3n, 0n, LEFT, RIGHT)), [LEFT], accounts)).toEqual(ok([
      toward(LEFT, { _tag: "j_dispute", peer: RIGHT, epoch: 4n, by: "left" }),
    ]));
  });

  test("R-WATCH-TELL an event's epoch is the end-of-block epoch less the advances logged after it in the block", () => {
    const events = eventsOf(started(3n, 0n), advance(3n, 1n, 2n), started(3n, 2n));
    const accounts = accountsOf(readAt(3n, 2n, 8n));
    const heard = observe(events, [LEFT], accounts);
    expect(heard).toEqual(ok([
      toward(LEFT, { _tag: "j_dispute", peer: RIGHT, epoch: 1n, by: "right" }),
      toward(LEFT, { _tag: "j_epoch", peer: RIGHT, epoch: 2n, stored: 8n }),
      toward(LEFT, { _tag: "j_dispute", peer: RIGHT, epoch: 2n, by: "right" }),
    ]));
  });

  test("R-WATCH-TELL an advance of another Account in the same block does not move this Account's epoch", () => {
    const events = eventsOf(started(3n, 0n), advance(3n, 1n, 5n, LEFT, THIRD));
    const accounts = accountsOf(readAt(3n, 4n, 7n), readAt(3n, 5n, 1n, LEFT, THIRD));
    expect(observe(events, [LEFT], accounts)).toEqual(ok([
      toward(LEFT, { _tag: "j_dispute", peer: RIGHT, epoch: 4n, by: "right" }),
      toward(LEFT, { _tag: "j_epoch", peer: THIRD, epoch: 5n, stored: 1n }),
    ]));
  });

  test("R-WATCH-TELL a finalize is a j_dispute_over for each hosted party; a counter only for its registrar", () => {
    expect(observe(eventsOf(finalized(4n, 0n)), [LEFT, RIGHT], accountsOf())).toEqual(ok([
      toward(LEFT, { _tag: "j_dispute_over", peer: RIGHT }),
      toward(RIGHT, { _tag: "j_dispute_over", peer: LEFT }),
    ]));
    expect(observe(eventsOf(countered(4n, 0n)), [LEFT, RIGHT], accountsOf())).toEqual(ok([
      toward(LEFT, { _tag: "j_dispute_over", peer: RIGHT }),
    ]));
  });

  test("R-WATCH-TELL a reading that is missing is a fault, and so is one that contradicts the log's epoch", () => {
    const reading: Reading = { block: 2n, left: LEFT, right: RIGHT };
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
      { block: 2n, left: LEFT, right: RIGHT }, { block: 2n, left: LEFT, right: THIRD },
    ]);
    expect(readingsOf(events, [THIRD])).toEqual([{ block: 2n, left: LEFT, right: THIRD }]);
    expect(readingsOf(events, [])).toEqual([]);
  });
});

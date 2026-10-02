import { describe, expect, test } from "bun:test";
import { ok } from "../../kernel/core/result.ts";
import type { Bytes32 } from "../log.ts";
import { decodeLogs } from "../log.ts";
import { observe, type Accounts, type Addressed } from "../observe.ts";
import { calldataWanted, withCalldata, type Prepared } from "../watch.ts";
import {
  argumentsOf, blockOf, bodyHashOf, DEPOSITORY, entityOf, finalizedOf, finalizeInput, finalizeOp, hexOf, logOf, must,
  patched, txOf,
} from "../fixtures.ts";

const LEFT = entityOf(0x11n);
const RIGHT = entityOf(0x52n);
const THIRD = entityOf(0x99n);

const SECRET = entityOf(0xa1n);
const OTHER_SECRET = entityOf(0xb2n);

const advance = (block: bigint, index: bigint, epoch: bigint) =>
  logOf("AccountEpochAdvanced", { left: LEFT, right: RIGHT, ondeltaEpoch: epoch }, block, index);

const started = (block: bigint, index: bigint, initial: readonly string[]) =>
  logOf("DisputeStarted", {
    sender: RIGHT, counterentity: LEFT, nonce: 7n, proposerIsLeft: true, proofbodyHash: hexOf(1n),
    watchSeed: hexOf(2n), starterInitialArguments: argumentsOf(initial), starterCounterArguments: "0x",
    starterCounterProofCommitment: hexOf(3n), disputeTimeout: 5n, disputeStartTimestamp: 6n,
    leftResponseSeconds: 60n, rightResponseSeconds: 60n,
  }, block, index);

const preparedOf = (...logs: Parameters<typeof decodeLogs>[1]): Prepared =>
  ({ last: blockOf(2n), events: must(decodeLogs(DEPOSITORY, logs)) });

const accounts: Accounts = new Map([[`2:${blockOf(2n).hash}:${LEFT}:${RIGHT}`, { epoch: 1n, nonce: 5n }]]);

const toward = (to: Bytes32, event: Addressed["event"]): Addressed => ({ to, event });

const TX = txOf(2n, 9n);

describe("j/shown", () => {
  test("R-WATCH-CALLDATA a finalize's secrets are told to every hosted Entity before the epoch advance it made", () => {
    const op = finalizeOp({ otherArguments: argumentsOf([SECRET]) });
    const inputs = new Map([[TX, finalizeInput(RIGHT, [op])]]);
    const read = withCalldata(preparedOf(advance(2n, 0n, 1n), finalizedOf(op, 2n, 1n, TX)), inputs);
    expect(observe(read.events, [LEFT, THIRD], accounts)).toEqual(ok([
      toward(LEFT, { _tag: "j_secret", secret: SECRET }),
      toward(THIRD, { _tag: "j_secret", secret: SECRET }),
      toward(LEFT, { _tag: "j_epoch", peer: RIGHT, epoch: 1n, stored: 5n, finalBodyHash: bodyHashOf(5n) }),
      toward(LEFT, { _tag: "j_dispute_over", peer: RIGHT }),
    ]));
  });

  test("R-WATCH-CALLDATA the starter's arguments at a finalize are shown too, and the op is found among others", () => {
    const mine = finalizeOp({ starterArguments: argumentsOf([OTHER_SECRET]) });
    const input = finalizeInput(RIGHT, [finalizeOp({ finalNonce: 99n, otherArguments: argumentsOf([SECRET]) }), mine]);
    const read = withCalldata(preparedOf(advance(2n, 0n, 1n), finalizedOf(mine, 2n, 1n, TX)), new Map([[TX, input]]));
    const told = must(observe(read.events, [LEFT], accounts));
    const shown = told.filter((a) => a.event._tag === "j_secret");
    expect(shown).toEqual([toward(LEFT, { _tag: "j_secret", secret: OTHER_SECRET })]);
  });

  test("R-WATCH-CALLDATA a finalize with no advance before it tells its own secrets, just ahead of itself", () => {
    const op = finalizeOp({ otherArguments: argumentsOf([SECRET]) });
    const read = withCalldata(preparedOf(finalizedOf(op, 2n, 1n, TX)), new Map([[TX, finalizeInput(RIGHT, [op])]]));
    expect(observe(read.events, [LEFT], accounts)).toEqual(ok([
      toward(LEFT, { _tag: "j_secret", secret: SECRET }),
      toward(LEFT, { _tag: "j_dispute_over", peer: RIGHT }),
    ]));
  });

  test("R-WATCH-CALLDATA a dispute start's secrets are told ahead of the dispute, with no input needed", () => {
    const prepared = preparedOf(started(2n, 0n, [SECRET]));
    expect(calldataWanted(prepared)).toEqual([]);
    const told = must(observe(prepared.events, [LEFT], accounts));
    expect(told.map((a) => a.event._tag)).toEqual(["j_secret", "j_dispute"]);
    expect(told[0]).toEqual(toward(LEFT, { _tag: "j_secret", secret: SECRET }));
  });

  test("R-WATCH-CALLDATA the Host is asked for the input of each transaction that carried a finalize, once", () => {
    const op = finalizeOp();
    const other = txOf(2n, 7n);
    const prepared = preparedOf(
      advance(2n, 0n, 1n), started(2n, 1n, []), finalizedOf(op, 2n, 2n, TX), finalizedOf(op, 2n, 3n, TX),
      finalizedOf(op, 2n, 4n, other),
    );
    expect(calldataWanted(prepared)).toEqual([TX, other]);
  });

  test("R-WATCH-CALLDATA a finalize whose input cannot be read is told to its parties and shows no secret", () => {
    const op = finalizeOp({ otherArguments: argumentsOf([SECRET]) });
    const wrapped = patched(finalizeInput(RIGHT, [op]), 0, Uint8Array.of(0xca, 0xfe, 0xba, 0xbe));
    const missing = withCalldata(preparedOf(advance(2n, 0n, 1n), finalizedOf(op, 2n, 1n, TX)), new Map());
    const odd = withCalldata(preparedOf(advance(2n, 0n, 1n), finalizedOf(op, 2n, 1n, TX)), new Map([[TX, wrapped]]));
    const absent = withCalldata(
      preparedOf(advance(2n, 0n, 1n), finalizedOf(op, 2n, 1n, TX)),
      new Map([[TX, finalizeInput(RIGHT, [finalizeOp({ finalNonce: 99n })])]]),
    );
    [missing, odd, absent].forEach((read) => {
      const told = must(observe(read.events, [LEFT, THIRD], accounts));
      expect(told.map((a) => a.event._tag)).toEqual(["j_epoch", "j_dispute_over", "j_finalize_unread"]);
      expect(told.at(-1)).toEqual(toward(LEFT, { _tag: "j_finalize_unread", peer: RIGHT }));
    });
  });

  test("R-WATCH-CALLDATA a finalize the Host has not asked about says nothing of its arguments", () => {
    const op = finalizeOp();
    const told = must(observe(preparedOf(advance(2n, 0n, 1n), finalizedOf(op, 2n, 1n, TX)).events, [LEFT], accounts));
    expect(told.map((a) => a.event._tag)).toEqual(["j_epoch", "j_dispute_over"]);
  });
});

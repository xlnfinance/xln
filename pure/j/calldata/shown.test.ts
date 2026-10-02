import { describe, expect, test } from "bun:test";
import { ok } from "../../kernel/core/result.ts";
import type { Bytes32 } from "../log.ts";
import { decodeLogs } from "../log.ts";
import type { Carried } from "./decode.ts";
import { observe, type Accounts, type Addressed } from "../observe.ts";
import { calldataWanted, withCalldata, type Prepared } from "../watch.ts";
import {
  argumentsOf, blockOf, bodyHashOf, CLAUSED, DEPOSITORY, direct, entityOf, finalizedOf, finalizeInput, finalizeOp,
  hexOf,
  logOf, must, patched, startInput, startOp, txOf,
} from "../fixtures.ts";
import { proofBodyHash } from "../../chain/proof/proof.ts";

const LEFT = entityOf(0x11n);
const RIGHT = entityOf(0x52n);
const THIRD = entityOf(0x99n);

const SECRET = entityOf(0xa1n);
const OTHER_SECRET = entityOf(0xb2n);

const advance = (block: bigint, index: bigint, epoch: bigint) =>
  logOf("AccountEpochAdvanced", { left: LEFT, right: RIGHT, ondeltaEpoch: epoch }, block, index);

const started = (block: bigint, index: bigint, initial: readonly string[], proofbodyHash = hexOf(1n)) =>
  logOf("DisputeStarted", {
    sender: RIGHT, counterentity: LEFT, nonce: 7n, proposerIsLeft: true, proofbodyHash,
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
    const inputs = new Map([[TX, [direct(finalizeInput(RIGHT, [op]))]]]);
    const read = withCalldata(preparedOf(advance(2n, 0n, 1n), finalizedOf(op, 2n, 1n, TX)), inputs);
    expect(observe(read.events, [LEFT, THIRD], accounts)).toEqual(ok([
      toward(LEFT, { _tag: "j_secret", secret: SECRET }),
      toward(THIRD, { _tag: "j_secret", secret: SECRET }),
      toward(LEFT, { _tag: "j_epoch", peer: RIGHT, epoch: 1n, stored: 5n, finalBodyHash: bodyHashOf(5n) }),
      toward(LEFT, { _tag: "j_dispute_over", peer: RIGHT }),
    ]));
  });

  test("R-WATCH-CALLDATA the starter's arguments at a finalize are shown too", () => {
    const mine = finalizeOp({ starterArguments: argumentsOf([OTHER_SECRET]) });
    const input = finalizeInput(RIGHT, [mine]);
    const prepared = preparedOf(advance(2n, 0n, 1n), finalizedOf(mine, 2n, 1n, TX));
    const read = withCalldata(prepared, new Map([[TX, [direct(input)]]]));
    const told = must(observe(read.events, [LEFT], accounts));
    const shown = told.filter((a) => a.event._tag === "j_secret");
    expect(shown).toEqual([toward(LEFT, { _tag: "j_secret", secret: OTHER_SECRET })]);
  });

  test("R-WATCH-CALLDATA a finalize with no advance before it tells its own secrets, just ahead of itself", () => {
    const op = finalizeOp({ otherArguments: argumentsOf([SECRET]) });
    const inputs = new Map([[TX, [direct(finalizeInput(RIGHT, [op]))]]]);
    const read = withCalldata(preparedOf(finalizedOf(op, 2n, 1n, TX)), inputs);
    expect(observe(read.events, [LEFT], accounts)).toEqual(ok([
      toward(LEFT, { _tag: "j_secret", secret: SECRET }),
      toward(LEFT, { _tag: "j_dispute_over", peer: RIGHT }),
    ]));
  });

  test("R-WATCH-CALLDATA a dispute start's secrets are told ahead of the dispute, with no input needed", () => {
    const prepared = preparedOf(started(2n, 0n, [SECRET]));
    const told = must(observe(prepared.events, [LEFT], accounts));
    expect(told.map((a) => a.event._tag)).toEqual(["j_secret", "j_dispute"]);
    expect(told[0]).toEqual(toward(LEFT, { _tag: "j_secret", secret: SECRET }));
  });

  test("R-WATCH-CALLDATA the Host is asked once for the input of each transaction of a hosted dispute", () => {
    const op = finalizeOp();
    const other = txOf(2n, 7n);
    const prepared = preparedOf(
      advance(2n, 0n, 1n), started(2n, 1n, []), finalizedOf(op, 2n, 2n, TX), finalizedOf(op, 2n, 3n, TX),
      finalizedOf(op, 2n, 4n, other),
    );
    expect(calldataWanted(prepared, [LEFT])).toEqual([txOf(2n, 1n), TX, other]);
    expect(calldataWanted(prepared, [RIGHT])).toEqual([txOf(2n, 1n), TX, other]);
    expect(calldataWanted(prepared, [THIRD])).toEqual([]);
  });

  const HASH = must(proofBodyHash(CLAUSED));
  const opened = (inputs: ReadonlyMap<Bytes32, readonly Carried[]>, hosted = LEFT) =>
    must(observe(withCalldata(preparedOf(started(2n, 0n, [], HASH)), inputs).events, [hosted], accounts));
  const START_TX = txOf(2n, 0n);

  test("R-WATCH-CALLDATA the body a start carried is told with the dispute, read from its transaction's input", () => {
    const told = opened(new Map([[START_TX, [direct(startInput(RIGHT, [startOp(CLAUSED)]))]]]));
    expect(told.map((a) => a.event._tag)).toEqual(["j_dispute"]);
    expect(told[0]?.event).toMatchObject({ _tag: "j_dispute", bodyHash: HASH, body: CLAUSED });
  });

  test("R-WATCH-CALLDATA a start whose input has no op with the logged hash is told with no body, and unread", () => {
    const lying = startInput(RIGHT, [startOp(CLAUSED, { proofbodyHash: hexOf(77n) })]);
    const wrapped = patched(startInput(RIGHT, [startOp(CLAUSED)]), 0, Uint8Array.of(0xca, 0xfe, 0xba, 0xbe));
    [new Map(), new Map([[START_TX, [direct(lying)]]]), new Map([[START_TX, [direct(wrapped)]]])].forEach((inputs) => {
      const told = opened(inputs);
      expect(told.map((a) => a.event._tag)).toEqual(["j_dispute", "j_start_unread"]);
      expect(told[0]?.event).not.toHaveProperty("body");
      expect(told[1]).toEqual(toward(LEFT, { _tag: "j_start_unread", peer: RIGHT, tx: START_TX }));
    });
  });

  test("R-WATCH-CALLDATA a start of the hosted Entity's own that cannot be read is no notice: it needs no body", () => {
    const told = opened(new Map(), RIGHT);
    expect(told.map((a) => a.event._tag)).toEqual(["j_dispute"]);
  });

  test("R-WATCH-CALLDATA a finalize whose input cannot be read is told to its parties and shows no secret", () => {
    const op = finalizeOp({ otherArguments: argumentsOf([SECRET]) });
    const wrapped = patched(finalizeInput(RIGHT, [op]), 0, Uint8Array.of(0xca, 0xfe, 0xba, 0xbe));
    const missing = withCalldata(preparedOf(advance(2n, 0n, 1n), finalizedOf(op, 2n, 1n, TX)), new Map());
    const finalized = preparedOf(advance(2n, 0n, 1n), finalizedOf(op, 2n, 1n, TX));
    const odd = withCalldata(finalized, new Map([[TX, [direct(wrapped)]]]));
    const absent = withCalldata(
      preparedOf(advance(2n, 0n, 1n), finalizedOf(op, 2n, 1n, TX)),
      new Map([[TX, [direct(finalizeInput(RIGHT, [finalizeOp({ finalNonce: 99n })]))]]]),
    );
    [missing, odd, absent].forEach((read) => {
      const told = must(observe(read.events, [LEFT, THIRD], accounts));
      expect(told.map((a) => a.event._tag)).toEqual(["j_epoch", "j_dispute_over", "j_finalize_unread"]);
      expect(told.at(-1)).toEqual(toward(LEFT, { _tag: "j_finalize_unread", peer: RIGHT, tx: TX }));
    });
  });

  test("R-WATCH-CALLDATA a finalize the Host has not asked about says nothing of its arguments", () => {
    const op = finalizeOp();
    const told = must(observe(preparedOf(advance(2n, 0n, 1n), finalizedOf(op, 2n, 1n, TX)).events, [LEFT], accounts));
    expect(told.map((a) => a.event._tag)).toEqual(["j_epoch", "j_dispute_over"]);
  });
});

import { describe, expect, test } from "bun:test";
import type { FinalDisputeProof } from "../../chain/batch/batch.ts";
import { wordAt } from "../../kernel/encoding/abi-read.ts";
import { bytesToHex, hexToBytes } from "../../kernel/encoding/bytes.ts";
import { finalizedSecrets, finalizesIn, secretsIn, startedSecrets } from "./decode.ts";
import {
  argumentsOf, entityOf, evidenceOf, finalizeInput, finalizeOp, hexOf, logOf, must, patched,
} from "../fixtures.ts";

const LEFT = entityOf(0x11n);
const RIGHT = entityOf(0x52n);

const SECRET_A = entityOf(0xa1n);
const SECRET_B = entityOf(0xb2n);
const SECRET_C = entityOf(0xc3n);

const bytesOf = (hex: string): Uint8Array => must(hexToBytes(hex));

const inputOf = (ops: readonly FinalDisputeProof[]): Uint8Array => finalizeInput(RIGHT, ops);

describe("j/calldata", () => {
  test("R-WATCH-CALLDATA the secrets of an Arguments blob are read in order, and none from what is not one", () => {
    expect(secretsIn(bytesOf(argumentsOf([SECRET_A, SECRET_B])))).toEqual([SECRET_A, SECRET_B]);
    expect(secretsIn(bytesOf(argumentsOf([])))).toEqual([]);
    expect(secretsIn(new Uint8Array())).toEqual([]);
    expect(secretsIn(bytesOf(argumentsOf([SECRET_A])).subarray(0, 100))).toEqual([]);
    const huge = bytesOf(`0x${"ff".repeat(96)}`);
    expect(secretsIn(huge)).toEqual([]);
    const lying = patched(bytesOf(argumentsOf([SECRET_A])), 160, bytesOf(hexOf(1n << 40n)));
    expect(secretsIn(lying)).toEqual([]);
  });

  test("R-WATCH-CALLDATA a dispute start shows the secrets of both its blobs, each once", () => {
    const log = logOf("DisputeStarted", {
      sender: RIGHT, counterentity: LEFT, nonce: 7n, proposerIsLeft: true, proofbodyHash: hexOf(1n),
      watchSeed: hexOf(2n), starterInitialArguments: argumentsOf([SECRET_A, SECRET_B]),
      starterCounterArguments: argumentsOf([SECRET_B, SECRET_C]), starterCounterProofCommitment: hexOf(3n),
      disputeTimeout: 5n, disputeStartTimestamp: 6n, leftResponseSeconds: 60n, rightResponseSeconds: 60n,
    }, 3n, 0n);
    expect(startedSecrets(log.data)).toEqual([SECRET_A, SECRET_B, SECRET_C]);
    expect(startedSecrets("0x")).toEqual([]);
  });

  test("R-WATCH-CALLDATA a processBatch input gives each finalize op with the evidence hash the chain logs", () => {
    const first = finalizeOp({ otherArguments: argumentsOf([SECRET_A]) });
    const second = finalizeOp({ finalNonce: 9n, starterArguments: argumentsOf([SECRET_B]) });
    const found = finalizesIn(inputOf([first, second]));
    expect(found.map((f) => f.evidence)).toEqual([evidenceOf(first), evidenceOf(second)]);
    expect(found.map((f) => secretsIn(f.otherArguments))).toEqual([[SECRET_A], []]);
    expect(found.map((f) => secretsIn(f.starterArguments))).toEqual([[], [SECRET_B]]);
  });

  test("R-WATCH-CALLDATA an input that is not a processBatch call, or is cut short, has no finalize ops", () => {
    const input = inputOf([finalizeOp()]);
    expect(finalizesIn(patched(input, 0, Uint8Array.of(0xde, 0xad, 0xbe, 0xef)))).toEqual([]);
    expect(finalizesIn(input.subarray(0, 60))).toEqual([]);
    expect(finalizesIn(new Uint8Array())).toEqual([]);
  });

  test("R-WATCH-CALLDATA a finalize count the input has no room for gives no ops, and no list is built for it", () => {
    const input = inputOf([finalizeOp()]);
    const counted = (bytesToHex(input).indexOf(LEFT.slice(2)) - 2) / 2 - 2 * 32;
    expect(wordAt(input, counted)).toBe(1n);
    expect(finalizesIn(patched(input, counted, bytesOf(hexOf(1n << 40n))))).toEqual([]);
  });

  test("R-WATCH-CALLDATA the secrets of a finalize are those of the op whose evidence hash was logged", () => {
    const mine = finalizeOp({ otherArguments: argumentsOf([SECRET_A]), starterArguments: argumentsOf([SECRET_B]) });
    const theirs = finalizeOp({ finalNonce: 9n, otherArguments: argumentsOf([SECRET_C]) });
    const input = inputOf([theirs, mine]);
    expect(finalizedSecrets(input, evidenceOf(mine))).toEqual([SECRET_B, SECRET_A]);
    expect(finalizedSecrets(input, evidenceOf(finalizeOp({ finalNonce: 99n })))).toBeUndefined();
    expect(finalizedSecrets(inputOf([]), evidenceOf(mine))).toBeUndefined();
  });
});

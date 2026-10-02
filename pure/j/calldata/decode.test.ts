import { describe, expect, test } from "bun:test";
import type { FinalDisputeProof } from "../../chain/batch/batch.ts";
import { wordAt } from "../../kernel/encoding/abi-read.ts";
import { bytesToHex, hexToBytes } from "../../kernel/encoding/bytes.ts";
import { finalizedSecrets, finalizesIn, secretsIn, startedBody, startedSecrets } from "./decode.ts";
import { proofBodyHash } from "../../chain/proof/proof.ts";
import {
  argumentsOf, CLAUSED, entityOf, evidenceOf, finalizeInput, finalizeOp, hexOf, logOf, must, patched, startInput,
  startOp,
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

  const hashOf = (body: typeof CLAUSED) => must(bytes32Of(must(proofBodyHash(body))));
  const bytes32Of = (hash: string) => ({ ok: true, value: hash as ReturnType<typeof entityOf> }) as const;
  const other = { ...CLAUSED, offdeltas: [5n], transformers: [] };

  test("R-WATCH-CALLDATA the body a start carried is read back whole: signs, wide numbers, clauses, allowances", () => {
    const input = startInput(RIGHT, [startOp(CLAUSED)]);
    expect(startedBody(input, hashOf(CLAUSED))).toStrictEqual(CLAUSED);
  });

  test("R-WATCH-CALLDATA of several start ops the one whose hash the chain logged is the one read", () => {
    const input = startInput(RIGHT, [startOp(other), startOp(CLAUSED), startOp(other, { nonce: 9n })]);
    expect(startedBody(input, hashOf(CLAUSED))).toStrictEqual(CLAUSED);
    expect(startedBody(input, hashOf(other))).toStrictEqual(other);
    expect(startedBody(input, entityOf(99n))).toBeUndefined();
  });

  test("R-WATCH-CALLDATA a start that names a hash its body does not make gives no body", () => {
    const lying = startInput(RIGHT, [startOp(other, { proofbodyHash: hashOf(CLAUSED) })]);
    expect(startedBody(lying, hashOf(CLAUSED))).toBeUndefined();
  });

  test("R-WATCH-CALLDATA an input that is no processBatch call, or is cut short, gives no body", () => {
    const input = startInput(RIGHT, [startOp(CLAUSED)]);
    expect(startedBody(patched(input, 0, Uint8Array.of(0xde, 0xad, 0xbe, 0xef)), hashOf(CLAUSED))).toBeUndefined();
    expect(startedBody(input.subarray(0, 300), hashOf(CLAUSED))).toBeUndefined();
    expect(startedBody(new Uint8Array(), hashOf(CLAUSED))).toBeUndefined();
    expect(startedBody(finalizeInput(RIGHT, [finalizeOp()]), hashOf(CLAUSED))).toBeUndefined();
  });

  test("R-WATCH-CALLDATA a start count the input has no room for gives no body and builds no list", () => {
    const input = startInput(RIGHT, [startOp(CLAUSED)]);
    const call = input.subarray(4);
    const batch = call.subarray(Number(wordAt(call, 32)) + 32);
    const head = Number(wordAt(batch, 0));
    const countAt = 4 + Number(wordAt(call, 32)) + 32 + head + Number(wordAt(batch, head + 5 * 32));
    expect(wordAt(input, countAt)).toBe(1n);
    expect(startedBody(patched(input, countAt, bytesOf(hexOf(1n << 40n))), hashOf(CLAUSED))).toBeUndefined();
  });

  test("R-WATCH-CALLDATA whatever is written over the input, a body is read only if its hash is the one named", () => {
    const input = startInput(RIGHT, [startOp(CLAUSED)]);
    const garbage = Uint8Array.from({ length: 32 }, () => 0xff);
    const reads = Array.from({ length: Math.floor(input.length / 16) }, (_, i) =>
      startedBody(patched(input, i * 16, garbage), hashOf(CLAUSED)));
    const text = (body: unknown): string => JSON.stringify(body, (_, v) => (typeof v === "bigint" ? `${v}` : v));
    expect(reads.filter((read) => read !== undefined && text(read) !== text(CLAUSED))).toEqual([]);
    expect(reads.filter((read) => read === undefined).length).toBeGreaterThan(0);
  });
});

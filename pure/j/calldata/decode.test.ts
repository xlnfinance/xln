import { describe, expect, test } from "bun:test";
import type { FinalDisputeProof } from "../../chain/batch/batch.ts";
import { wordAt } from "../../kernel/encoding/abi-read.ts";
import { bytesToHex, hexToBytes } from "../../kernel/encoding/bytes.ts";
import { finalizedSecrets, finalizesIn, secretsIn, startedBody, startedSecrets } from "./decode.ts";
import { proofBodyHash } from "../../chain/proof/proof.ts";
import {
  argumentListOf, argumentsOf, argumentTupleOf, CLAUSED, entityOf, evidenceOf, finalizeInput, finalizeOp, hexOf, logOf,
  must, patched, startInput, startOp, towerInput,
} from "../fixtures.ts";

const LEFT = entityOf(0x11n);
const RIGHT = entityOf(0x52n);

const SECRET_A = entityOf(0xa1n);
const SECRET_B = entityOf(0xb2n);
const SECRET_C = entityOf(0xc3n);

const bytesOf = (hex: string): Uint8Array => must(hexToBytes(hex));

const inputOf = (ops: readonly FinalDisputeProof[]): Uint8Array => finalizeInput(RIGHT, ops);

/**
 * What the contract's own test encoder makes of one clause showing the secret 0xa1 (the dispute tests of the contracts,
 * Depository-part-1, `starterInitialArguments`): `abi.encode(['bytes[]'], [[abi.encode(tuple(uint16[] fillRatios,
 * bytes32[] secrets))]])`, with a fill ratio of 5000. The Depository reads exactly this layout
 * (`decodeTransformerArgumentListStrict`).
 */
const CONTRACT_BLOB = "0x"
  + "0000000000000000000000000000000000000000000000000000000000000020"
  + "0000000000000000000000000000000000000000000000000000000000000001"
  + "0000000000000000000000000000000000000000000000000000000000000020"
  + "00000000000000000000000000000000000000000000000000000000000000e0"
  + "0000000000000000000000000000000000000000000000000000000000000020"
  + "0000000000000000000000000000000000000000000000000000000000000040"
  + "0000000000000000000000000000000000000000000000000000000000000080"
  + "0000000000000000000000000000000000000000000000000000000000000001"
  + "0000000000000000000000000000000000000000000000000000000000001388"
  + "0000000000000000000000000000000000000000000000000000000000000001"
  + "00000000000000000000000000000000000000000000000000000000000000a1";

describe("j/calldata", () => {
  test("R-WATCH-CALLDATA a blob is the contract's `abi.encode(bytes[])`, as its own test encoder makes it", () => {
    expect(argumentsOf([SECRET_A])).toBe(CONTRACT_BLOB);
    expect(secretsIn(bytesOf(CONTRACT_BLOB))).toEqual([SECRET_A]);
  });

  test("R-WATCH-CALLDATA every clause's secrets are read in order, each once, and none from what is not a blob", () => {
    expect(secretsIn(bytesOf(argumentListOf([SECRET_A, SECRET_B], [], [SECRET_B, SECRET_C])))).toEqual(
      [SECRET_A, SECRET_B, SECRET_C],
    );
    expect(secretsIn(bytesOf(argumentsOf([])))).toEqual([]);
    expect(secretsIn(bytesOf(argumentListOf()))).toEqual([]);
    expect(secretsIn(new Uint8Array())).toEqual([]);
    expect(secretsIn(bytesOf(argumentsOf([SECRET_A])).subarray(0, 100))).toEqual([]);
    expect(secretsIn(bytesOf(`0x${"ff".repeat(96)}`))).toEqual([]);
  });

  test("R-WATCH-CALLDATA the bare Arguments tuple, which the chain does not read, shows no secret", () => {
    expect(secretsIn(bytesOf(argumentTupleOf([SECRET_A])))).toEqual([]);
  });

  test("R-WATCH-CALLDATA a count or an offset the blob has no room for gives no secret, and builds no list", () => {
    const blob = bytesOf(argumentsOf([SECRET_A]));
    expect(secretsIn(patched(blob, 32, bytesOf(hexOf(1n << 40n))))).toEqual([]);
    expect(secretsIn(patched(blob, 0, bytesOf(hexOf(1n << 40n))))).toEqual([]);
    const element = 32 + 32 + 32;
    expect(secretsIn(patched(blob, element + 32 + 32 + 32, bytesOf(hexOf(1n << 40n))))).toEqual([]);
  });

  test("R-WATCH-CALLDATA a blob past what the contract accepts, or clauses past a body's most, are not read", () => {
    const blob = bytesOf(argumentsOf([SECRET_A]));
    expect(secretsIn(Uint8Array.from({ length: 64 * 1024 }, (_, i) => blob[i] ?? 0))).toEqual([SECRET_A]);
    expect(secretsIn(Uint8Array.from({ length: 64 * 1024 + 1 }, (_, i) => blob[i] ?? 0))).toEqual([]);
    const clauses = Array.from({ length: 33 }, (_, i) => [entityOf(BigInt(i + 1))]);
    expect(secretsIn(bytesOf(argumentListOf(...clauses)))).toEqual(clauses.slice(0, 32).flat());
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

  test("R-WATCH-CALLDATA a processBatch input gives its finalize op with the evidence hash the chain logs", () => {
    const op = finalizeOp({ otherArguments: argumentsOf([SECRET_A]), starterArguments: argumentsOf([SECRET_B]) });
    const found = finalizesIn(inputOf([op]));
    expect(found.map((f) => f.evidence)).toEqual([evidenceOf(op)]);
    expect(found.map((f) => secretsIn(f.otherArguments))).toEqual([[SECRET_A]]);
    expect(found.map((f) => secretsIn(f.starterArguments))).toEqual([[SECRET_B]]);
  });

  test("R-WATCH-CALLDATA a batch with more finalizations than the Depository accepts is not read", () => {
    const ops = [finalizeOp(), finalizeOp({ finalNonce: 9n })];
    expect(finalizesIn(inputOf(ops))).toEqual([]);
    expect(finalizedSecrets(inputOf(ops), evidenceOf(finalizeOp()))).toBeUndefined();
  });

  test("R-WATCH-CALLDATA an input past the most a transaction can carry is not read", () => {
    const op = finalizeOp({ otherArguments: argumentsOf([SECRET_A]) });
    const input = inputOf([op]);
    expect(finalizesIn(Uint8Array.from({ length: 1024 * 1024 }, (_, i) => input[i] ?? 0)).length).toBe(1);
    expect(finalizesIn(Uint8Array.from({ length: 1024 * 1024 + 1 }, (_, i) => input[i] ?? 0))).toEqual([]);
  });

  test("R-WATCH-CALLDATA a tower's counter-dispute call finalizes with an empty signature in its evidence", () => {
    const op = finalizeOp({ otherArguments: argumentsOf([SECRET_A]), sig: "0x" });
    const signed = finalizeOp({ otherArguments: argumentsOf([SECRET_A]), sig: `0x${"cd".repeat(65)}` });
    const input = towerInput(LEFT, signed);
    const found = finalizesIn(input);
    expect(found.map((f) => f.evidence)).toEqual([evidenceOf(op)]);
    expect(finalizedSecrets(input, evidenceOf(op))).toEqual([SECRET_A]);
    expect(finalizedSecrets(input, evidenceOf(signed))).toBeUndefined();
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
    const input = inputOf([mine]);
    expect(finalizedSecrets(input, evidenceOf(mine))).toEqual([SECRET_B, SECRET_A]);
    expect(finalizedSecrets(input, evidenceOf(finalizeOp({ finalNonce: 99n })))).toBeUndefined();
    expect(finalizedSecrets(inputOf([]), evidenceOf(mine))).toBeUndefined();
  });

  const clause = CLAUSED.transformers[0] ?? expect.unreachable("no clause");
  const allowance = clause.allowances[0] ?? expect.unreachable("no allowance");
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

  test("R-WATCH-CALLDATA more starts, tokens or clauses than the contract accepts give no body", () => {
    const hashedAs = (body: typeof CLAUSED) => startedBody(startInput(RIGHT, [startOp(body)]), hashOf(body));
    const tokens = (n: number) => Array.from({ length: n }, (_, i) => BigInt(i + 1));
    const manyTokens = (n: number) => ({ ...other, tokenIds: tokens(n), offdeltas: tokens(n).map(() => 0n) });
    expect(hashedAs(manyTokens(128))).toStrictEqual(manyTokens(128));
    expect(hashedAs(manyTokens(129))).toBeUndefined();
    const clauses = (n: number) => ({ ...other, transformers: Array.from({ length: n }, () => clause) });
    expect(hashedAs(clauses(32))).toStrictEqual(clauses(32));
    expect(hashedAs(clauses(33))).toBeUndefined();
    const starts = (n: number) =>
      startInput(RIGHT, Array.from({ length: n }, (_, i) => startOp(other, { nonce: BigInt(i + 1) })));
    expect(startedBody(starts(8), hashOf(other))).toStrictEqual(other);
    expect(startedBody(starts(9), hashOf(other))).toBeUndefined();
  });

  test("R-WATCH-CALLDATA a start input past the most a transaction can carry gives no body", () => {
    const input = startInput(RIGHT, [startOp(CLAUSED)]);
    const padded = (length: number) => Uint8Array.from({ length }, (_, i) => input[i] ?? 0);
    expect(startedBody(padded(1024 * 1024), hashOf(CLAUSED))).toStrictEqual(CLAUSED);
    expect(startedBody(padded(1024 * 1024 + 1), hashOf(CLAUSED))).toBeUndefined();
  });

  test("R-WATCH-CALLDATA a body whose clauses carry more bytes or allowances than accepted is no body", () => {
    const heavy = (bytes: number) =>
      ({ ...other, transformers: [{ ...clause, encodedBatch: `0x${"ab".repeat(bytes)}` }] });
    const read = (body: typeof CLAUSED) => startedBody(startInput(RIGHT, [startOp(body)]), hashOf(body));
    expect(read(heavy(100_000))).toStrictEqual(heavy(100_000));
    expect(read(heavy(176 * 1024 + 1))).toBeUndefined();
    const allowed = (n: number) => ({
      ...other, transformers: [{ ...clause, allowances: Array.from({ length: n }, () => allowance) }],
    });
    expect(read(allowed(128))).toStrictEqual(allowed(128));
    expect(read(allowed(129))).toBeUndefined();
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

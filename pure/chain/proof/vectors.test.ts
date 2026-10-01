// The chain encoders against contracts/vectors: every value there was produced by the fork's deployed bytecode.
//
// functions.json is what the pure encoders in the contracts return for sample arguments (small: every slot 7, wide:
// every slot at its type's limit, mixed: a different value in every slot, so a swap of two slots changes the output).
// lifecycle.json is one Account run through the real Depository, with the batch bytes it accepted and the hashes it
// emitted. Nothing here is computed by the code under test and compared with itself.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import { bytesToHex, hexToBytes } from "../../kernel/encoding/bytes.ts";
import { unwrapOr, type Result } from "../../kernel/core/result.ts";
import { deployment, accountKey } from "./deployment.ts";
import { encodeDeltaBatch, type DeltaBatch } from "../batch/clauses.ts";
import { argumentsCommitment, counterProofCommitment, disputeRecordHash, finalizationEvidenceHash } from "./dispute.ts";
import type { SettlementDiff } from "../money.ts";
import {
  accountMessageHash, accountMessagePayload, batchHash, batchPayloadUnder, type AccountMessage,
} from "./payload.ts";
import { proofBodyBytes, proofBodyHash, type ProofBody } from "./proof.ts";

const committed = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../../contracts/vectors/${name}.json`, import.meta.url), "utf8"));
type Vector = { function: string; label: string; args: any[]; returnData: string; decoded: any };
const vectorsFor = (fn: string): Vector[] => {
  const found = committed("functions").vectors.filter((v: Vector) => v.function.startsWith(`${fn}(`));
  expect(found.length).toBeGreaterThan(0);
  return found;
};
const must = <T, E>(r: Result<T, E>): T => unwrapOr(r, (e) => expect.unreachable(JSON.stringify(e)));
const coder = ethers.AbiCoder.defaultAbiCoder();
/** The `bytes` a codec function returns, as hex. */
const returnedBytes = (v: Vector): string => ethers.hexlify(coder.decode(["bytes"], v.returnData)[0] as string);

// ---- vector JSON to the encoders' types ----

const bodyOf = (j: any): ProofBody => ({
  watchSeed: j.watchSeed,
  leftResponseSeconds: BigInt(j.leftResponseSeconds),
  rightResponseSeconds: BigInt(j.rightResponseSeconds),
  offdeltas: j.offdeltas.map((o: any) => (BigInt(o.high) << 256n) + BigInt(o.low)),
  tokenIds: j.tokenIds.map(BigInt),
  transformers: j.transformers.map((t: any) => ({
    transformerAddress: t.transformerAddress,
    encodedBatch: t.encodedBatch,
    allowances: t.allowances.map((a: any) => ({
      deltaIndex: BigInt(a.deltaIndex),
      rightAllowance: BigInt(a.rightAllowance),
      leftAllowance: BigInt(a.leftAllowance),
    })),
  })),
});
const signed = (a: { negative: boolean; magnitude: string }): bigint =>
  (a.negative ? -BigInt(a.magnitude) : BigInt(a.magnitude));
const diffOf = (d: any): SettlementDiff => ({
  tokenId: BigInt(d.tokenId), leftDiff: signed(d.leftDiff), rightDiff: signed(d.rightDiff),
  collateralDiff: signed(d.collateralDiff), ondeltaDiff: signed(d.ondeltaDiff),
});
const deployed = (chainId: string, depository: string) => must(deployment(BigInt(chainId), depository));

describe("R-J2 proof body (HankoCodec.proofBodyHash)", () => {
  test("every sample: the body hash equals the contract's, including the contract-produced clause", () => {
    vectorsFor("proofBodyHash").forEach((v) => {
      expect(must(proofBodyHash(bodyOf(v.args[0])))).toBe(v.returnData);
    });
  });
  test("the body bytes are what the hash is taken over", () => {
    const body = bodyOf(vectorsFor("proofBodyHash")[0]!.args[0]);
    expect(ethers.keccak256(bytesToHex(must(proofBodyBytes(body))))).toBe(must(proofBodyHash(body)));
  });
  test("a response window past uint32 is refused before it is signed", () => {
    const body = { ...bodyOf(vectorsFor("proofBodyHash")[0]!.args[0]), leftResponseSeconds: 1n << 32n };
    expect(proofBodyHash(body)).toEqual({ ok: false, error: { _tag: "out_of_range", type: "uint32" } });
  });
});

describe("R-J2 transformer clause payload (DeltaTransformer.encodeBatch)", () => {
  test("small and wide samples equal the contract's bytes", () => {
    vectorsFor("encodeBatch").forEach((v) => {
      const j = v.args[0];
      const batch: DeltaBatch = {
        payments: j.payment.map((p: any) => ({
          deltaIndex: BigInt(p.deltaIndex), amount: signed(p.amount),
          revealedUntilTimestamp: BigInt(p.revealedUntilTimestamp), hash: p.hash,
        })),
        swaps: j.swap.map((s: any) => ({
          ownerIsLeft: s.ownerIsLeft, addDeltaIndex: BigInt(s.addDeltaIndex), addAmount: BigInt(s.addAmount),
          subDeltaIndex: BigInt(s.subDeltaIndex), subAmount: BigInt(s.subAmount),
        })),
        pulls: j.pull.map((p: any) => ({
          deltaIndex: BigInt(p.deltaIndex), amount: signed(p.amount), claimedRatio: BigInt(p.claimedRatio),
          fullHash: p.fullHash, partialRoot: p.partialRoot, targetRole: p.targetRole,
        })),
      };
      expect(must(encodeDeltaBatch(batch))).toBe(returnedBytes(v));
    });
  });
});

/** The two Account messages with their contract vectors: each vector's own arguments, for each function is sampled
 * separately. */
const disputeProofOf = (v: Vector) => {
  const [chainId, depository, key, ondeltaEpoch, nonce, proposerIsLeft, body, watchSeed] = v.args;
  const message: AccountMessage = { _tag: "dispute_proof", proposerIsLeft, proofBodyHash: body, watchSeed };
  const at = { accountKey: key, ondeltaEpoch: BigInt(ondeltaEpoch), nonce: BigInt(nonce) };
  return { d: deployed(chainId, depository), at, message };
};
const cooperativeUpdateOf = (v: Vector) => {
  const [chainId, depository, key, ondeltaEpoch, nonce, diffs, forgive] = v.args;
  const message: AccountMessage = {
    _tag: "cooperative_update", diffs: diffs.map(diffOf), forgiveDebtsInTokenIds: forgive.map(BigInt),
  };
  const at = { accountKey: key, ondeltaEpoch: BigInt(ondeltaEpoch), nonce: BigInt(nonce) };
  return { d: deployed(chainId, depository), at, message };
};

describe("R-J2 Account messages (HankoEncoding.sol: encodeDisputeProof, encodeCooperativeUpdate)", () => {
  test("dispute proof: payload and hash equal the contract's for small, wide and mixed", () => {
    vectorsFor("encodeDisputeProofHankoPayloadForDomain").forEach((v) => {
      const { d, at, message } = disputeProofOf(v);
      expect(bytesToHex(must(accountMessagePayload(d, at, message)))).toBe(returnedBytes(v));
    });
    vectorsFor("computeDisputeProofHankoHashForDomain").forEach((v) => {
      const { d, at, message } = disputeProofOf(v);
      expect(must(accountMessageHash(d, at, message))).toBe(v.returnData);
    });
  });

  test("cooperative update: payload and hash equal the contract's for small, wide and mixed", () => {
    vectorsFor("encodeCooperativeUpdateHankoPayloadForDomain").forEach((v) => {
      const { d, at, message } = cooperativeUpdateOf(v);
      expect(bytesToHex(must(accountMessagePayload(d, at, message)))).toBe(returnedBytes(v));
    });
    vectorsFor("computeCooperativeUpdateHankoHashForDomain").forEach((v) => {
      const { d, at, message } = cooperativeUpdateOf(v);
      expect(must(accountMessageHash(d, at, message))).toBe(v.returnData);
    });
  });

  test("C1 the mixed sample has a distinct chain id, epoch and nonce, so swapping epoch and nonce fails", () => {
    ["computeDisputeProofHankoHashForDomain", "computeCooperativeUpdateHankoHashForDomain"].forEach((fn) => {
      const mixed = vectorsFor(fn).find((v) => v.label === "mixed")!;
      const [chainId, , , epoch, nonce] = mixed.args;
      expect(new Set([chainId, epoch, nonce]).size).toBe(3);
    });
  });

  test("C1 the epoch is bound: a different epoch is a different digest", () => {
    const mixed = vectorsFor("computeDisputeProofHankoHashForDomain").find((x) => x.label === "mixed")!;
    const { d, at, message } = disputeProofOf(mixed);
    expect(must(accountMessageHash(d, { ...at, ondeltaEpoch: at.ondeltaEpoch + 1n }, message)))
      .not.toBe(must(accountMessageHash(d, at, message)));
  });
});

describe("R-J2 batch payload (HankoEncoding.encodeBatch) and the hashes the Depository emitted", () => {
  test("the packed payload equals the contract's under the codec's sample separator", () => {
    vectorsFor("encodeBatchHankoPayloadForDomain").forEach((v) => {
      const [separator, chainId, depository, entityId, encodedBatch, nonce] = v.args;
      const packed = batchPayloadUnder(separator, deployed(chainId, depository), entityId, encodedBatch, BigInt(nonce));
      expect(bytesToHex(must(packed))).toBe(returnedBytes(v));
    });
  });

  test("batchHash equals the batchHash the deployed Depository emitted for each lifecycle batch", () => {
    const l = committed("lifecycle");
    const d = deployed(l.chainId, l.depository);
    [l.deposit, l.settle, l.disputeStart, l.disputeFinalize].forEach((b) => {
      expect(must(batchHash(d, b.entityId, b.encodedBatch, BigInt(b.entityNonce)))).toBe(b.batchHashEmitted);
    });
  });

  test("C2 the same batch for another Entity or nonce is another digest", () => {
    const l = committed("lifecycle");
    const d = deployed(l.chainId, l.depository);
    const b = l.settle;
    const base = must(batchHash(d, b.entityId, b.encodedBatch, BigInt(b.entityNonce)));
    expect(must(batchHash(d, l.right, b.encodedBatch, BigInt(b.entityNonce)))).not.toBe(base);
    expect(must(batchHash(d, b.entityId, b.encodedBatch, BigInt(b.entityNonce) + 1n))).not.toBe(base);
  });
});

describe("R-J2 the account key", () => {
  test("lifecycle: the key is the two entity ids, lesser first", () => {
    const l = committed("lifecycle");
    expect(must(accountKey(l.left, l.right))).toBe(l.accountKey.toLowerCase());
    expect(must(accountKey(l.right, l.left))).toBe(l.accountKey.toLowerCase());
  });
  test("a key needs two bytes32 ids", () => {
    expect(accountKey("0x12", `0x${"11".repeat(32)}`)).toEqual({ ok: false, error: { _tag: "not_bytes32" } });
  });
});

describe("R-J2 dispute hashes (Account.sol, HankoCodec)", () => {
  test("counterProofCommitment equals the contract's for small, wide and mixed", () => {
    vectorsFor("counterProofCommitment").forEach((v) => {
      const [nonce, proposerIsLeft, hash] = v.args;
      const commitment = counterProofCommitment({ nonce: BigInt(nonce), proposerIsLeft, proofBodyHash: hash });
      expect(must(commitment)).toBe(v.returnData);
    });
  });

  test("the dispute record hash equals Account.encodeDisputeHash for small and wide", () => {
    vectorsFor("encodeDisputeHash").forEach((v) => {
      const [
        nonce, startedByLeft, initialProposerIsLeft, timeout, left, right, proofBodyHashValue, start, initial, counter,
        commitment,
      ] = v.args;
      const record = {
        nonce: BigInt(nonce), startedByLeft, initialProposerIsLeft, timeout: BigInt(timeout),
        leftResponseSeconds: BigInt(left), rightResponseSeconds: BigInt(right), proofBodyHash: proofBodyHashValue,
        startTimestamp: BigInt(start), starterInitialArguments: initial, starterCounterArguments: counter,
        starterCounterProofCommitment: commitment,
      };
      expect(must(disputeRecordHash(record))).toBe(v.decoded[0]);
    });
  });

  test("lifecycle: the hash the Account stored at dispute start", () => {
    const { disputeStart: s } = committed("lifecycle");
    const record = {
      nonce: 7n, startedByLeft: false, initialProposerIsLeft: true, timeout: BigInt(s.disputeTimeout),
      leftResponseSeconds: 60n, rightResponseSeconds: 60n, proofBodyHash: s.proofBodyHash,
      startTimestamp: BigInt(s.startTimestamp), starterInitialArguments: "0x", starterCounterArguments: "0x",
      starterCounterProofCommitment: `0x${"00".repeat(32)}`,
    };
    expect(must(disputeRecordHash(record))).toBe(s.disputeHashStored);
  });

  test("argument commitments bind the side and the start time", () => {
    const at = { args: "0x01", startedByLeft: false, startTimestamp: 7n };
    const base = must(argumentsCommitment(at));
    expect(must(argumentsCommitment({ ...at, startedByLeft: true }))).not.toBe(base);
    expect(must(argumentsCommitment({ ...at, startTimestamp: 8n }))).not.toBe(base);
  });

  test("lifecycle: the finalization evidence hash equals the one DisputeFinalized emitted", () => {
    const { disputeFinalize: f } = committed("lifecycle");
    const finalized = f.events.find((e: { name: string }) => e.name === "DisputeFinalized");
    const evidence = {
      initialProofBodyHash: finalized.args.initialProofbodyHash ?? finalized.args.finalProofbodyHash,
      finalNonce: 7n, proposerIsLeft: true, startedByLeft: false,
      starterArguments: "0x", otherArguments: "0x", sig: "0x",
    };
    expect(must(finalizationEvidenceHash(evidence))).toBe(finalized.args.finalizationEvidenceHash);
    expect(must(finalizationEvidenceHash(evidence))).toBe(f.finalizationEvidenceHashExpected);
  });
});

describe("hex helpers used by the vectors", () => {
  test("the lifecycle's hex is lowercase, even length and parses", () => {
    const l = committed("lifecycle");
    [l.deposit, l.settle, l.disputeStart, l.disputeFinalize].forEach((b) => {
      expect(hexToBytes(b.encodedBatch).ok).toBe(true);
    });
  });
});

describe("R-J2 dispute hashes with a different value in every slot (re-derived with ethers from Account.sol)", () => {
  // The committed vectors sample encodeDisputeHash with equal response windows and the lifecycle finalizes with empty
  // arguments, so a swap of the two windows, or of the three evidence hashes, is invisible there. These samples make
  // every slot distinct. They are the test author's reading of the packed layout, not contract output: a mixed
  // contract-produced vector is owed to the contracts thread.
  const word = (n: number): string => ethers.zeroPadValue(ethers.toBeHex(n), 32);
  const record = {
    nonce: 11n, startedByLeft: true, initialProposerIsLeft: false, timeout: 1_700_000_013n,
    leftResponseSeconds: 61n, rightResponseSeconds: 62n, proofBodyHash: word(3), startTimestamp: 1_700_000_005n,
    starterInitialArguments: "0x0a0b", starterCounterArguments: "0x0c0d0e", starterCounterProofCommitment: word(9),
  };
  const commitment = (args: string): string =>
    ethers.keccak256(coder.encode(["bytes", "bool", "uint256"], [args, record.startedByLeft, record.startTimestamp]));

  test("the stored hash: packed in the contract's order, with its two argument commitments", () => {
    const expected = ethers.keccak256(ethers.solidityPacked(
      ["uint256", "bool", "bool", "uint256", "uint32", "uint32", "bytes32", "uint256", "bytes32", "bytes32", "bytes32",
        "uint256", "bytes32", "bool"],
      [record.nonce, record.startedByLeft, record.initialProposerIsLeft, record.timeout, record.leftResponseSeconds,
        record.rightResponseSeconds, record.proofBodyHash, record.startTimestamp,
        commitment(record.starterInitialArguments),
        commitment(record.starterCounterArguments), record.starterCounterProofCommitment,
        0n, ethers.ZeroHash, false]));
    expect(must(disputeRecordHash(record))).toBe(expected);
  });

  test("the finalization evidence: three different hashes in the contract's order", () => {
    const evidence = {
      initialProofBodyHash: word(5), finalNonce: 13n, proposerIsLeft: true, startedByLeft: false,
      starterArguments: "0x0102", otherArguments: "0x030405", sig: "0x060708090a",
    };
    const hashOf = (hex: string): string => ethers.keccak256(hex);
    const expected = ethers.keccak256(coder.encode(
      ["bytes32", "uint256", "bool", "bool", "bytes32", "bytes32", "bytes32"],
      [evidence.initialProofBodyHash, evidence.finalNonce, evidence.proposerIsLeft, evidence.startedByLeft,
        hashOf(evidence.starterArguments), hashOf(evidence.otherArguments), hashOf(evidence.sig)]));
    expect(must(finalizationEvidenceHash(evidence))).toBe(expected);
  });
});

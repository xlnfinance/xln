// What the J tests share: entity ids and ops with the fields a test does not care about filled in, the deployed
// Depository's ABI and lifecycle vectors turned into raw logs, and a chain of blocks with hashes. Only tests import
// this.
import { readFileSync } from "node:fs";
import { AbiCoder, Interface } from "ethers";
import { expect } from "bun:test";
import { Depository__factory } from "../../contracts/typechain-types/factories/Depository.sol/Depository__factory.ts";
import { unwrapOr, type Result } from "../kernel/core/result.ts";
import { emptyBatch, encodeBatch, type FinalDisputeProof, type InitialDisputeProof } from "../chain/batch/batch.ts";
import { finalizationEvidenceHash } from "../chain/proof/dispute.ts";
import { proofBodyHash, type ProofBody } from "../chain/proof/proof.ts";
import { hexToBytes } from "../kernel/encoding/bytes.ts";
import type { SettlementDiff } from "../chain/money.ts";
import { seal, type JBatch, type SealContext, type SealOutcome } from "./batch/jbatch.ts";
import type { SealedBatch } from "./batch/sealed.ts";
import type { Gas, Simulation } from "./gas/simulate.ts";
import { address, bytes32, type Address, type Bytes32, type RawLog } from "./log.ts";
import type { JOp } from "./op/ops.ts";
import type { Treasury } from "./plan/funded.ts";
import type { Block } from "./watch.ts";

const hexWord = (n: number, width: number): string => n.toString(16).padStart(width, "0");

/** A 32-byte entity id: the number `n` in the last byte, so ids order the way their numbers do. */
export const idOf = (n: number): string => `0x${hexWord(n, 64)}`;

const ZERO_WORD = idOf(0);
const SIG = `0x${"11".repeat(65)}`;
const TOKEN_ADDRESS = `0x${"22".repeat(20)}`;

export const ME = idOf(5);
export const LEFT_PEER = idOf(2);
export const RIGHT_PEER = idOf(9);
export const TOKEN = 1n;

/** The ops at these positions of a list: a position that is not there is a broken test. */
export const pick = (ops: readonly JOp[], ...at: readonly number[]): readonly JOp[] =>
  at.map((i) => ops[i] ?? expect.unreachable(`no op at ${i}`));

export const holdings = (...rows: readonly (readonly [bigint, bigint, bigint])[]): Treasury =>
  new Map(rows.map(([tokenId, reserve, debt]) => [tokenId, { reserve, debt }] as const));

export const deposit = (amount: bigint, tokenId = TOKEN): JOp => ({
  _tag: "deposit",
  leg: {
    entity: ZERO_WORD, contractAddress: TOKEN_ADDRESS, externalTokenId: 0n, tokenType: 0n, internalTokenId: tokenId,
    amount,
  },
});

export const reserveToReserve = (amount: bigint, to = RIGHT_PEER, tokenId = TOKEN): JOp =>
  ({ _tag: "reserve_to_reserve", transfer: { receivingEntity: to, tokenId, amount } });

export const reserveToExternal = (amount: bigint, tokenId = TOKEN): JOp =>
  ({ _tag: "reserve_to_external", withdrawal: { receivingEntity: idOf(7), tokenId, amount } });

/** `me` funds the Account with `peer`; one pair per amount. */
export const fund = (peer: string, ...amounts: readonly bigint[]): JOp => ({
  _tag: "reserve_to_collateral",
  funding: { tokenId: TOKEN, receivingEntity: ME, pairs: amounts.map((amount) => ({ entity: peer, amount })) },
});

/** `me` funds `count` different Accounts in one funding: several counterparties, so no Account's group takes it. */
export const fundSpread = (count: number, firstPeer = 100): JOp => ({
  _tag: "reserve_to_collateral",
  funding: {
    tokenId: TOKEN, receivingEntity: ME,
    pairs: Array.from({ length: count }, (_, i) => ({ entity: idOf(firstPeer + i), amount: 1n })),
  },
});

export const withdraw = (peer: string, amount: bigint, nonce = 1n): JOp => ({
  _tag: "collateral_to_reserve",
  withdrawal: { counterparty: peer, tokenId: TOKEN, amount, nonce, sig: SIG },
});

const diffOf = (tokenId: bigint, leftDiff: bigint, rightDiff: bigint): SettlementDiff =>
  ({ tokenId, leftDiff, rightDiff, collateralDiff: -(leftDiff + rightDiff), ondeltaDiff: 0n });

/** A settlement of `me` with `peer`: `mine` is the change of my own reserve, the collateral takes the opposite. */
export const settle = (peer: string, mine: bigint, nonce = 1n): JOp => {
  const meIsLeft = BigInt(ME) < BigInt(peer);
  return {
    _tag: "settle",
    settlement: {
      leftEntity: meIsLeft ? ME : peer, rightEntity: meIsLeft ? peer : ME,
      diffs: [meIsLeft ? diffOf(TOKEN, mine, 0n) : diffOf(TOKEN, 0n, mine)],
      forgiveDebtsInTokenIds: [], sig: SIG, nonce,
    },
  };
};

const body: ProofBody = {
  watchSeed: ZERO_WORD, leftResponseSeconds: 60n, rightResponseSeconds: 60n, offdeltas: [0n], tokenIds: [TOKEN],
  transformers: [],
};

export const start = (peer: string, nonce = 1n): JOp => ({
  _tag: "dispute_start",
  start: {
    counterentity: peer, nonce, ondeltaEpoch: 0n, proposerIsLeft: true, proofbodyHash: ZERO_WORD,
    initialProofbody: body,
    watchSeed: ZERO_WORD, sig: SIG, starterInitialArguments: "0x", starterCounterArguments: "0x",
    starterCounterProofCommitment: ZERO_WORD,
  },
});

export const counter = (peer: string, counterNonce = 3n): JOp => ({
  _tag: "dispute_counter",
  counter: {
    counterentity: peer, initialNonce: 1n, initialProofbodyHash: ZERO_WORD, counterNonce, proposerIsLeft: false,
    counterProofbody: body, sig: SIG,
  },
});

export const finalize = (peer: string, finalNonce = 1n): JOp => ({
  _tag: "dispute_finalize",
  finalization: {
    counterentity: peer, initialNonce: 1n, finalNonce, proposerIsLeft: true, initialProofbodyHash: ZERO_WORD,
    finalProofbody: body, starterArguments: "0x", otherArguments: "0x", sig: SIG, startedByLeft: true,
    cooperative: false,
  },
});

export const reveal = (n = 1): JOp =>
  ({ _tag: "reveal_secret", reveal: { transformer: TOKEN_ADDRESS, secret: idOf(n) } });

/** A mainnet-like chain: the transaction gas cap of EIP-7825 and the outer Hanko check of a small board. */
export const GAS: Gas = { txGasCap: 16_777_216n, prelude: 100_000n };

export const APPLY_GAS = 700_000n;

const succeeds = (): Simulation["outcome"] => ({ _tag: "ok", applyGas: APPLY_GAS });

/** The Host's loop: answer each simulation `seal` asks for with `answer`, until it asks for no more. */
export const drive = (
  j: JBatch, ctx: SealContext, answer: (candidate: SealedBatch) => Simulation["outcome"] = succeeds,
): SealOutcome => {
  const outcome = seal(j, ctx);
  if (outcome._tag !== "simulate") return outcome;
  const simulated = { digest: outcome.candidate.digest, outcome: answer(outcome.candidate) };
  return drive(j, { ...ctx, answers: [...ctx.answers, simulated] }, answer);
};

/** A dispute start whose proof body carries `kib` KiB of clause bytes, under the contract's per-body limit. */
export const bigStart = (peer: string, nonce: bigint, kib: number): JOp => {
  const op = start(peer, nonce);
  const clause = { transformerAddress: TOKEN_ADDRESS, encodedBatch: `0x${"ab".repeat(kib * 1024)}`, allowances: [] };
  return op._tag === "dispute_start"
    ? { ...op, start: { ...op.start, initialProofbody: { ...op.start.initialProofbody, transformers: [clause] } } }
    : op;
};

export const DEPOSITORY_ABI = new Interface(Depository__factory.abi);

/** Lowercase hex of a number, padded to `bytes` bytes. */
export const hexOf = (n: bigint, bytes = 32): string => `0x${n.toString(16).padStart(bytes * 2, "0")}`;

export const must = <T, E>(made: Result<T, E>): T =>
  unwrapOr(made, (fault) => expect.unreachable(`fixture: ${JSON.stringify(fault)}`));

export const entityOf = (n: bigint): Bytes32 => must(bytes32(hexOf(n)));

/** The hash of a proof body, by number: the one a dispute log names as `proofbodyHash`. */
export const bodyHashOf = (n: bigint): Bytes32 => must(bytes32(hexOf(n)));

export const DEPOSITORY: Address = must(address(hexOf(0xde0n, 20)));

/** A block hash that names its height and the fork it is on, so two forks never share one. */
export const hashOf = (number: bigint, fork = 0n): Bytes32 => must(bytes32(hexOf(number + (fork << 128n))));

/** The hash of the transaction that carried the log at `block` and `index`, unless a test names another. */
export const txOf = (block: bigint, index: bigint): Bytes32 =>
  must(bytes32(hexOf((0x7an << 200n) + (block << 64n) + index)));

/** A block's second is ten times its number: a later block is a later second, on every fork. */
export const blockOf = (number: bigint, fork = 0n): Block =>
  ({
    number, hash: hashOf(number, fork), parent: hashOf(number > 0n ? number - 1n : 0n, fork), timestamp: number * 10n,
  });

/** The blocks `from + 1` to `to`, each on its parent, on one fork; the first's parent is block `from` of that fork. */
export const blocksBetween = (from: bigint, to: bigint, fork = 0n): readonly Block[] =>
  Array.from({ length: Number(to - from) }, (_, i) => blockOf(from + 1n + BigInt(i), fork));

type Values = Readonly<Record<string, unknown>>;

/** A log the Depository would emit: `event` with its arguments by name, at `block` and `index`, on `fork`. */
export const logOf = (
  event: string, args: Values, block: bigint, index: bigint, fork = 0n, tx: Bytes32 = txOf(block, index),
): RawLog => {
  const fragment = DEPOSITORY_ABI.getEvent(event) ?? expect.unreachable(`the Depository has no event ${event}`);
  const { data, topics } = DEPOSITORY_ABI.encodeEventLog(fragment, fragment.inputs.map((input) => args[input.name]));
  return {
    address: DEPOSITORY, block, index, blockHash: hashOf(block, fork), data: data.toLowerCase(), tx,
    topics: topics.map((topic) => must(bytes32(topic.toLowerCase()))),
  };
};

type Phase = Readonly<{ events: readonly { name: string; args: Values; logIndex: number }[] }>;

const hasEvents = (value: unknown): value is Phase =>
  typeof value === "object" && value !== null && "events" in value && Array.isArray(value.events);

/**
 * The real Depository's lifecycle (contracts/vectors/lifecycle.json): one account through a deposit, a settlement, a
 * dispute and its end, as the events each batch emitted, in order.
 */
const LIFECYCLE = new URL("../../contracts/vectors/lifecycle.json", import.meta.url);

export const lifecyclePhases: Readonly<Record<string, Phase>> = Object.fromEntries(
  Object.entries<unknown>(JSON.parse(readFileSync(LIFECYCLE, "utf8")))
    .filter((entry): entry is [string, Phase] => hasEvents(entry[1])),
);

// ---- the arguments and calldata of a dispute finalize

/**
 * One clause's `Arguments` as the contract's own dispute tests encode it (`encodeDeltaTransformerArguments` of
 * Depository-part-1): one fill ratio and these secrets, `abi.encode` of the tuple.
 */
export const argumentTupleOf = (secrets: readonly string[]): string =>
  AbiCoder.defaultAbiCoder().encode(["tuple(uint16[] fillRatios, bytes32[] secrets)"], [[[5000n], secrets]]);

/**
 * The blob a dispute carries, as the contract's own tests encode it (Depository-part-1, `starterInitialArguments`) and
 * as the Depository reads it (Account.sol `_decodeTransformerArgumentList`): `abi.encode(bytes[])`, one `Arguments` per
 * clause.
 */
export const argumentListOf = (...clauses: readonly (readonly string[])[]): string =>
  AbiCoder.defaultAbiCoder().encode(["bytes[]"], [clauses.map(argumentTupleOf)]);

/** The blob of a dispute over one clause, showing these secrets. */
export const argumentsOf = (secrets: readonly string[]): string => argumentListOf(secrets);

const BODY: ProofBody = {
  watchSeed: hexOf(0n), leftResponseSeconds: 60n, rightResponseSeconds: 60n, offdeltas: [10n], tokenIds: [1n],
  transformers: [],
};

/** A finalize op of a batch, with the fields a test does not care about filled in. */
export const finalizeOp = (over: Partial<FinalDisputeProof> = {}): FinalDisputeProof => ({
  counterentity: entityOf(0x11n), initialNonce: 7n, finalNonce: 8n, proposerIsLeft: true,
  initialProofbodyHash: hexOf(1n), finalProofbody: BODY, starterArguments: "0x", otherArguments: "0x",
  sig: `0x${"ab".repeat(65)}`, startedByLeft: false, cooperative: false, ...over,
});

/** The input of a `processBatch` call, made by `sender`, that carries these finalize ops. */
export const finalizeInput = (sender: Bytes32, ops: readonly FinalDisputeProof[]): Uint8Array => {
  const batch = must(encodeBatch({ ...emptyBatch(1_000_000n), disputeFinalizations: ops }));
  return must(hexToBytes(DEPOSITORY_ABI.encodeFunctionData("processBatch", [sender, batch, "0x1234", 3n])));
};

/** A body with a negative offdelta, two tokens and a clause with allowances: every shape the decoder must read. */
export const CLAUSED: ProofBody = {
  watchSeed: hexOf(0xabn), leftResponseSeconds: 60n, rightResponseSeconds: 3600n,
  offdeltas: [-123_456_789_012_345_678_901_234_567_890n, 0n, 7n << 200n], tokenIds: [1n, 2n, 3n],
  transformers: [
    {
      transformerAddress: "0x00000000000000000000000000000000000000aa", encodedBatch: "0x1234",
      allowances: [{ deltaIndex: 1n, rightAllowance: 5n, leftAllowance: 6n }],
    },
    { transformerAddress: "0x00000000000000000000000000000000000000bb", encodedBatch: "0x", allowances: [] },
  ],
};

/** A start op of a batch for a body, with the hash it names, and the fields a test does not care about filled in. */
export const startOp = (body: ProofBody, over: Partial<InitialDisputeProof> = {}): InitialDisputeProof => ({
  counterentity: entityOf(0x11n), nonce: 7n, ondeltaEpoch: 0n, proposerIsLeft: true,
  proofbodyHash: must(proofBodyHash(body)), initialProofbody: body, watchSeed: body.watchSeed,
  sig: `0x${"ab".repeat(65)}`, starterInitialArguments: "0x", starterCounterArguments: "0x",
  starterCounterProofCommitment: hexOf(0n), ...over,
});

/** The input of a `processBatch` call, made by `sender`, that carries these start ops. */
export const startInput = (sender: Bytes32, ops: readonly InitialDisputeProof[]): Uint8Array => {
  const batch = must(encodeBatch({ ...emptyBatch(1_000_000n), disputeStarts: ops }));
  return must(hexToBytes(DEPOSITORY_ABI.encodeFunctionData("processBatch", [sender, batch, "0x1234", 3n])));
};

/** A signed 512-bit offdelta as the contract's `Int512 {int256 high; uint256 low}`. */
const int512Of = (value: bigint): { high: bigint; low: bigint } => ({
  high: value >> 256n, low: value & ((1n << 256n) - 1n),
});

/** The input of a tower's `watchtowerCounterDispute` call, which carries the op as its `params`. */
export const towerInput = (entity: Bytes32, op: FinalDisputeProof): Uint8Array => {
  const body = op.finalProofbody;
  const params = { ...op, finalProofbody: { ...body, offdeltas: body.offdeltas.map(int512Of) } };
  return must(hexToBytes(DEPOSITORY_ABI.encodeFunctionData("watchtowerCounterDispute", [
    entity, params, 300n, 1n, "0x1234",
  ])));
};

/** What `DisputeFinalized` logs as `finalizationEvidenceHash` for the op. */
export const evidenceOf = (op: FinalDisputeProof): Bytes32 =>
  must(bytes32(must(finalizationEvidenceHash({
    initialProofBodyHash: op.initialProofbodyHash, finalNonce: op.finalNonce, proposerIsLeft: op.proposerIsLeft,
    startedByLeft: op.startedByLeft, starterArguments: op.starterArguments, otherArguments: op.otherArguments,
    sig: op.sig,
  }))));

/** The `DisputeFinalized` log of `op` (sender Right, counterentity Left, opened at nonce 7), carried by `tx`. */
export const finalizedOf = (op: FinalDisputeProof, block: bigint, index: bigint, tx = txOf(block, index)): RawLog =>
  logOf("DisputeFinalized", {
    sender: entityOf(0x52n), counterentity: entityOf(0x11n), nonce: 7n, finalProofbodyHash: hexOf(5n),
    finalizationEvidenceHash: evidenceOf(op),
  }, block, index, 0n, tx);

/** The bytes with `patch` written over them at `at`, as a new array. */
export const patched = (bytes: Uint8Array, at: number, patch: Uint8Array): Uint8Array =>
  Uint8Array.from(bytes, (b, i) => patch[i - at] ?? b);

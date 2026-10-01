// What the J tests share: entity ids and ops with the fields a test does not care about filled in.
// Only tests import this.
import { expect } from "bun:test";
import type { ProofBody } from "../chain/proof/proof.ts";
import type { SettlementDiff } from "../chain/money.ts";
import type { JOp } from "./op/ops.ts";
import type { Treasury } from "./plan/funded.ts";

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

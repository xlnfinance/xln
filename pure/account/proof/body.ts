// The proof body an Account's state signs to (Types.sol ProofBody; og buildAccountProofBody): the part of the state a
// dispute settles from. Tokens go in ascending order and a token's position is its deltaIndex in every clause; each
// open hold is one transformer clause carrying one payment, in (token, slot) order, and each swap offer one clause
// carrying one swap, in slot order after them, so the body has as many clauses as the Account has holds and offers, at
// most MAX_HOLDS (R-HOLD-CAP). A body the Account contract would refuse is refused here,
// before anyone signs it (its 176 KiB byte limit cannot be reached under the caps: 128 tokens and 32 clauses make under
// 50 KiB). Both parties build the same body from the same state, so its bytes need nothing from the wire.
import { err, flatMap, map, traverse, type Result } from "../../kernel/core/result.ts";
import type { AbiFault } from "../../kernel/encoding/abi.ts";
import type { Tagged } from "../../kernel/core/tagged.ts";
import { encodeDeltaBatch, type Payment } from "../../chain/batch/clauses.ts";
import { proofBodyBytes, type Allowance, type ProofBody, type TransformerClause } from "../../chain/proof/proof.ts";
import type { JHeight } from "../clause/clock.ts";
import { MAX_HOLDS } from "../ledger.ts";
import type { AccountState, Hold, Ledger, Offer, TokenId } from "../model.ts";
import { clauseCount, openHolds } from "../state.ts";

/** Account.sol limits on a proof body (`_validateProofBody`). */
const MAX_PROOF_TOKENS = 128;
const MAX_RESPONSE_TOTAL = 365n * 24n * 3600n;

/**
 * What the Account's terms and the deployment fix, never a frame: the watch seed, the two response windows, the
 * DeltaTransformer the clauses name, and how a clause's deadline in J height becomes the seconds the contract judges a
 * reveal by (R-DEADLINE-TIMESTAMP: open, see contracts-decisions). A body is only as agreed as the function is.
 */
export type ProofTerms = Readonly<{
  watchSeed: string;
  leftResponseSeconds: bigint;
  rightResponseSeconds: bigint;
  transformer: string;
  secondsOf: (deadline: JHeight) => bigint;
}>;

export type ProofFault =
  | Tagged<"too_many_tokens", { tokens: number }>
  | Tagged<"too_many_clauses", { clauses: number }>
  | Tagged<"response_windows_too_long", { total: bigint }>
  | Tagged<"deadline_not_positive", { seconds: bigint }>
  | AbiFault;

const byToken = (s: AccountState): readonly (readonly [TokenId, Ledger])[] =>
  [...s.ledgers].toSorted(([x], [y]) => (x < y ? -1 : 1));

const bySlot = (hs: readonly Hold[]): readonly Hold[] => hs.toSorted((x, y) => (x.id < y.id ? -1 : 1));

/** One signed change to a delta moves it toward Left (positive) or Right (negative): a payer on the Left lowers it. */
const changeOf = (h: Hold): bigint => (h.payer === "left" ? -h.amount : h.amount);

/** What the clause may move, per direction: a move toward Left is Left's gain, so Right's allowance is its loss. */
const allowanceOf = (deltaIndex: bigint, change: bigint): Allowance => ({
  deltaIndex, rightAllowance: change < 0n ? -change : 0n, leftAllowance: change > 0n ? change : 0n,
});

/** The clause of a swap offer: its remaining amounts, and an allowance on both tokens, or the finalize reverts. */
const swapClauseOf = (
  terms: ProofTerms, indexOf: (token: TokenId) => bigint, o: Offer,
): Result<TransformerClause, ProofFault> => {
  const left = o.maker === "left";
  const [give, want] = [indexOf(o.give.token), indexOf(o.want.token)];
  // Delta is Left's allocation: a Left maker's give lowers it and its want raises it; a Right maker's the inverse
  const allowances = [allowanceOf(give, left ? -o.give.amount : o.give.amount),
    allowanceOf(want, left ? o.want.amount : -o.want.amount)];
  const swap = {
    ownerIsLeft: left, addDeltaIndex: give, addAmount: o.give.amount, subDeltaIndex: want, subAmount: o.want.amount,
  };
  return map(encodeDeltaBatch({ payments: [], swaps: [swap], pulls: [] }), (encodedBatch) =>
    ({ transformerAddress: terms.transformer, encodedBatch, allowances }));
};

const clauseOf = (terms: ProofTerms, deltaIndex: bigint, h: Hold): Result<TransformerClause, ProofFault> => {
  const payment: Payment = {
    deltaIndex, amount: changeOf(h), revealedUntilTimestamp: terms.secondsOf(h.deadline), hash: h.hashlock,
  };
  return map(encodeDeltaBatch({ payments: [payment], swaps: [], pulls: [] }), (encodedBatch) => ({
    transformerAddress: terms.transformer, encodedBatch, allowances: [allowanceOf(deltaIndex, payment.amount)],
  }));
};

/**
 * Why no body can be signed for `state`, if so, without building one: more tokens or clauses than the Account contract
 * allows, windows over a year, a deadline that maps to no positive second. It is the cheap half of `proofBodyOf`, and
 * the Account's rules refuse a tx that would leave a state failing it, so a state two replicas hold has a body.
 */
export const unsignable = (terms: ProofTerms, state: AccountState): ProofFault | undefined => {
  const total = terms.leftResponseSeconds + terms.rightResponseSeconds;
  const holds = openHolds(state);
  const clauses = clauseCount(state);
  const unmapped = holds.map((h) => terms.secondsOf(h.deadline)).find((seconds) => seconds <= 0n);
  switch (true) {
    case total > MAX_RESPONSE_TOTAL: return { _tag: "response_windows_too_long", total };
    case state.ledgers.size > MAX_PROOF_TOKENS: return { _tag: "too_many_tokens", tokens: state.ledgers.size };
    case clauses > MAX_HOLDS: return { _tag: "too_many_clauses", clauses };
    case unmapped !== undefined: return { _tag: "deadline_not_positive", seconds: unmapped ?? 0n };
    default: return undefined;
  }
};

/** The body `state` signs to under `terms`, or the way the Account contract would refuse it. */
export const proofBodyOf = (terms: ProofTerms, state: AccountState): Result<ProofBody, ProofFault> => {
  const refusal = unsignable(terms, state);
  if (refusal !== undefined) return err(refusal);
  const rows = byToken(state);
  const indexOf = (token: TokenId): bigint => BigInt(rows.findIndex(([t]) => t === token));
  const payments = traverse(
    rows.flatMap(([, ledger], i) => bySlot(ledger.holds).map((h) => [BigInt(i), h] as const)),
    ([index, h]) => clauseOf(terms, index, h),
  );
  const offers = state.offers.toSorted((x, y) => (x.id < y.id ? -1 : 1));
  const swaps = traverse(offers, (o) => swapClauseOf(terms, indexOf, o));
  return flatMap(payments, (paid) => flatMap(swaps, (swapped) => {
    const transformers = [...paid, ...swapped];
    const body: ProofBody = {
      watchSeed: terms.watchSeed,
      leftResponseSeconds: terms.leftResponseSeconds,
      rightResponseSeconds: terms.rightResponseSeconds,
      offdeltas: rows.map(([, l]) => l.offdelta),
      tokenIds: rows.map(([t]) => t),
      transformers,
    };
    return map(proofBodyBytes(body), () => body);
  }));
};

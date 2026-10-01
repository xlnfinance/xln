// The proof body an Account's state signs to (Types.sol ProofBody; og buildAccountProofBody): the part of the state a
// dispute settles from. Tokens go in ascending order and a token's position is its deltaIndex in every clause; each
// open hold is one transformer clause carrying one payment, in (token, slot) order, so the body has as many clauses as
// the Account has holds, at most MAX_HOLDS (R-HOLD-CAP). A body the Account contract would refuse is refused here,
// before anyone signs it (its 176 KiB byte limit cannot be reached under the caps: 128 tokens and 32 clauses make under
// 50 KiB). Both parties build the same body from the same state, so its bytes need nothing from the wire.
import { err, flatMap, map, traverse, type Result } from "../../kernel/core/result.ts";
import type { AbiFault } from "../../kernel/encoding/abi.ts";
import type { Tagged } from "../../kernel/core/tagged.ts";
import { encodeDeltaBatch, type Payment } from "../../chain/batch/clauses.ts";
import { proofBodyBytes, type Allowance, type ProofBody, type TransformerClause } from "../../chain/proof/proof.ts";
import type { JHeight } from "../clause/clock.ts";
import { MAX_HOLDS } from "../ledger.ts";
import type { AccountState, Hold, Ledger, TokenId } from "../model.ts";

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

const clauseOf = (terms: ProofTerms, deltaIndex: bigint, h: Hold): Result<TransformerClause, ProofFault> => {
  const seconds = terms.secondsOf(h.deadline);
  if (seconds <= 0n) return err({ _tag: "deadline_not_positive", seconds });
  const payment: Payment = { deltaIndex, amount: changeOf(h), revealedUntilTimestamp: seconds, hash: h.hashlock };
  return map(encodeDeltaBatch({ payments: [payment], swaps: [], pulls: [] }), (encodedBatch) => ({
    transformerAddress: terms.transformer, encodedBatch, allowances: [allowanceOf(deltaIndex, payment.amount)],
  }));
};

const refusedByContract = (b: ProofBody): ProofFault | undefined => {
  const total = b.leftResponseSeconds + b.rightResponseSeconds;
  switch (true) {
    case total > MAX_RESPONSE_TOTAL: return { _tag: "response_windows_too_long", total };
    case b.tokenIds.length > MAX_PROOF_TOKENS: return { _tag: "too_many_tokens", tokens: b.tokenIds.length };
    case b.transformers.length > MAX_HOLDS: return { _tag: "too_many_clauses", clauses: b.transformers.length };
    default: return undefined;
  }
};

/** The body `state` signs to under `terms`, or the way the Account contract would refuse it. */
export const proofBodyOf = (terms: ProofTerms, state: AccountState): Result<ProofBody, ProofFault> => {
  const rows = byToken(state);
  const clauses = traverse(
    rows.flatMap(([, ledger], i) => bySlot(ledger.holds).map((h) => [BigInt(i), h] as const)),
    ([index, h]) => clauseOf(terms, index, h),
  );
  return flatMap(clauses, (transformers) => {
    const body: ProofBody = {
      watchSeed: terms.watchSeed,
      leftResponseSeconds: terms.leftResponseSeconds,
      rightResponseSeconds: terms.rightResponseSeconds,
      offdeltas: rows.map(([, l]) => l.offdelta),
      tokenIds: rows.map(([t]) => t),
      transformers,
    };
    const refusal = refusedByContract(body);
    return refusal === undefined ? map(proofBodyBytes(body), () => body) : err(refusal);
  });
};

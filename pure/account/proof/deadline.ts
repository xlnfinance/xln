// R-DEADLINE-TIMESTAMP: a hold's deadline is a J height (R-HTLC-CLOCK) and the contract judges a reveal by block
// timestamp in seconds: DeltaTransformer counts a secret only if it reached the chain at a block no later than the
// payment's `revealedUntilTimestamp`, and finalize waits until that second has passed. The body both sides sign carries
// that second, so it must be one function of the deadline that both build alone, from what the deployment fixes.
//
// The function is a line through an anchor block of the J chain: `anchorSeconds` is the timestamp of block
// `anchorHeight`, `blockSeconds` is the chain's block time, and `slackSeconds` is added on top. Every payment of every
// hop uses the same line, so a deadline that is earlier in J height is earlier in seconds (the order a forwarding hub
// relies on, strictly, because `blockSeconds` is positive) and one slack shifts all of them together. The slack is the
// only safety margin and it errs in the payee's favour: a later second gives its reveal more time and costs the
// finalizer a longer wait (H1), never a payment. It must cover how far real block times drift from the line between the
// anchor and the deadline, so the anchor has to be recent: the values are the deploy manifest's, measured, not guessed.
import { err, ok, type Result } from "../../kernel/core/result.ts";
import type { Tagged } from "../../kernel/core/tagged.ts";
import type { JHeight } from "../clause/clock.ts";

export type TimeMap = Readonly<{
  anchorHeight: bigint; anchorSeconds: bigint; blockSeconds: bigint; slackSeconds: bigint;
}>;

export type TimeMapFault =
  | Tagged<"anchor_negative", { height: bigint; seconds: bigint }>
  | Tagged<"block_time_not_positive", { blockSeconds: bigint }>
  | Tagged<"slack_negative", { slackSeconds: bigint }>;

/** The map a deployment fixes: an anchor block, the block time and the slack. One that runs backwards is refused. */
export const timeMapOf = (m: TimeMap): Result<TimeMap, TimeMapFault> => {
  switch (true) {
    case m.anchorHeight < 0n || m.anchorSeconds < 0n:
      return err({ _tag: "anchor_negative", height: m.anchorHeight, seconds: m.anchorSeconds });
    case m.blockSeconds <= 0n: return err({ _tag: "block_time_not_positive", blockSeconds: m.blockSeconds });
    case m.slackSeconds < 0n: return err({ _tag: "slack_negative", slackSeconds: m.slackSeconds });
    default: return ok(m);
  }
};

/** The second a hold with this deadline is signed with; one far before the anchor has none (the body refuses it). */
export const deadlineSeconds = (m: TimeMap) => (deadline: JHeight): bigint =>
  m.anchorSeconds + m.blockSeconds * (deadline - m.anchorHeight) + m.slackSeconds;

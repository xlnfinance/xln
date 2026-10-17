/**
 * Wording every presentation scenario shares. A central-bank audience hears the same claim
 * the same way in every part, so the claims that are easy to overstate live in one place:
 * what the settlement asset is, how final a co-signed payment is, and how long a challenge
 * window runs.
 */

import type { NarrationBadge } from './narration';

/** What "settled" means here: the Depository's asset, never central bank money as such. */
export const SETTLEMENT_ASSET =
  "Settled in the Depository's settlement asset (here a USDC test token; in a central bank deployment, tokenised reserves).";

/** The three-layer finality model. */
export const FINALITY_MODEL =
  "Irrevocable between the two banks once both sign, and enforceable on-chain up to the account's collateral; " +
  'above that it is an unsecured claim. Settlement in the asset happens when collateral covers it or it moves on-chain; ' +
  'legal finality depends on system designation.';

/** Hash-locked payments are conditional payments, not payment-versus-payment. */
export const HTLC_PARALLEL =
  'A chain of conditional payments tied to one secret: either every hop completes, from payee back to payer, ' +
  'or every lock expires and is refunded. Intermediaries carry the timing risk.';

/** What a dispute is, legally: mechanical application of signed evidence. */
export const DISPUTE_PARALLEL =
  'The Depository applies the latest co-signed state mechanically; legal finality depends on governing law.';

/** Why a challenge window needs someone watching. */
export const CHALLENGE_WINDOW_WHY =
  'An older state loses only if the other side answers in time with a newer one, so each bank — or a watchtower — ' +
  'must watch the chain during the window.';

/** The bilateral → on-chain → legal ladder for one payment. */
export const finalityBadges = (onChain: string): NarrationBadge[] => [
  { label: 'Bilateral', detail: 'Signed by both banks of each account: neither can undo it alone.', tone: 'done' },
  { label: 'On-chain', detail: onChain, tone: 'bounded' },
  { label: 'Legal', detail: 'Depends on whether the system is designated under settlement-finality law.', tone: 'outside' },
];

type DisputeWindowConfig = { leftResponseSeconds: number; rightResponseSeconds: number };

/**
 * The challenge window an account committed to: the Depository allows both sides' response
 * times in sequence (start + left + right seconds).
 */
export const disputeWindowText = (config: DisputeWindowConfig): string => {
  const seconds = Number(config.leftResponseSeconds) + Number(config.rightResponseSeconds);
  if (!Number.isSafeInteger(seconds) || seconds < 0) throw new Error(`STORY_DISPUTE_WINDOW_INVALID:${String(seconds)}`);
  if (seconds % 3600 === 0) return `${seconds / 3600} hour${seconds === 3600 ? '' : 's'}`;
  if (seconds % 60 === 0) return `${seconds / 60} minutes`;
  return `${seconds} seconds`;
};

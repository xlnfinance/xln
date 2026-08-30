/**
 * Committed regression corpus for proofs/C2 (hot-vs-cold account roots).
 *
 * Pure data: no imports, no harness logic. fast-check shrunk failures are
 * appended here after manual minimality verification, and the curated
 * sequences below pin the protocol paths that random generation must keep
 * covering: round-trip, same-height collision with LEFT-wins rollback,
 * retransmit/replay, j-event claim admission/finality, HTLC lock+resolve
 * (put and Patricia delete), swap offer+cancel (put and delete), rebalance
 * policy/request/refund cycle, cross-j pull lock, and j-claim conflict
 * vectors (FX-3/D4).
 */

export type HarnessSide = 'alpha' | 'beta';

export type HarnessTxSpec =
  | { kind: 'payment'; tokenId: number; amount: bigint }
  | { kind: 'credit'; tokenId: number; amount: bigint }
  | { kind: 'delta'; tokenId: number }
  /** HTLC conditional payment; the secret is derived from lockId alone so a
   * later `htlcResolve` can reconstruct it without harness-side storage. */
  | { kind: 'htlc_lock'; lockId: number; tokenId: number; amount: bigint; mode: 'instant' | 'async' | 'none' }
  /** REMOVE op: `locks.del` on a non-empty Patricia map. `secret` resolves as
   * the payer's reveal; `error` is beneficiary-only (validated as a
   * stateful-command precondition at instantiate time). */
  | { kind: 'htlc_resolve'; lockId: number; outcome: 'secret' | 'error' }
  | { kind: 'swap_offer'; offerId: number; giveTokenId: number; wantTokenId: number; amount: bigint }
  /** REMOVE op: `swap_resolve` fillRatio 0 + cancelRemainder → `swapOffers.del`.
   * Only the maker's counterparty may resolve (preconditioned at instantiate). */
  | { kind: 'swap_cancel'; offerId: number }
  /** Cross-j pull lock → `pulls.put` (route+binding built by production builders). */
  | { kind: 'cross_pull_lock'; orderId: number; tokenId: number; amount: bigint }
  /** Fee-policy publication → `rebalanceFeePolicies.put` (per side, per token). */
  | { kind: 'rebalance_policy'; tokenId: number; policyVersion: number; baseFee: bigint; liquidityFeeBps: bigint; gasFee: bigint }
  /** Collateral request → `requestedRebalance.put` + `requestedRebalanceFeeState.put`. */
  | { kind: 'request_collateral'; tokenId: number; amount: bigint; feeAmount: bigint }
  /** REMOVE op: full bilateral refund → `requestedRebalance.del` +
   * `requestedRebalanceFeeState.del` + `shadow.rebalance.submittedAtByToken.del`.
   * Only the non-requester may refund (preconditioned at instantiate). */
  | { kind: 'rebalance_refund'; tokenId: number };

export type HarnessOp =
  | { kind: 'admit'; side: HarnessSide; txs: HarnessTxSpec[] }
  /** blockByte is generated, so exact duplicates AND conflicts at the same
   * jHeight are both reachable (c2-adversary A3): conflicting claims get the
   * FX-3 typed admission rejection instead of halting the account. */
  | { kind: 'jclaim'; side: HarnessSide; jHeight: number; blockByte: number }
  | { kind: 'propose'; side: HarnessSide }
  | { kind: 'deliver'; side: HarnessSide }
  | { kind: 'ack'; side: HarnessSide };

export type RegressionSequence = Readonly<{ name: string; ops: readonly HarnessOp[] }>;

const roundTrip = (side: HarnessSide): readonly HarnessOp[] => [
  { kind: 'propose', side },
  { kind: 'deliver', side },
  { kind: 'ack', side: side === 'alpha' ? 'beta' : 'alpha' },
];

export const REGRESSION_SEQUENCES: readonly RegressionSequence[] = [
  {
    name: 'r1-happy-round-trip-both-directions',
    ops: [
      { kind: 'admit', side: 'alpha', txs: [
        { kind: 'payment', tokenId: 1, amount: 100n },
        { kind: 'credit', tokenId: 2, amount: 500n },
      ] },
      { kind: 'propose', side: 'alpha' },
      { kind: 'deliver', side: 'alpha' },
      { kind: 'ack', side: 'beta' },
      { kind: 'admit', side: 'beta', txs: [{ kind: 'payment', tokenId: 1, amount: 50n }] },
      { kind: 'propose', side: 'beta' },
      { kind: 'deliver', side: 'beta' },
      { kind: 'ack', side: 'alpha' },
      { kind: 'deliver', side: 'alpha' },
    ],
  },
  {
    name: 'r2-collision-left-wins-rollback-retransmit',
    ops: [
      { kind: 'admit', side: 'alpha', txs: [{ kind: 'payment', tokenId: 1, amount: 10n }] },
      { kind: 'admit', side: 'beta', txs: [{ kind: 'credit', tokenId: 1, amount: 999n }] },
      { kind: 'propose', side: 'alpha' },
      { kind: 'propose', side: 'beta' },
      { kind: 'deliver', side: 'alpha' },
      { kind: 'deliver', side: 'beta' },
      { kind: 'ack', side: 'beta' },
      { kind: 'ack', side: 'alpha' },
      { kind: 'deliver', side: 'beta' },
      { kind: 'propose', side: 'beta' },
      { kind: 'deliver', side: 'beta' },
      { kind: 'ack', side: 'alpha' },
    ],
  },
  {
    name: 'r3-j-event-claims-finalize-then-stale-and-post-finality-work',
    ops: [
      { kind: 'jclaim', side: 'alpha', jHeight: 3, blockByte: 0x14 },
      { kind: 'jclaim', side: 'beta', jHeight: 3, blockByte: 0x14 },
      ...roundTrip('alpha'),
      ...roundTrip('beta'),
      // Post-finality: the enforcement clock now derives from committed state
      // (lastFinalizedJHeight=3), a descending claim takes the stale-prune
      // branch, and ordinary work still commits under the advanced clock.
      { kind: 'jclaim', side: 'alpha', jHeight: 2, blockByte: 0x21 },
      { kind: 'admit', side: 'alpha', txs: [{ kind: 'payment', tokenId: 1, amount: 7n }] },
      ...roundTrip('alpha'),
      { kind: 'jclaim', side: 'beta', jHeight: 4, blockByte: 0x15 },
      { kind: 'jclaim', side: 'alpha', jHeight: 4, blockByte: 0x15 },
      ...roundTrip('beta'),
    ],
  },
  {
    name: 'r4-duplicate-ack-stale-frame-empty-propose',
    ops: [
      { kind: 'admit', side: 'alpha', txs: [{ kind: 'delta', tokenId: 7 }] },
      { kind: 'propose', side: 'alpha' },
      { kind: 'deliver', side: 'alpha' },
      { kind: 'ack', side: 'beta' },
      { kind: 'ack', side: 'beta' },
      { kind: 'deliver', side: 'alpha' },
      { kind: 'propose', side: 'alpha' },
      { kind: 'admit', side: 'beta', txs: [{ kind: 'payment', tokenId: 1, amount: 1n }] },
      { kind: 'propose', side: 'beta' },
      { kind: 'ack', side: 'alpha' },
      { kind: 'deliver', side: 'beta' },
    ],
  },
  {
    name: 'r5-htlc-lock-then-resolve-secret-and-error-delete-path',
    ops: [
      // lock 1 (alpha is payer) and lock 2 (beta is payer), both delivery modes.
      { kind: 'admit', side: 'alpha', txs: [
        { kind: 'htlc_lock', lockId: 1, tokenId: 1, amount: 300n, mode: 'instant' },
      ] },
      ...roundTrip('alpha'),
      { kind: 'admit', side: 'beta', txs: [
        { kind: 'htlc_lock', lockId: 2, tokenId: 2, amount: 400n, mode: 'async' },
      ] },
      ...roundTrip('beta'),
      // secret resolve: payer (alpha) reveals; lock 1 leaves `locks`.
      { kind: 'admit', side: 'alpha', txs: [{ kind: 'htlc_resolve', lockId: 1, outcome: 'secret' }] },
      ...roundTrip('alpha'),
      // error resolve: only the beneficiary of lock 2 (alpha) may release.
      { kind: 'admit', side: 'alpha', txs: [{ kind: 'htlc_resolve', lockId: 2, outcome: 'error' }] },
      ...roundTrip('alpha'),
      { kind: 'admit', side: 'beta', txs: [{ kind: 'payment', tokenId: 1, amount: 5n }] },
      ...roundTrip('beta'),
    ],
  },
  {
    name: 'r6-swap-offer-then-counterparty-cancel-delete-path',
    ops: [
      { kind: 'admit', side: 'alpha', txs: [
        { kind: 'swap_offer', offerId: 1, giveTokenId: 1, wantTokenId: 2, amount: 100n },
      ] },
      ...roundTrip('alpha'),
      // second offer by beta on a different market, plus a payment in parallel.
      { kind: 'admit', side: 'beta', txs: [
        { kind: 'swap_offer', offerId: 2, giveTokenId: 3, wantTokenId: 4, amount: 200n },
        { kind: 'payment', tokenId: 1, amount: 3n },
      ] },
      ...roundTrip('beta'),
      // cancel offer 1: only alpha's counterparty (beta) may resolve.
      { kind: 'admit', side: 'beta', txs: [{ kind: 'swap_cancel', offerId: 1 }] },
      ...roundTrip('beta'),
      { kind: 'admit', side: 'alpha', txs: [{ kind: 'swap_cancel', offerId: 2 }] },
      ...roundTrip('alpha'),
    ],
  },
  {
    name: 'r7-rebalance-policy-request-refund-and-finality-clear',
    ops: [
      // both sides publish fee policies for token 1
      { kind: 'admit', side: 'alpha', txs: [
        { kind: 'rebalance_policy', tokenId: 1, policyVersion: 1, baseFee: 2n, liquidityFeeBps: 10n, gasFee: 1n },
      ] },
      ...roundTrip('alpha'),
      { kind: 'admit', side: 'beta', txs: [
        { kind: 'rebalance_policy', tokenId: 1, policyVersion: 1, baseFee: 3n, liquidityFeeBps: 20n, gasFee: 2n },
      ] },
      ...roundTrip('beta'),
      // alpha requests collateral → requestedRebalance/requestedRebalanceFeeState
      // put. Net request is 4 so the height-5 finalize increase (5) fully covers
      // it and the j-finality DEL branch (requestedRebalance/requestedRebalance-
      // FeeState/shadowSubmitted .del) fires.
      { kind: 'admit', side: 'alpha', txs: [
        { kind: 'request_collateral', tokenId: 1, amount: 6n, feeAmount: 2n },
      ] },
      ...roundTrip('alpha'),
      // beta requests on token 2, then alpha fully refunds it → del path
      { kind: 'admit', side: 'beta', txs: [
        { kind: 'request_collateral', tokenId: 2, amount: 400n, feeAmount: 2n },
      ] },
      ...roundTrip('beta'),
      { kind: 'admit', side: 'alpha', txs: [{ kind: 'rebalance_refund', tokenId: 2 }] },
      ...roundTrip('alpha'),
      // bilateral finalize of an increasing-collateral AccountSettled at token 1
      // clears alpha's request via the j-finality del branch.
      { kind: 'jclaim', side: 'alpha', jHeight: 5, blockByte: 0x33 },
      { kind: 'jclaim', side: 'beta', jHeight: 5, blockByte: 0x33 },
      ...roundTrip('alpha'),
      { kind: 'admit', side: 'alpha', txs: [{ kind: 'payment', tokenId: 1, amount: 11n }] },
      ...roundTrip('alpha'),
    ],
  },
  {
    name: 'r8-cross-j-pull-lock-nonempty-pulls',
    ops: [
      { kind: 'admit', side: 'alpha', txs: [
        { kind: 'cross_pull_lock', orderId: 1, tokenId: 1, amount: 700n },
      ] },
      ...roundTrip('alpha'),
      { kind: 'admit', side: 'beta', txs: [
        { kind: 'cross_pull_lock', orderId: 2, tokenId: 3, amount: 900n },
        { kind: 'payment', tokenId: 1, amount: 4n },
      ] },
      ...roundTrip('beta'),
      { kind: 'propose', side: 'alpha' },
      { kind: 'deliver', side: 'alpha' },
      { kind: 'ack', side: 'beta' },
    ],
  },
  {
    name: 'r9-j-claim-conflict-duplicates-typed-rejects',
    ops: [
      // committed member at height 5 (beta claims, full round trip)
      { kind: 'jclaim', side: 'beta', jHeight: 5, blockByte: 0x77 },
      ...roundTrip('beta'),
      // exact duplicate after commit: idempotent skip
      { kind: 'jclaim', side: 'alpha', jHeight: 5, blockByte: 0x77 },
      // conflicting claims: typed admission rejects, account continues
      { kind: 'jclaim', side: 'alpha', jHeight: 5, blockByte: 0x55 },
      { kind: 'jclaim', side: 'alpha', jHeight: 5, blockByte: 0x66 },
      { kind: 'admit', side: 'alpha', txs: [{ kind: 'payment', tokenId: 1, amount: 9n }] },
      ...roundTrip('alpha'),
      // queued conflict + queued duplicate at a fresh height
      { kind: 'jclaim', side: 'alpha', jHeight: 7, blockByte: 0x11 },
      { kind: 'jclaim', side: 'alpha', jHeight: 7, blockByte: 0x22 },
      { kind: 'jclaim', side: 'alpha', jHeight: 7, blockByte: 0x11 },
      ...roundTrip('alpha'),
      // stale admitted claim: alpha queued height 6, peer commits height 6 first
      { kind: 'jclaim', side: 'alpha', jHeight: 6, blockByte: 0x55 },
      { kind: 'jclaim', side: 'beta', jHeight: 6, blockByte: 0x88 },
      ...roundTrip('beta'),
      { kind: 'propose', side: 'alpha' },
      { kind: 'deliver', side: 'alpha' },
      { kind: 'ack', side: 'beta' },
    ],
  },
];

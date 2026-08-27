/**
 * Committed regression corpus for proofs/C2 (hot-vs-cold account roots).
 *
 * Pure data: no imports, no harness logic. fast-check shrunk failures are
 * appended here after manual minimality verification, and the curated
 * sequences below pin the protocol paths that random generation must keep
 * covering (round-trip, same-height collision with LEFT-wins rollback,
 * retransmit/replay, j-event claim admission).
 */

export type HarnessSide = 'alpha' | 'beta';

export type HarnessTxSpec =
  | { kind: 'payment'; tokenId: number; amount: bigint }
  | { kind: 'credit'; tokenId: number; amount: bigint }
  | { kind: 'delta'; tokenId: number };

export type HarnessOp =
  | { kind: 'admit'; side: HarnessSide; txs: HarnessTxSpec[] }
  | { kind: 'jclaim'; side: HarnessSide; jHeight: number }
  | { kind: 'propose'; side: HarnessSide }
  | { kind: 'deliver'; side: HarnessSide }
  | { kind: 'ack'; side: HarnessSide };

export type RegressionSequence = Readonly<{ name: string; ops: readonly HarnessOp[] }>;

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
    name: 'r3-j-event-claims-both-sides',
    ops: [
      { kind: 'jclaim', side: 'alpha', jHeight: 3 },
      { kind: 'jclaim', side: 'beta', jHeight: 3 },
      { kind: 'propose', side: 'alpha' },
      { kind: 'deliver', side: 'alpha' },
      { kind: 'ack', side: 'beta' },
      { kind: 'propose', side: 'beta' },
      { kind: 'deliver', side: 'beta' },
      { kind: 'ack', side: 'alpha' },
      { kind: 'jclaim', side: 'alpha', jHeight: 4 },
      { kind: 'propose', side: 'alpha' },
      { kind: 'deliver', side: 'alpha' },
      { kind: 'ack', side: 'beta' },
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
];

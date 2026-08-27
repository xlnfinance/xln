import type { AccountPeerRejectionCode } from '../input/peer-rejection';
import type { AccountTx } from '../../types/account';

/**
 * FX-1 (proofs/fixes.md, decision D2): `RebalancePolicy.policyVersion` is
 * protocol-bound to `0..=MAX_POLICY_VERSION` — `Number.MAX_SAFE_INTEGER`.
 *
 * SECURITY: above 2^53 a TypeScript `number` silently rounds, so TS would hash
 * a distorted value while Rust rejects the same `u64` as an unsafe integer:
 * the engines would diverge on one frame hash with no local error. The bound
 * is therefore enforced at admission, before the mempool, in both engines
 * (Rust: `MAX_POLICY_VERSION` in `engine/src/consensus/frame/hash.rs`), and
 * again by the frame-hash layer as an admission-bug tripwire. The protocol
 * range is normative in `docs/fints.md`.
 */
export const MAX_POLICY_VERSION = 9_007_199_254_740_991;

/**
 * FX-2 (proofs/fixes.md, decision D3): transaction kinds outside the RRS
 * profile (pay / HTLC / same-J swap / j-event / rebalance). Lending and
 * reserve movements are not bilateral Account consensus operations; a queued
 * copy would wedge every later frame in the Rust engine, which cannot hash
 * them, while TypeScript kept executing a silent passthrough path.
 * Admission and incoming-frame preflight both reject these kinds loudly; the
 * authoritative lane for reserve movements is `j_event_claim` bilateral
 * consensus.
 */
const OUT_OF_PROFILE_TX_KINDS: ReadonlySet<AccountTx['type']> = new Set<AccountTx['type']>([
  'lending_fund',
  'lending_borrow_request',
  'lending_repay',
  'lending_credit',
  'lending_close_request',
  'lending_close_payout',
  'reserve_to_collateral',
]);

const ACCOUNT_TX_POLICY_VERSION_OUT_OF_RANGE =
  'ACCOUNT_TX_POLICY_VERSION_OUT_OF_RANGE' as const;
const ACCOUNT_TX_KIND_OUT_OF_PROFILE = 'ACCOUNT_TX_KIND_OUT_OF_PROFILE' as const;

export type AccountTxAdmissionErrorCode =
  | typeof ACCOUNT_TX_POLICY_VERSION_OUT_OF_RANGE
  | typeof ACCOUNT_TX_KIND_OUT_OF_PROFILE;

/** Typed local-admission violation. Thrown before any mempool mutation. */
export class AccountTxAdmissionError extends Error {
  readonly code: AccountTxAdmissionErrorCode;
  readonly txType: AccountTx['type'];
  /** Only set for `ACCOUNT_TX_POLICY_VERSION_OUT_OF_RANGE`. */
  readonly policyVersion?: number;

  constructor(
    code: AccountTxAdmissionErrorCode,
    txType: AccountTx['type'],
    policyVersion?: number,
  ) {
    super(
      code === ACCOUNT_TX_POLICY_VERSION_OUT_OF_RANGE
        ? `${ACCOUNT_TX_POLICY_VERSION_OUT_OF_RANGE}:${txType}:${String(policyVersion)} `
          + `(protocol range 0..=${MAX_POLICY_VERSION})`
        : `${ACCOUNT_TX_KIND_OUT_OF_PROFILE}:${txType} `
          + '(profile: pay/HTLC/same-J swap/j-event/rebalance)',
    );
    this.name = 'AccountTxAdmissionError';
    this.code = code;
    this.txType = txType;
    if (policyVersion !== undefined) this.policyVersion = policyVersion;
  }
}

/** `0..=MAX_POLICY_VERSION`, integral. Non-numbers and negatives fail closed. */
const isPolicyVersionInRange = (policyVersion: number): boolean =>
  Number.isSafeInteger(policyVersion) && policyVersion >= 0;

/**
 * FX-1 alone: an out-of-range `RebalancePolicy.policyVersion`. The frame-hash
 * layer uses this narrower probe as its admission-bug tripwire — the lending
 * kinds stay hashable passthrough there so already-committed historical frames
 * remain verifiable; FX-2 rejects them only at admission and preflight.
 */
export const policyVersionOutOfRangeError = (
  tx: AccountTx,
): AccountTxAdmissionError | undefined =>
  tx.type === 'rebalance_policy' && !isPolicyVersionInRange(tx.data.policyVersion)
    ? new AccountTxAdmissionError(
        ACCOUNT_TX_POLICY_VERSION_OUT_OF_RANGE,
        tx.type,
        tx.data.policyVersion,
      )
    : undefined;

/** First admission violation in the batch, or `undefined` if all are admissible. */
export const accountTxAdmissionError = (tx: AccountTx): AccountTxAdmissionError | undefined =>
  OUT_OF_PROFILE_TX_KINDS.has(tx.type)
    ? new AccountTxAdmissionError(ACCOUNT_TX_KIND_OUT_OF_PROFILE, tx.type)
    : policyVersionOutOfRangeError(tx);

/**
 * Loud local-admission gate for the enqueue path. Nothing is admitted when
 * this throws: the caller must invoke it before any mempool write, mirroring
 * Rust `AccountConsensus::admit_txs`, which rejects the whole batch on its
 * first violation.
 */
export const assertAccountTxsAdmissible = (txs: readonly AccountTx[]): void => {
  for (const tx of txs) {
    const error = accountTxAdmissionError(tx);
    if (error) throw error;
  }
};

/** Peer-frame counterpart of a local admission violation. */
export const accountTxAdmissionPeerCode = (error: AccountTxAdmissionError): AccountPeerRejectionCode =>
  error.code === ACCOUNT_TX_KIND_OUT_OF_PROFILE
    ? 'ACCOUNT_PEER_FRAME_TX_OUT_OF_PROFILE'
    : 'ACCOUNT_PEER_FRAME_TX_POLICY_VERSION_OUT_OF_RANGE';

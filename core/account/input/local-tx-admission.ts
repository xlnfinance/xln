import { appendAccountMempoolTxs } from './mempool';
import { txFingerprint } from '../../protocol/state/tx-multiset';
import type { AccountTxBatch, AccountReplica, AccountTx } from '../../types/account';
import type { AccountJClaimNodeStore } from '../../types/finance/account-j-claims';
import type {
  AccountAdmissionRejection,
  HandleAccountInputResult,
} from '../consensus/types';
import { accountInputApplied } from '../consensus/result';
import { assertAccountTxsAdmissible } from '../tx/admission-policy';
import { ACCOUNT_TX_REJECTION_CODES } from '../tx/apply-types';
import { getAccountStateDomain } from '../consensus/helpers';
import { planAccountJClaimLocalAdmission } from '../j-claims/j-claim-transition';
import { isLeftEntity } from '../../protocol/identity/entity-id';

type LocalAdmissionPlan = {
  admitted: AccountTx[];
  rejections: AccountAdmissionRejection[];
};

/**
 * FX-3 (proofs/fixes.md, decision D4): enqueue-level j-claim admission.
 *
 * Exact (jHeight, jBlockHash, eventsHash) duplicates — committed or already
 * queued — are skipped idempotently. A claim that conflicts with committed
 * accumulator evidence or with an earlier queued claim is rejected for that
 * row only, as typed data on an applied input: an adversarial observation
 * must never halt the account, so the conflict path never throws (unlike the
 * FX-1/FX-2 whole-batch gate above it, which fires on malformed input before
 * any mempool write). Proposal re-runs the same classification when it
 * regenerates proofs, covering state that changed after admission.
 */
const planLocalAccountTxAdmission = (
  account: AccountReplica,
  txs: readonly AccountTx[],
  jClaimNodeStore: AccountJClaimNodeStore,
): LocalAdmissionPlan => {
  const queued = [
    ...account.mempool,
    ...(account.pendingFrame?.accountTxs ?? []),
  ];
  const seenLifecycle = new Set(
    queued.filter(tx => tx.type !== 'direct_payment').map(txFingerprint),
  );
  const domain = getAccountStateDomain(account.state);
  const admitted: AccountTx[] = [];
  const rejections: AccountAdmissionRejection[] = [];
  for (const [index, tx] of txs.entries()) {
    if (tx.type === 'direct_payment') {
      admitted.push(tx);
      continue;
    }
    const fingerprint = txFingerprint(tx);
    if (seenLifecycle.has(fingerprint)) continue;
    if (tx.type === 'j_event_claim') {
      const plan = planAccountJClaimLocalAdmission(
        account.state,
        [...queued, ...admitted],
        tx,
        jClaimNodeStore,
        domain,
        isLeftEntity(account.proofHeader.fromEntity, account.proofHeader.toEntity),
      );
      if (plan.verdict === 'duplicate') continue;
      if (plan.verdict === 'conflict') {
        rejections.push({
          index,
          code: ACCOUNT_TX_REJECTION_CODES.validation,
          message: plan.message,
        });
        continue;
      }
    }
    seenLifecycle.add(fingerprint);
    admitted.push(tx);
  }
  return { admitted, rejections };
};

/**
 * Admit one locally authorized Account transaction into the future-frame
 * mempool. This policy belongs to the Account machine even though an EntityTx
 * commonly produces the command.
 *
 * Separately authorized payments retain multiplicity: identical payment bytes
 * still represent distinct money movement. Protocol lifecycle commands are
 * idempotent by exact payload across both queued and pending-frame work.
 */
export const admitLocalAccountTx = (
  account: AccountReplica,
  tx: AccountTx,
  jClaimNodeStore: AccountJClaimNodeStore,
): boolean => {
  assertAccountTxsAdmissible([tx]);
  const { admitted } = planLocalAccountTxAdmission(account, [tx], jClaimNodeStore);
  appendAccountMempoolTxs(account, admitted, 'account:localAdmission');
  return admitted.length === 1;
};

/** Apply the local-only branch of the canonical AccountInput boundary. */
export const applyAccountEnqueue = (
  account: AccountReplica,
  input: AccountTxBatch,
  jClaimNodeStore: AccountJClaimNodeStore,
): HandleAccountInputResult => {
  // FX-1/FX-2 admission gate: an out-of-range policyVersion or an
  // out-of-profile kind is a loud typed error before any mempool write, so a
  // rejected batch admits nothing — the same whole-batch verdict as Rust
  // `AccountConsensus::admit_txs`.
  assertAccountTxsAdmissible(input.txs);
  const { admitted, rejections } = planLocalAccountTxAdmission(
    account,
    input.txs,
    jClaimNodeStore,
  );
  appendAccountMempoolTxs(account, admitted, 'account:localInput');
  return accountInputApplied({
    events: [],
    admittedAccountTxCount: admitted.length,
    ...(rejections.length > 0 ? { admissionRejections: rejections } : {}),
  });
};

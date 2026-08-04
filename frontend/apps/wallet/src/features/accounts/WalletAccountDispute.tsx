import { useState } from 'react';
import type { RuntimeInput } from '@xln/runtime/api/public/runtime-module';

import { useExternalStore } from '../../../../../packages/react-adapters/use-external-store';
import { timeStateExternalStore } from '$lib/stores/timeStore';
import type { CommandReceipt } from '$lib/stores/runtimeCommandBus';
import {
  buildWalletDisputeFinalizeInput,
  buildWalletDisputePrepareInput,
  buildWalletDisputedAccountReopenInput,
} from '../../../../../packages/runtime-client/wallet-financial-input-adapter';
import type { WalletAccountView, WalletEntityAccountsView } from './account-view-model';
import { submitWalletFinancialCommand } from './wallet-financial-actions';
import { walletAccountStoreController } from './wallet-account-store';
import { WalletCommandReceipt } from './WalletCommandReceipt';

type DisputeIntent = 'prepare' | 'finalize' | 'reopen';
type DisputeConfirmation = Readonly<{
  intent: DisputeIntent;
  input: RuntimeInput;
  evidence: string;
  acceptedLossRaw: string | null;
}>;

const evidenceFor = (account: WalletAccountView): string => [
  account.status,
  account.activeDispute ? 'active' : 'inactive',
  account.crossJTargetDisputeRisk?.amountRaw ?? 'none',
].join(':');

export const WalletAccountDispute = ({
  entity,
  account,
  receipt,
}: Readonly<{
  entity: WalletEntityAccountsView;
  account: WalletAccountView;
  receipt: CommandReceipt | null;
}>) => {
  const time = useExternalStore(timeStateExternalStore);
  const [acceptRisk, setAcceptRisk] = useState(false);
  const [confirmation, setConfirmation] = useState<DisputeConfirmation | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const review = (intent: DisputeIntent): void => {
    try {
      if (!account.disputeRiskEvidenceComplete && intent === 'prepare') {
        throw new Error('WALLET_DISPUTE_RISK_EVIDENCE_UNAVAILABLE');
      }
      const owner = { entityId: entity.entityId, signerId: entity.signerId };
      const risk = account.crossJTargetDisputeRisk;
      if (intent === 'prepare' && risk && !acceptRisk) {
        throw new Error('WALLET_DISPUTE_CROSS_J_RISK_NOT_ACCEPTED');
      }
      const input = intent === 'prepare'
        ? buildWalletDisputePrepareInput({
            ...owner,
            counterpartyEntityId: account.counterpartyId,
            ...(risk ? { acceptedCrossJTargetLossAmount: BigInt(risk.amountRaw) } : {}),
          })
        : intent === 'finalize'
          ? buildWalletDisputeFinalizeInput({ ...owner, counterpartyEntityId: account.counterpartyId })
          : buildWalletDisputedAccountReopenInput({ ...owner, counterpartyEntityId: account.counterpartyId });
      setError(null);
      setConfirmation(Object.freeze({
        intent,
        input,
        evidence: evidenceFor(account),
        acceptedLossRaw: risk?.amountRaw ?? null,
      }));
    } catch (reviewError) {
      setConfirmation(null);
      setError(reviewError instanceof Error ? reviewError.message : String(reviewError));
    }
  };

  const submit = async (): Promise<void> => {
    if (!confirmation) return;
    setSubmitting(true);
    setError(null);
    try {
      const currentEvidence = evidenceFor(account);
      if (currentEvidence !== confirmation.evidence) {
        throw new Error(`WALLET_DISPUTE_STALE_REVIEW:${confirmation.evidence}:${currentEvidence}`);
      }
      await submitWalletFinancialCommand(
        `wallet-dispute:${confirmation.intent}:${entity.entityId}:${account.counterpartyId}:${confirmation.evidence}`,
        confirmation.input,
      );
      setConfirmation(null);
      await walletAccountStoreController.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="wallet-account-dispute" data-testid="wallet-account-dispute">
      <header><span>Dispute controls</span><strong>{account.status}</strong></header>
      {!account.disputeRiskEvidenceComplete && <p className="wallet-inline-error" role="alert">Cross-jurisdiction risk evidence is unavailable on this remote projection. Dispute preparation is blocked.</p>}
      {account.crossJTargetDisputeRisk && !account.activeDispute && <label className="wallet-danger-confirm"><input type="checkbox" checked={acceptRisk} onChange={event => { setAcceptRisk(event.target.checked); setConfirmation(null); }} /><span>I accept possible cross-jurisdiction loss up to {account.crossJTargetDisputeRisk.amount} {account.crossJTargetDisputeRisk.symbol} ({account.crossJTargetDisputeRisk.amountRaw} raw).</span></label>}
      {!confirmation && <div className="wallet-action-row">
        {account.activeDispute
          ? <button type="button" className="wallet-button-danger" disabled={!time.isLive || submitting} onClick={() => review('finalize')}>Review dispute finalize</button>
          : account.disputed
            ? <button type="button" disabled={!time.isLive || submitting} onClick={() => review('reopen')}>Review account reopen</button>
            : account.status !== 'dispute_preparing' && <button type="button" className="wallet-button-danger" disabled={!time.isLive || submitting || !account.disputeRiskEvidenceComplete} onClick={() => review('prepare')}>Review dispute prepare</button>}
      </div>}
      {confirmation && <div className="wallet-confirm"><h3>Confirm account dispute command</h3><dl><div><dt>Operation</dt><dd>{confirmation.intent === 'prepare' ? 'prepareDispute' : confirmation.intent === 'finalize' ? 'disputeFinalize' : 'reopenDisputedAccount'}</dd></div><div><dt>Counterparty</dt><dd>{account.counterpartyId}</dd></div><div><dt>State evidence</dt><dd>{confirmation.evidence}</dd></div>{confirmation.acceptedLossRaw && <div><dt>Accepted loss</dt><dd>{confirmation.acceptedLossRaw} raw</dd></div>}</dl><div className="wallet-action-row"><button type="button" className="wallet-button-secondary" disabled={submitting} onClick={() => setConfirmation(null)}>Back</button><button type="button" className="wallet-button-danger" disabled={!time.isLive || submitting} onClick={() => void submit()}>{submitting ? 'Submitting…' : 'Submit exact command'}</button></div></div>}
      {error && <p className="wallet-inline-error" role="alert">{error}</p>}
      <WalletCommandReceipt receipt={receipt} />
    </section>
  );
};

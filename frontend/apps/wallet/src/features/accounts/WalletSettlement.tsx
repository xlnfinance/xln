import { useState } from 'react';
import type { RuntimeInput } from '@xln/runtime/api/public/runtime-module';

import type { CommandReceipt } from '$lib/stores/runtimeCommandBus';
import { timeStateExternalStore } from '$lib/stores/timeStore';
import { useExternalStore } from '../../../../../packages/react-adapters/use-external-store';
import {
  buildWalletPendingBatchInput,
  buildWalletSettlementApproveInput,
  buildWalletSettlementExecuteInput,
  buildWalletSettlementRejectInput,
} from '../../../../../packages/runtime-client/wallet-financial-input-adapter';
import type { WalletEntityAccountsView } from './account-view-model';
import { submitWalletFinancialCommand } from './wallet-financial-actions';
import { WalletCommandReceipt } from './WalletCommandReceipt';
import { walletAccountStoreController } from './wallet-account-store';

type SettlementIntent = 'approve' | 'execute' | 'reject' | 'clear' | 'broadcast' | 'rebroadcast';

type SettlementConfirmation = Readonly<{
  intent: SettlementIntent;
  input: RuntimeInput;
  evidence: string;
  counterpartyId: string | null;
  workspaceHash: string | null;
}>;

const operationFor = (intent: SettlementIntent): string => ({
  approve: 'settle_approve',
  execute: 'settle_execute',
  reject: 'settle_reject',
  clear: 'j_clear_batch',
  broadcast: 'j_broadcast',
  rebroadcast: 'j_rebroadcast',
})[intent];

export const WalletSettlement = ({
  entity,
  receipt,
}: Readonly<{ entity: WalletEntityAccountsView; receipt: CommandReceipt | null }>) => {
  const time = useExternalStore(timeStateExternalStore);
  const [counterpartyId, setCounterpartyId] = useState(entity.accounts[0]?.counterpartyId ?? '');
  const account = entity.accounts.find(candidate => candidate.counterpartyId === counterpartyId) ?? entity.accounts[0] ?? null;
  const [confirmation, setConfirmation] = useState<SettlementConfirmation | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const buildConfirmation = (intent: SettlementIntent): SettlementConfirmation => {
    const owner = { entityId: entity.entityId, signerId: entity.signerId };
    const input = intent === 'approve'
        ? buildWalletSettlementApproveInput({
            ...owner,
            counterpartyEntityId: account?.counterpartyId ?? '',
            workspaceHash: account?.workspaceHash ?? '',
          })
        : intent === 'execute'
          ? buildWalletSettlementExecuteInput({ ...owner, counterpartyEntityId: account?.counterpartyId ?? '' })
          : intent === 'reject'
            ? buildWalletSettlementRejectInput({
                ...owner,
                counterpartyEntityId: account?.counterpartyId ?? '',
                reason: 'rejected-from-wallet',
              })
            : buildWalletPendingBatchInput(owner, intent);
    const isBatch = intent === 'clear' || intent === 'broadcast' || intent === 'rebroadcast';
    return Object.freeze({
      intent,
      input,
      evidence: isBatch
        ? `${entity.batch.mode ?? 'empty'}:${entity.batch.draftCount}:${entity.batch.sentCount}`
        : account?.workspaceHash ?? '',
      counterpartyId: isBatch ? null : account?.counterpartyId ?? null,
      workspaceHash: isBatch ? null : account?.workspaceHash ?? null,
    });
  };

  const review = (intent: SettlementIntent): void => {
    try {
      setError(null);
      setConfirmation(buildConfirmation(intent));
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
      const currentEvidence = confirmation.counterpartyId === null
        ? `${entity.batch.mode ?? 'empty'}:${entity.batch.draftCount}:${entity.batch.sentCount}`
        : account?.workspaceHash ?? '';
      if (currentEvidence !== confirmation.evidence) {
        throw new Error(`WALLET_SETTLEMENT_STALE_REVIEW:${confirmation.evidence}:${currentEvidence}`);
      }
      await submitWalletFinancialCommand(
        `wallet-settlement:${confirmation.intent}:${entity.entityId}:${confirmation.evidence}`,
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

  const batchIntent = confirmation?.counterpartyId === null;
  return (
    <section className="wallet-operation wallet-settlement" data-testid="wallet-settlement">
      <header><p className="wallet-eyebrow">bilateral workspace · explicit on-j batch</p><h2>Settlement</h2></header>
      {!time.isLive && <p className="wallet-inline-error" role="alert">Historical state is read-only. Return to LIVE mode before submitting settlement commands.</p>}
      <label><span>Account</span><select value={account?.counterpartyId ?? ''} disabled={submitting || entity.accounts.length === 0} onChange={event => { setCounterpartyId(event.target.value); setConfirmation(null); }}>
        {entity.accounts.map(item => <option key={item.counterpartyId} value={item.counterpartyId}>{item.counterpartyId}</option>)}
      </select></label>
      {!account ? <p className="wallet-empty-state">Open a bilateral account before creating or approving a settlement.</p> : (
        <div className="wallet-settlement-workspace">
          <div><span>Workspace status</span><strong>{account.workspaceStatus ?? 'none'}</strong></div>
          <div><span>Revision</span><strong>{account.workspaceRevision ?? '—'}</strong></div>
          <div><span>Local Hanko</span><strong>{account.workspaceHasLocalHanko ? 'present' : 'missing'}</strong></div>
          <div><span>Peer Hanko</span><strong>{account.workspaceHasPeerHanko ? 'present' : 'missing'}</strong></div>
          <code>{account.workspaceHash ?? 'No active workspace'}</code>
          {account.workspaceHash && !confirmation && <div className="wallet-action-row">
            {!account.workspaceHasLocalHanko && account.workspaceStatus !== 'submitted' && <button type="button" disabled={!time.isLive || submitting} onClick={() => review('approve')}>Review approval</button>}
            {account.workspaceStatus === 'ready_to_submit' && account.workspaceLocalIsExecutor && <button type="button" disabled={!time.isLive || submitting} onClick={() => review('execute')}>Review execution</button>}
            {account.workspaceStatus !== 'submitted' && <button type="button" className="wallet-button-secondary" disabled={!time.isLive || submitting} onClick={() => review('reject')}>Review rejection</button>}
          </div>}
        </div>
      )}
      <div className="wallet-batch-evidence">
        <header><div><span>Entity J-batch</span><strong>{entity.batch.mode ?? 'empty'} · {entity.batch.status ?? 'ready'}</strong></div><em>{entity.batch.draftCount} draft / {entity.batch.sentCount} sent</em></header>
        {entity.batch.reserveIssue && <p className="wallet-inline-error" role="alert">Broadcast blocked: {entity.batch.reserveIssue.opType} token {entity.batch.reserveIssue.tokenId} requires {entity.batch.reserveIssue.requiredAmountRaw} raw; {entity.batch.reserveIssue.availableAfterDebtRaw} raw remains after debt.</p>}
        {!confirmation && <div className="wallet-action-row">
          {(entity.batch.hasDraftBatch || entity.batch.hasSentBatch) && <button type="button" className="wallet-button-secondary" disabled={!time.isLive || submitting} onClick={() => review('clear')}>Review clear</button>}
          {entity.batch.hasDraftBatch && <button type="button" disabled={!time.isLive || submitting || !entity.batch.canBroadcast} onClick={() => review('broadcast')}>Review broadcast</button>}
          {entity.batch.hasSentBatch && <button type="button" disabled={!time.isLive || submitting} onClick={() => review('rebroadcast')}>Review rebroadcast</button>}
        </div>}
      </div>
      {confirmation && (
        <div className="wallet-confirm" data-testid="wallet-settlement-confirmation">
          <h3>Confirm exact settlement command</h3>
          <dl>
            <div><dt>Operation</dt><dd>{operationFor(confirmation.intent)}</dd></div>
            <div><dt>Entity</dt><dd>{entity.entityId}</dd></div>
            <div><dt>{batchIntent ? 'Batch evidence' : 'Counterparty'}</dt><dd>{batchIntent ? confirmation.evidence : confirmation.counterpartyId}</dd></div>
            {!batchIntent && <div><dt>Workspace</dt><dd>{confirmation.workspaceHash}</dd></div>}
          </dl>
          <div className="wallet-action-row"><button type="button" className="wallet-button-secondary" disabled={submitting} onClick={() => setConfirmation(null)}>Back</button><button type="button" disabled={!time.isLive || submitting} onClick={() => void submit()}>{submitting ? 'Submitting…' : `Submit ${operationFor(confirmation.intent)}`}</button></div>
        </div>
      )}
      {error && <p className="wallet-inline-error" role="alert">{error}</p>}
      <WalletCommandReceipt receipt={receipt} />
    </section>
  );
};

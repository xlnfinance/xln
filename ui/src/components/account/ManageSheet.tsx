import { useMemo, useState } from 'react';
import { LoadTestingPanel } from './load-testing/Panel';
import { Sheet } from '../Sheet';
import { ClausesPanel } from './ClausesPanel';
import { DisputeControls } from './DisputeControls';
import { useApp } from '../../runtime/store';
import { sendEntityTxs } from '../../runtime/tx';
import { formatMoney, parseAmount, plainAmount } from '../../runtime/format';
import { getTokenMeta, knownTokenIds } from '../../runtime/token-meta';
import type { AccountView, WalletView } from '../../runtime/views';
import {
  buildAddTokenTx,
  buildRequestCollateralTx,
  collateralFee,
  counterpartyFeePolicy,
  requestCreditFromHub,
} from '../../runtime/financial/manage';
export type ManageTab = 'collateral' | 'credit' | 'token' | 'clauses' | 'dispute' | 'load-testing';

export function ManageSheet({
  account,
  wallet,
  onClose,
  initialTab,
}: {
  account: AccountView;
  wallet: WalletView;
  onClose: () => void;
  initialTab?: ManageTab;
}) {
  const toast = useApp(s => s.toast);
  const selectedTokenId = useApp(s => s.selectedTokenId);
  const [selectedTab, setTab] = useState<ManageTab>(
    initialTab ?? (account.dispute !== 'none' ? 'dispute' : 'collateral'),
  );
  const tab = account.dispute === 'closed' ? 'dispute' : selectedTab;
  const [tokenId, setTokenId] = useState(selectedTokenId);
  const [amountText, setAmountText] = useState('');
  const [creditText, setCreditText] = useState('');
  const [addTokenId, setAddTokenId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const meta = getTokenMeta(tokenId);
  const counterpartyId = account.counterpartyId;
  const laneTokenIds = new Set(account.tokens.map(token => token.tokenId));
  const addable = knownTokenIds().filter(id => !laneTokenIds.has(id));
  const policy = counterpartyFeePolicy(account.doc, account.isLeft, tokenId);
  const amount = useMemo(() => {
    try {
      return amountText.trim() ? parseAmount(amountText, meta.decimals) : 0n;
    } catch {
      return 0n;
    }
  }, [amountText, meta.decimals]);
  const fee = policy && amount > 0n ? collateralFee(policy, amount) : 0n;
  const net = amount > fee ? amount - fee : 0n;

  // What is actually worth covering: the part of what they owe that no
  // collateral stands behind. Collateral past that secures nothing and still
  // pays their fee, so the form says so instead of letting it happen quietly.
  //
  // The fee is prepaid in the same token, so it also shrinks what they owe by
  // exactly the fee, and the hub never locks more than it owes. Requesting the
  // uncovered amount itself therefore covers everything left after the fee
  // with no remainder; asking for more leaves a pending tail that blocks the
  // next request until the debt grows into it.
  const uncoveredPromise = account.tokens.find(token => token.tokenId === tokenId)?.derived.outPeerCredit ?? 0n;
  const coverAmount =
    policy && uncoveredPromise > 0n && collateralFee(policy, uncoveredPromise) < uncoveredPromise
      ? uncoveredPromise
      : 0n;
  const excess = amount > uncoveredPromise ? amount - uncoveredPromise : 0n;

  const run = async (label: string, work: () => Promise<void>): Promise<void> => {
    setBusy(true);
    try {
      await work();
      toast(label);
      onClose();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'danger');
    } finally {
      setBusy(false);
    }
  };
  const send = (txs: Parameters<typeof sendEntityTxs>[2]): Promise<unknown> => {
    if (!wallet.signerId) throw new Error('No signer for this entity');
    return sendEntityTxs(wallet.entityId, wallet.signerId, txs);
  };

  const tabs: Array<{ id: ManageTab; label: string }> = [
    { id: 'collateral', label: 'Collateral' },
    ...(account.isHub ? [{ id: 'credit' as const, label: 'Credit' }] : []),
    { id: 'token', label: 'Add token' },
    { id: 'clauses', label: 'Clauses' },
    { id: 'dispute', label: 'Dispute' },
    ...(account.isHub ? [{ id: 'load-testing' as const, label: 'Load Testing' }] : []),
  ];

  return (
    <Sheet title={`Manage · ${account.label}`} onClose={onClose}>
      <div className="segc" style={{ marginBottom: 14, display: 'flex', flexWrap: 'wrap' }} role="tablist">
        {tabs.map(entry => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            disabled={account.disputed && entry.id !== 'dispute'}
            className={tab === entry.id ? 'active' : ''}
            onClick={() => setTab(entry.id)}
            data-testid={`manage-tab-${entry.id}`}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {tab === 'load-testing' ? (
        <LoadTestingPanel
          key={`${wallet.entityId}:${counterpartyId}`}
          entityId={wallet.entityId}
          signerId={wallet.signerId}
          summaries={wallet.summaries}
          hubId={counterpartyId}
        />
      ) : null}

      {tab === 'collateral' ? (
        <div className="fade-in">
          <p className="note">
            Ask {account.label} to lock collateral on-chain against what they owe you. They charge their published fee,
            taken from the amount; the rest becomes enforceable collateral.
          </p>
          <div className="field">
            <span className="field-label">Token</span>
            <div className="mode-grid">
              {account.tokens.map(token => (
                <button
                  key={token.tokenId}
                  type="button"
                  className={`mode-card${tokenId === token.tokenId ? ' active' : ''}`}
                  onClick={() => setTokenId(token.tokenId)}
                >
                  <span className="t">{getTokenMeta(token.tokenId).symbol}</span>
                  <span className="s">{getTokenMeta(token.tokenId).name}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <span className="field-label">Gross amount</span>
            <div className="field-row">
              <input
                className="input big"
                placeholder="0.00"
                inputMode="decimal"
                value={amountText}
                onChange={event => setAmountText(event.target.value)}
                data-testid="collateral-amount"
              />
              <span className="muted">{meta.symbol}</span>
              {coverAmount > 0n ? (
                <button
                  type="button"
                  className="btn quiet sm"
                  onClick={() => setAmountText(plainAmount(coverAmount, meta.decimals))}
                  data-testid="collateral-cover-promise"
                >
                  Cover the promise
                </button>
              ) : null}
            </div>
            {uncoveredPromise > 0n ? (
              <p className="note">
                {account.label} owes you {formatMoney(uncoveredPromise, meta.decimals)} {meta.symbol} that no collateral
                stands behind.
              </p>
            ) : null}
          </div>
          {policy ? (
            <div style={{ marginBottom: 12 }}>
              <div className="kv">
                <span className="k">Their fee</span>
                <span className="v num">
                  {formatMoney(policy.baseFee + policy.gasFee, meta.decimals)} +{' '}
                  {(Number(policy.liquidityFeeBps) / 100).toFixed(2)}%
                </span>
              </div>
              {amount > 0n ? (
                <>
                  <div className="kv">
                    <span className="k">Fee on this request</span>
                    <span className="v num">{formatMoney(fee, meta.decimals)}</span>
                  </div>
                  <div className="kv">
                    <span className="k">Collateral you get</span>
                    <span className="v num st-settled">{formatMoney(net, meta.decimals)}</span>
                  </div>
                </>
              ) : null}
            </div>
          ) : (
            <p className="note" style={{ color: 'var(--debt)' }}>
              {account.label} has not published a fee policy for {meta.symbol} on this account yet. The request needs
              their committed policy frame.
            </p>
          )}
          {excess > 0n && amount > 0n ? (
            <p className="note" style={{ color: 'var(--debt)' }}>
              {account.label} only locks what it owes you, so {formatMoney(excess, meta.decimals)} {meta.symbol} of this
              request stays pending until it owes you more, and blocks a new request meanwhile. You still pay their fee
              on it now.
            </p>
          ) : null}
          <button
            type="button"
            className="btn primary"
            disabled={account.disputed || busy || !policy || amount <= 0n || net <= 0n}
            onClick={() =>
              void run(`Collateral request sent to ${account.label}`, async () => {
                await send([buildRequestCollateralTx(counterpartyId, tokenId, amount, policy!)]);
              })
            }
            data-testid="collateral-request"
          >
            {busy ? 'Sending…' : 'Request collateral'}
          </button>
        </div>
      ) : null}

      {tab === 'credit' ? (
        <div className="fade-in">
          <p className="note">
            Ask the hub to extend you a credit line in {meta.symbol}. Your signed request commits in this account; the
            hub answers with up to 1,000 {meta.symbol} per request, shown as “their credit line to you”.
          </p>
          <div className="field">
            <span className="field-label">Token</span>
            <div className="mode-grid">
              {account.tokens.map(token => (
                <button
                  key={token.tokenId}
                  type="button"
                  className={`mode-card${tokenId === token.tokenId ? ' active' : ''}`}
                  onClick={() => setTokenId(token.tokenId)}
                >
                  <span className="t">{getTokenMeta(token.tokenId).symbol}</span>
                  <span className="s">{getTokenMeta(token.tokenId).name}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <span className="field-label">Credit line</span>
            <div className="field-row">
              <input
                className="input big"
                placeholder="0.00"
                inputMode="decimal"
                value={creditText}
                onChange={event => setCreditText(event.target.value)}
                data-testid="credit-amount"
              />
              <span className="muted">{meta.symbol}</span>
            </div>
          </div>
          <button
            type="button"
            className="btn primary"
            disabled={account.disputed || busy || !creditText.trim()}
            onClick={() =>
              void run('Credit requested from the hub', async () => {
                const value = parseAmount(creditText, meta.decimals);
                if (value <= 0n) throw new Error('Enter a positive amount');
                if (!wallet.signerId) throw new Error('No signer for this entity');
                await requestCreditFromHub({
                  entityId: wallet.entityId,
                  signerId: wallet.signerId,
                  hubEntityId: counterpartyId,
                  tokenId,
                  amount: value,
                });
              })
            }
            data-testid="credit-request"
          >
            {busy ? 'Asking…' : 'Request credit'}
          </button>
          <p className="note" style={{ marginTop: 8 }}>
            Signed inside your account with the hub; no operator access needed.
          </p>
        </div>
      ) : null}

      {tab === 'token' ? (
        <div className="fade-in">
          <p className="note">
            Adds a lane for another token with zero credit. Use “Extend credit” afterwards to set a line.
          </p>
          {addable.length === 0 ? (
            <p className="note">Every known token already has a lane here.</p>
          ) : (
            <div className="field">
              <span className="field-label">Token</span>
              <div className="mode-grid">
                {addable.map(id => (
                  <button
                    key={id}
                    type="button"
                    className={`mode-card${addTokenId === id ? ' active' : ''}`}
                    onClick={() => setAddTokenId(id)}
                    data-testid={`add-token-${getTokenMeta(id).symbol}`}
                  >
                    <span className="t">{getTokenMeta(id).symbol}</span>
                    <span className="s">{getTokenMeta(id).name}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <button
            type="button"
            className="btn primary"
            disabled={account.disputed || busy || addTokenId === null}
            onClick={() =>
              void run(`${getTokenMeta(addTokenId ?? 0).symbol} lane proposed`, async () => {
                await send([buildAddTokenTx(counterpartyId, addTokenId!)]);
              })
            }
            data-testid="add-token-submit"
          >
            {busy ? 'Proposing…' : 'Add token'}
          </button>
        </div>
      ) : null}

      {tab === 'clauses' ? <ClausesPanel account={account} /> : null}

      {tab === 'dispute' ? <DisputeControls account={account} wallet={wallet} onClose={onClose} /> : null}
    </Sheet>
  );
}

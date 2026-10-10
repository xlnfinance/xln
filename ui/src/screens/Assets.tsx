import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Bar } from '../components/Bars';
import { CopyId } from '../components/CopyId';
import { ReceiveCapacity } from '../components/ReceiveCapacity';
import { Icon } from '../components/Icons';
import { TokenIcon } from '../components/TokenPicker';
import { useApp } from '../runtime/store';
import { formatMoney, getTokenMeta, knownTokenIds, parseAmount, shortId } from '../runtime/format';
import { usdOf } from '../runtime/financial/prices';
import { useWallet } from '../runtime/views';
import { requestFaucet, readExternalWallet, type ExternalWallet, type FaucetKind } from '../runtime/financial/external';
import { debtGroups, enforceDebts, type DebtGroup } from '../runtime/financial/debts';
import { getAdapter } from '../runtime/adapter';
import { accountNetBalance } from '@xln/frontend/lib/utils/ui/accountBalance';

/**
 * Money outside the bilateral accounts: the signer's on-chain wallet with
 * its Depository allowances, the faucets a test runtime offers, and the
 * Depository's debt ledger against this entity.
 */
export function Assets() {
  const navigate = useNavigate();
  const { hash } = useLocation();
  const faucetOnly = hash === '#faucets';
  const entityId = useApp(s => s.activeEntityId);
  const toast = useApp(s => s.toast);
  const height = useApp(s => s.height);
  const wallet = useWallet(entityId);
  const [external, setExternal] = useState<ExternalWallet | null>(null);
  const [externalError, setExternalError] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [faucetAmount, setFaucetAmount] = useState('100');
  const [faucetTokenId, setFaucetTokenId] = useState(1);
  const [faucetNotice, setFaucetNotice] = useState<{ kind: 'pending' | 'accepted' | 'error'; text: string } | null>(
    null,
  );
  const debts = debtGroups(wallet.frame);
  const hubs = wallet.accounts.filter(account => account.isHub && !account.disputed);
  const [faucetHubId, setFaucetHubId] = useState('');
  const faucetHub = hubs.find(account => account.counterpartyId === faucetHubId) ?? hubs[0];
  const faucetMeta = getTokenMeta(faucetTokenId);
  let faucetRequired = 0n;
  try {
    faucetRequired = parseAmount(faucetAmount, faucetMeta.decimals);
  } catch {
    /* The amount field may be incomplete while typing. */
  }
  const faucetDerived = faucetHub?.tokens.find(token => token.tokenId === faucetTokenId)?.derived;
  const faucetCapacity = faucetDerived?.inCapacity ?? 0n;
  const faucetAccountBalance = faucetDerived ? accountNetBalance(faucetDerived) : 0n;
  const faucetReserveBalance = wallet.reserves
    .filter(row => row.tokenId === faucetTokenId)
    .reduce((sum, row) => sum + row.amount, 0n);
  const canReceiveFaucet = Boolean(faucetHub && faucetRequired > 0n && faucetCapacity >= faucetRequired);
  useEffect(() => {
    if (hash === '#faucets') document.getElementById('faucets')?.scrollIntoView({ block: 'start' });
  }, [hash]);

  const refresh = useCallback(async () => {
    if (!wallet.entityId || !wallet.signerId) return;
    setLoading(true);
    try {
      setExternal(await readExternalWallet(wallet.entityId, wallet.signerId));
      setExternalError('');
    } catch (error) {
      setExternal(null);
      setExternalError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [wallet.entityId, wallet.signerId]);

  useEffect(() => {
    void refresh();
  }, [refresh, height]);

  const run = async (key: string, label: string, work: () => Promise<void>): Promise<void> => {
    setBusy(key);
    if (key.startsWith('faucet-')) setFaucetNotice({ kind: 'pending', text: 'Requesting test money…' });
    try {
      await work();
      if (key.startsWith('faucet-')) setFaucetNotice({ kind: 'accepted', text: label });
      else toast(label);
      void refresh();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (key.startsWith('faucet-')) setFaucetNotice({ kind: 'error', text });
      else toast(text, 'danger');
    } finally {
      setBusy(null);
    }
  };

  const faucet = (kind: FaucetKind): Promise<void> =>
    run(
      `faucet-${kind}`,
      kind === 'offchain'
        ? 'Payment requested. Your Account balance updates when the hub payment is confirmed.'
        : `Request accepted. Check ${kind === 'reserve' ? 'your Reserve on Home' : 'your on-chain wallet balance'}.`,
      async () => {
        if (kind === 'offchain' && !canReceiveFaucet)
          throw new Error('Prepare capacity in the selected account before requesting this payment.');
        const amount = faucetAmount.trim() || '0';
        await requestFaucet(kind, {
          jurisdiction: wallet.jurisdiction,
          entityId: wallet.entityId,
          signerId: wallet.signerId,
          runtimeId: getAdapter()?.runtimeId ?? '',
          ...(faucetHub ? { hubEntityId: faucetHub.counterpartyId } : {}),
          tokenId: faucetTokenId,
          tokenSymbol: kind === 'gas' ? 'ETH' : faucetMeta.symbol,
          amount,
        });
      },
    );

  return (
    <div className="screen fade-in">
      <div className="screen-header">
        <span className="screen-title">
          <button type="button" className="icon-btn" onClick={() => navigate(-1)} aria-label="Back" data-testid="back">
            <Icon name="chevronLeft" size={18} />
          </button>
          {faucetOnly ? 'Add test money' : 'Assets'}
        </span>
      </div>
      <div className={faucetOnly ? 'faucet-page' : 'two-col'}>
        {!faucetOnly && (
          <div>
            <div className="card" data-testid="external-wallet">
              <div className="sect" style={{ marginTop: 0 }}>
                <h3 className="caps">On-chain wallet</h3>
                <button type="button" className="more" onClick={() => void refresh()} disabled={loading}>
                  {loading ? 'Reading…' : 'Refresh'}
                </button>
              </div>
              <div className="kv">
                <span className="k">Signer</span>
                <span className="v" style={{ fontWeight: 400 }}>
                  <CopyId value={wallet.signerId} label="Signer address" />
                </span>
              </div>
              <p className="note">Gas and fungible tokens at your signing address. Company share reserves are in <button type="button" className="more" onClick={() => navigate('/ownership')}>Ownership</button>; external NFT and share balances are not shown here.</p>
              {external ? (
                <>
                  <div className="kv">
                    <span className="k">Depository</span>
                    <span className="v mono" style={{ fontWeight: 400 }}>
                      {shortId(external.depository, 8, 6)}
                    </span>
                  </div>
                  <div className="kv">
                    <span className="k">Gas</span>
                    <span className="v num">
                      {external.native === null ? '—' : `${formatMoney(external.native, 18, 4)} ETH`}
                    </span>
                  </div>
                  {external.rows.map((row, index) => (
                    <div
                      key={row.tokenId}
                      className={`row${index === 0 ? ' first' : ''}`}
                      data-testid={`external-row-${row.symbol}`}
                    >
                      <span className="rt">
                        <TokenIcon tokenId={row.tokenId} />
                        <span className="tx">
                          <span className="t">{row.symbol}</span>
                          <span className="s">
                            {row.error
                              ? row.error
                              : row.allowance === null
                                ? row.name
                                : `Depository may pull ${formatMoney(row.allowance, row.decimals)}`}
                          </span>
                        </span>
                        <span className="r">
                          <span className="v num" data-testid={`external-balance-${row.symbol}`}>
                            {formatMoney(row.balance, row.decimals)}
                          </span>
                        </span>
                      </span>
                      <span className="rb" style={{ display: 'block' }}>
                        <Bar segments={[{ usd: usdOf(row.tokenId, row.balance), kind: 'onchain' }]} height={4} />
                      </span>
                    </div>
                  ))}
                  <div className="actions" style={{ marginTop: 12 }}>
                    <button type="button" className="btn" onClick={() => navigate('/move?from=external&to=reserve')}>
                      <Icon name="arrow" size={15} />
                      Move into reserve
                    </button>
                  </div>
                </>
              ) : (
                <p className="note" style={{ marginTop: 8 }}>
                  {externalError
                    ? externalError.includes('LOCAL_RUNTIME')
                      ? 'A remote runtime does not expose the signer wallet here. Read it from the chain explorer.'
                      : externalError
                    : 'Reading the chain…'}
                </p>
              )}
            </div>

            <div className="card" data-testid="debts">
              <h3 className="caps">Debts</h3>
              {debts.owed.length === 0 && debts.owedToUs.length === 0 ? (
                <p className="note" style={{ marginTop: 8 }}>
                  No debts on the Depository. A debt appears when a settlement or dispute closes with more owed than
                  there was collateral.
                </p>
              ) : null}
              {debts.owed.map(group => (
                <DebtRows
                  key={`out-${group.tokenId}`}
                  group={group}
                  names={wallet.names}
                  busy={busy === `debt-${group.tokenId}`}
                  onEnforce={() =>
                    void run(`debt-${group.tokenId}`, 'Repayment from reserve queued', () =>
                      enforceDebts({
                        entityId: wallet.entityId,
                        signerId: wallet.signerId,
                        jurisdictionName: wallet.jurisdiction,
                        tokenId: group.tokenId,
                      }),
                    )
                  }
                />
              ))}
              {debts.owedToUs.map(group => (
                <DebtRows key={`in-${group.tokenId}`} group={group} names={wallet.names} busy={false} />
              ))}
            </div>
          </div>
        )}
        <div className="aside">
          <div className="card" id="faucets" data-testid="faucets" style={{ scrollMarginTop: 20 }}>
            <h3 className="caps">Test network funds</h3>
            <p className="note" style={{ marginTop: 8 }}>
              Receive test funds to try payments and swaps. These tokens have no monetary value.
            </p>
            <div className="kv">
              <span className="k">Account · {faucetHub?.label ?? 'no hub'}</span>
              <b className="v num" data-testid="faucet-account-balance">
                {formatMoney(faucetAccountBalance, faucetMeta.decimals)} {faucetMeta.symbol}
              </b>
            </div>
            <div className="kv">
              <span className="k">Reserve</span>
              <b className="v num" data-testid="faucet-reserve-balance">
                {formatMoney(faucetReserveBalance, faucetMeta.decimals)} {faucetMeta.symbol}
              </b>
            </div>
            <div className="field">
              <span className="field-label">Token</span>
              <div className="mode-grid">
                {knownTokenIds().map(id => (
                  <button
                    key={id}
                    type="button"
                    className={`mode-card${faucetTokenId === id ? ' active' : ''}`}
                    onClick={() => setFaucetTokenId(id)}
                    aria-pressed={faucetTokenId === id}
                  >
                    <span className="t">{getTokenMeta(id).symbol}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="faucet-amount">
                Amount
              </label>
              <div className="field-row">
                <input
                  id="faucet-amount"
                  className="input"
                  inputMode="decimal"
                  value={faucetAmount}
                  onChange={event => setFaucetAmount(event.target.value)}
                  data-testid="faucet-amount"
                />
                <span className="muted">{faucetMeta.symbol}</span>
              </div>
            </div>
            {hubs.length > 1 ? (
              <label className="field">
                Receive through
                <select
                  className="input"
                  value={faucetHub?.counterpartyId ?? ''}
                  onChange={event => setFaucetHubId(event.target.value)}
                  data-testid="faucet-hub"
                >
                  {hubs.map(account => (
                    <option key={account.counterpartyId} value={account.counterpartyId}>
                      {account.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {!faucetHub ? (
              <p className="note" role="status">
                No open hub account. Open one from Home to receive off-chain; wallet and Reserve faucets are still
                available.
              </p>
            ) : null}
            {faucetHub && faucetRequired > 0n ? (
              <ReceiveCapacity
                account={faucetHub.doc.state}
                ownerEntityId={wallet.entityId}
                signerId={wallet.signerId}
                counterpartyEntityId={faucetHub.counterpartyId}
                accountLabel={faucetHub.label}
                jurisdiction={wallet.jurisdiction}
                tokenId={faucetTokenId}
                requiredAmount={faucetRequired}
                disabled={busy !== null}
              />
            ) : null}
            <div style={{ display: 'grid', gap: 8 }}>
              <button
                type="button"
                className="btn primary"
                disabled={busy !== null || !canReceiveFaucet}
                onClick={() => void faucet('offchain')}
                data-testid="faucet-offchain"
              >
                {busy === 'faucet-offchain'
                  ? 'Asking…'
                  : `Receive ${faucetMeta.symbol} from ${faucetHub?.label ?? 'hub'}`}
              </button>
              <details className="disclosure" open={!faucetOnly}>
                <summary>On-chain & reserve funding</summary>
                <p className="note">
                  For deposits and settlement. Move these funds into an Account before making instant payments.
                </p>
                <div className="stack">
                  <button
                    type="button"
                    className="btn"
                    disabled={busy !== null || faucetRequired <= 0n}
                    onClick={() => void faucet('erc20')}
                    data-testid="faucet-erc20"
                  >
                    {busy === 'faucet-erc20' ? 'Minting…' : `${faucetMeta.symbol} to my on-chain wallet`}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy !== null}
                    onClick={() => void faucet('gas')}
                    data-testid="faucet-gas"
                  >
                    {busy === 'faucet-gas' ? 'Sending…' : '0.1 ETH for gas to my on-chain wallet'}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy !== null || faucetRequired <= 0n}
                    onClick={() => void faucet('reserve')}
                    data-testid="faucet-reserve"
                  >
                    {busy === 'faucet-reserve' ? 'Asking…' : `${faucetMeta.symbol} straight into my reserve`}
                  </button>
                </div>
              </details>
            </div>
            {faucetNotice ? (
              <p
                className="note"
                style={{ overflowWrap: 'anywhere', color: faucetNotice.kind === 'error' ? 'var(--debt)' : undefined }}
                role={faucetNotice.kind === 'error' ? 'alert' : 'status'}
                data-testid="faucet-status"
              >
                {faucetNotice.text}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function DebtRows({
  group,
  names,
  busy,
  onEnforce,
}: {
  group: DebtGroup;
  names: Map<string, string>;
  busy: boolean;
  onEnforce?: () => void;
}) {
  const meta = getTokenMeta(group.tokenId);
  const open = group.entries.filter(entry => entry.remainingAmount > 0n);
  return (
    <div style={{ marginTop: 10 }} data-testid={`debt-group-${group.direction}-${meta.symbol}`}>
      <div className="kv">
        <span className="k">
          {group.direction === 'out' ? 'You owe' : 'Owed to you'} · {meta.symbol}
        </span>
        <span className={`v num ${group.direction === 'out' ? 'st-pending' : 'st-settled'}`}>
          {formatMoney(group.outstanding, meta.decimals)}
        </span>
      </div>
      {open.slice(0, 6).map(entry => (
        <div key={entry.debtId} className="kv">
          <span className="k">
            #{entry.currentDebtIndex ?? entry.createdDebtIndex} ·{' '}
            {names.get(String(entry.counterparty).toLowerCase()) || shortId(String(entry.counterparty), 8, 4)}
          </span>
          <span className="v num" style={{ fontWeight: 400 }}>
            {formatMoney(entry.remainingAmount, meta.decimals)} of {formatMoney(entry.createdAmount, meta.decimals)}
          </span>
        </div>
      ))}
      {group.direction === 'out' && onEnforce && group.outstanding > 0n ? (
        <button
          type="button"
          className="btn ghost sm"
          style={{ marginTop: 8 }}
          disabled={busy}
          onClick={onEnforce}
          data-testid={`debt-enforce-${meta.symbol}`}
        >
          {busy ? 'Queuing…' : 'Pay down from reserve'}
        </button>
      ) : null}
    </div>
  );
}

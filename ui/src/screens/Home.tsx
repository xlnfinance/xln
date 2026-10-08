import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { TokenRow } from '../components/home/Balances';
import { WalletScale } from '../components/home/WalletScale';
import { BalanceDetails } from '../components/home/BalanceDetails';
import { BalancePanel } from '../components/home/BalancePanel';
import { HomeAside } from '../components/home/HomeAside';
import { TestMoney } from '../components/home/TestMoney';
import { OpenAccountSheet } from '../components/home/OpenAccountSheet';
import { EntitySwitcher } from '../components/EntitySwitcher';
import { Icon } from '../components/Icons';
import { PendingBatch } from '../components/PendingBatch';
import { Sheet } from '../components/Sheet';
import { getTokenMeta } from '../runtime/format';
import { useApp } from '../runtime/store';
import { useWallet } from '../runtime/views';
import { USER_ACTIVITY_TYPES, useMovements } from '../runtime/financial/movements';
import { ActivityHead, ActivityRow } from '../components/history/ActivityRow';

export function Home() {
  const entityId = useApp(s => s.activeEntityId);
  const wallet = useWallet(entityId);
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(() => new Set());
  const [showZero, setShowZero] = useState(false);
  const [opening, setOpening] = useState(false);
  const [addingMoney, setAddingMoney] = useState(false);
  const [selectedToken, setSelectedToken] = useState(1);
  const accountIds = useMemo(() => wallet.accounts.map(account => account.counterpartyId), [wallet.accounts]);
  const recent = useMovements(entityId, USER_ACTIVITY_TYPES, 80, accountIds);
  const movements = recent.movements.filter(row => row.kind !== 'account').slice(0, 6);
  const totals = wallet.totals.filter(total => showZero || total.active);
  const emptyCount = wallet.totals.filter(total => !total.active).length;
  const balanceTokens = wallet.totals.filter(total => total.active || total.tokenId === 1);
  const balanceToken = balanceTokens.find(total => total.tokenId === selectedToken) ?? balanceTokens[0];

  return (
    <WalletScale>
      <TestMoney key={wallet.entityId} wallet={wallet} />
      <header className="page-head">
        <div>
          <span className="crumb static">Wallet{wallet.jurisdiction ? ` · ${wallet.jurisdiction}` : ''}</span>
          <EntitySwitcher name={wallet.name} status={null} />
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="icon-btn"
            onClick={() => navigate('/sovereignty')}
            aria-label="Security and recovery"
            title="Security and recovery"
            data-testid="home-sovereignty"
          >
            <Icon name="shield" size={17} />
          </button>
        </div>
        <span hidden data-testid="home-entity-id">
          {wallet.entityId}
        </span>
      </header>
      {balanceToken && balanceTokens.length > 1 && (
        <div
          className="tabs"
          role="tablist"
          aria-label="Balance asset"
          data-testid="home-balance-asset"
          data-value={balanceToken.tokenId}
        >
          {balanceTokens.map(token => (
            <button
              key={token.tokenId}
              type="button"
              role="tab"
              aria-selected={token.tokenId === balanceToken.tokenId}
              data-testid={`home-asset-${token.tokenId}`}
              onClick={() => setSelectedToken(token.tokenId)}
            >
              {getTokenMeta(token.tokenId).symbol}
            </button>
          ))}
        </div>
      )}
      <div className="dash">
        <div className="dash-main">
          <BalancePanel wallet={wallet} token={balanceToken} onAddMoney={() => setAddingMoney(true)} />
          <PendingBatch wallet={wallet} compact />
          <BalanceDetails wallet={wallet} />
          <div className="wallet-sections">
            <section aria-label="Assets">
              <div className="sect">
                <h3>Assets</h3>
              </div>
              {totals.map((total, index) => (
                <TokenRow
                  key={total.tokenId}
                  total={total}
                  wallet={wallet}
                  first={index === 0}
                  open={!collapsed.has(total.tokenId)}
                  onToggle={() =>
                    setCollapsed(previous => {
                      const next = new Set(previous);
                      if (next.has(total.tokenId)) next.delete(total.tokenId);
                      else next.add(total.tokenId);
                      return next;
                    })
                  }
                  onAccount={id => navigate(`/accounts/${id}`)}
                />
              ))}
              {totals.length === 0 && !wallet.loading && !wallet.error && (
                <p className="note wallet-empty">No funds yet. Get test money above to make your first payment.</p>
              )}
              {emptyCount > 0 && (
                <button
                  type="button"
                  className="more wallet-show-assets"
                  aria-expanded={showZero}
                  data-testid="home-show-zero"
                  onClick={() => setShowZero(value => !value)}
                >
                  {showZero
                    ? 'Hide zero balances'
                    : `Show ${emptyCount} ${emptyCount === 1 ? 'asset' : 'assets'} with zero balance`}
                </button>
              )}
            </section>
            <section aria-label="Recent activity">
              <div className="sect">
                <h3>Recent activity</h3>
                <button type="button" className="more" onClick={() => navigate('/activity')}>
                  View all
                </button>
              </div>
              <div className="dtable">
                {movements.length > 0 ? <ActivityHead /> : null}
                {recent.loading && (
                  <p className="note" role="status">
                    Loading recent activity…
                  </p>
                )}
                {movements.map((movement, index) => (
                  <ActivityRow
                    key={movement.id}
                    movement={movement}
                    names={wallet.names}
                    first={index === 0}
                    onClick={() => navigate('/activity', { state: { movementId: movement.id } })}
                  />
                ))}
                {movements.length === 0 &&
                  !recent.loading &&
                  !recent.error &&
                  (recent.nextBeforeHeight !== null ? (
                    <button type="button" className="more" onClick={() => navigate('/activity')}>
                      Open full payment history
                    </button>
                  ) : (
                    <p className="note wallet-empty">Your payments and swaps will appear here.</p>
                  ))}
              </div>
              {recent.error && (
                <p role="alert" className="note">
                  Activity unavailable: {recent.error}
                </p>
              )}
            </section>
          </div>
        </div>
        <HomeAside wallet={wallet} token={balanceToken} onConnect={() => setOpening(true)} />
      </div>
      {opening && <OpenAccountSheet wallet={wallet} onClose={() => setOpening(false)} />}
      {addingMoney && (
        <Sheet title="Add money" onClose={() => setAddingMoney(false)}>
          <div className="stack">
            <button
              type="button"
              className="btn"
              data-testid="add-money-hub"
              onClick={() => {
                setAddingMoney(false);
                document.querySelector<HTMLElement>('[data-testid=home-faucet]')?.focus();
              }}
            >
              Get test USDC
            </button>
            <button type="button" className="btn" data-testid="add-money-request" onClick={() => navigate('/receive')}>
              Receive a payment
            </button>
            <button type="button" className="btn" data-testid="add-money-onchain" onClick={() => navigate('/assets')}>
              Deposit from the blockchain
            </button>
          </div>
        </Sheet>
      )}
    </WalletScale>
  );
}

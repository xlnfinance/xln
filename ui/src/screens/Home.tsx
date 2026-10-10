import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CopyId } from '../components/CopyId';
import { TokenRow, AccountRow } from '../components/home/Balances';
import { WalletScale } from '../components/home/WalletScale';
import { BalanceDetails } from '../components/home/BalanceDetails';
import { TestMoney } from '../components/home/TestMoney';
import { OpenAccountSheet } from '../components/home/OpenAccountSheet';
import { EntitySwitcher } from '../components/EntitySwitcher';
import { Icon } from '../components/Icons';
import { PendingBatch } from '../components/PendingBatch';
import { Sheet } from '../components/Sheet';
import { useApp } from '../runtime/store';
import { formatAmount, formatUsd, getTokenMeta } from '../runtime/format';
import { useWallet } from '../runtime/views';
import { USER_ACTIVITY_TYPES, useMovements } from '../runtime/financial/movements';
import { ActivityRow } from './Activity';
import { Help } from '../components/Help';
import { Watchtower } from '../components/Watchtower';
import { walletHelp } from '@xln/frontend/lib/utils/ui/walletHelp';
import { usdOf } from '../runtime/financial/prices';
import { useLendingBalance } from '../runtime/financial/lending-balance';

export function Home() {
  const commandReady = useApp(s => s.commandReady);
  const entityId = useApp(s => s.activeEntityId);
  const places = useApp(s => s.places);
  const wallet = useWallet(entityId);
  const lending = useLendingBalance(wallet);
  const lendingUsd = [...lending.byToken].reduce((sum, [token, value]) => sum + usdOf(token, value), 0);
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(() => new Set());
  const [showZero, setShowZero] = useState(false);
  const [opening, setOpening] = useState(false);
  const [addingMoney, setAddingMoney] = useState(false);
  const [selectedToken, setSelectedToken] = useState(0);
  const accountIds = useMemo(() => wallet.accounts.map(account => account.counterpartyId), [wallet.accounts]);
  const recent = useMovements(entityId, USER_ACTIVITY_TYPES, 80, accountIds);
  const movements = recent.movements.filter(row => row.kind !== 'account').slice(0, 5);
  const totals = wallet.totals.filter(total => showZero || total.active);
  const emptyCount = wallet.totals.filter(total => !total.active).length;
  const balanceTokens = wallet.totals.filter(total => total.active || total.tokenId === 1);
  const balanceToken = balanceTokens.find(total => total.tokenId === selectedToken);
  const meta = balanceToken ? getTokenMeta(balanceToken.tokenId) : null;
  const visibleNet = balanceToken ?
    (places.onchain ? balanceToken.onchain : 0n) +
    (places.reserve ? balanceToken.reserve : 0n) +
    (places.accounts ? balanceToken.receivable + balanceToken.owed + (lending.byToken.get(balanceToken.tokenId) ?? 0n) : 0n) : 0n;
  const visibleUsd = (places.onchain ? wallet.usd.onchain : 0) + (places.reserve ? wallet.usd.reserve : 0) + (places.accounts ? wallet.usd.receivable - wallet.usd.owed + lendingUsd : 0);
  const lendingUnavailable = places.accounts && (lending.loading || Boolean(lending.error));
  const money = (amount: bigint) => meta ? `${formatAmount(amount, meta.decimals, meta.decimals)} ${meta.symbol}` : '0';
  const held = wallet.accounts.reduce(
    (sum, account) =>
      sum + account.tokens.filter(token => token.tokenId === balanceToken?.tokenId)
        .reduce((amount, token) => amount + token.derived.outTotalHold, 0n),
    0n,
  );
  const heldUsd = wallet.accounts.reduce((sum, account) => sum + account.tokens.reduce(
    (value, token) => value + usdOf(token.tokenId, token.derived.outTotalHold), 0,
  ), 0);
  const pendingAmount = meta ? (held > 0n ? money(held) : '') : (heldUsd > 0 ? formatUsd(heldUsd) : '');

  return (
    <WalletScale>
      <div className="screen-header">
        <EntitySwitcher name={wallet.name} status={<span className="note">Wallet</span>} />
        <button
          type="button"
          className="icon-btn"
          onClick={() => navigate('/sovereignty')}
          aria-label="Security and recovery"
          data-testid="home-sovereignty"
        >
          <Icon name="shield" size={18} />
        </button>
        <span hidden data-testid="home-entity-id">
          {wallet.entityId}
        </span>
      </div>
      <section className="wallet-overview" aria-label="Your balance">
        <span className="hero-label">
          {places.onchain && places.reserve && places.accounts ? 'Total balance' : 'Selected balances'}
        </span>
        {<select className="input" style={{ width: 'auto', marginBottom: 8 }} aria-label="Balance asset" data-testid="home-balance-asset"
          value={balanceToken?.tokenId ?? 0} onChange={event => setSelectedToken(Number(event.target.value))}>
          <option value={0}>All assets · USD estimate</option>
          {balanceTokens.map(token => <option key={token.tokenId} value={token.tokenId}>{getTokenMeta(token.tokenId).symbol}</option>)}
        </select>}
        {wallet.frame && !lendingUnavailable ? (
          <div className="display num" style={{ fontSize: 52, overflowWrap: 'anywhere' }} data-testid="home-total">
            {meta ? formatAmount(visibleNet, meta.decimals, meta.decimals) : formatUsd(visibleUsd)}
          </div>
        ) : (
          <p className="hero-label" role="status">
            {wallet.error || lending.error ? 'Total balance unavailable' : 'Updating total balance…'}
          </p>
        )}
        {places.accounts && (lendingUsd !== 0 || lendingUnavailable) && (
          <div className="note" data-testid="home-lending-balance">
            {lendingUnavailable ? 'Lending positions are being reconciled with your wallet.' : `Lending deposits minus loans: ${meta ? money(lending.byToken.get(balanceToken!.tokenId) ?? 0n) : formatUsd(lendingUsd)} · reported by your hub`}
            {lending.error && <p role="alert">{lending.error}</p>}
            <details><summary>How lending affects my balance</summary><p>{walletHelp.lendingBalance}</p></details>
            <button className="more" type="button" onClick={() => navigate('/lend')}>View lending positions</button>
          </div>
        )}
        {wallet.frame && places.accounts && (
          <p className="note" data-testid="home-send-capacity">
            {!commandReady
              ? 'Wallet connection stopped. Reopen the wallet to continue.'
              : `Available to pay: ${meta ? money(balanceToken?.sendCapacity ?? 0n) : formatUsd(wallet.usd.sendCapacity)} · includes available credit`}
          </p>
        )}
        {pendingAmount && (
          <button type="button" className="wallet-pending" onClick={() => navigate('/activity')}>
            {pendingAmount} pending · View activity <Icon name="chevronRight" size={14} />
          </button>
        )}
      </section>
      <TestMoney key={wallet.entityId} wallet={wallet} />
      <div className="actions wallet-actions">
        <button
          type="button"
          className="btn primary"
          disabled={!commandReady || !wallet.frame || Boolean(wallet.error)}
          onClick={() => navigate('/pay')}
          data-testid="home-pay"
          title={walletHelp.pay}
        >
          <Icon name="pay" size={18} />
          Pay
        </button>
        <button type="button" className="btn" onClick={() => navigate('/receive')} data-testid="home-receive" title={walletHelp.receive}>
          <Icon name="receive" size={18} />
          Receive
        </button>
        <button
          type="button"
          className="btn"
          disabled={!commandReady || !wallet.frame || Boolean(wallet.error)}
          onClick={() => navigate('/swap')}
          data-testid="home-swap"
          title={walletHelp.swap}
        >
          <Icon name="swap" size={18} />
          Swap
        </button>
      </div>
      <nav className="actions" aria-label="All wallet functions" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
        {[
          { to: '/move', label: 'Move', topic: 'move' },
          { to: '/assets', label: 'Assets', topic: 'assets' },
          { to: '/lend', label: 'Lending', topic: 'lending' },
          { to: '/manage', label: 'Limits and disputes', topic: 'configure' },
          { to: '/ownership', label: 'Ownership', topic: 'ownership' },
          { to: '/activity', label: 'History', topic: 'history' },
        ].map(action => <button key={action.to} type="button" className="btn quiet sm" title={walletHelp[action.topic]} onClick={() => navigate(action.to)}>{action.label}</button>)}
      </nav>
      <Help topic="balance" label="What is included in my balance?" />
      <details className="disclosure" style={{ marginBottom: 16 }}>
        <summary>Learn the wallet functions</summary>
        {['pay', 'receive', 'swap', 'move', 'lending', 'configure', 'open', 'protection'].map(topic => <Help key={topic} topic={topic} label={topic === 'configure' ? 'Limits and disputes' : topic === 'open' ? 'Connect a hub' : topic.charAt(0).toUpperCase() + topic.slice(1)} />)}
      </details>
      <details className="disclosure" style={{ marginBottom: 16 }}>
        <summary>Backup and dispute protection</summary>
        <p className="note">Encrypted backups help recover this wallet. Dispute protection is a separate service; its actual response status is shown below.</p>
        <Watchtower accountCount={wallet.accounts.length} />
      </details>
      <PendingBatch wallet={wallet} compact />
      <BalanceDetails wallet={wallet} />
      <div className="wallet-sections">
        <section aria-label="Assets">
          <div className="sect">
            <h3 className="caps">Assets</h3>
            <button type="button" className="more" onClick={() => setAddingMoney(true)} data-testid="home-add-money">
              Add money
            </button>
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
            <h3 className="caps">Recent activity</h3>
            <button type="button" className="more" onClick={() => navigate('/activity')}>
              View all
            </button>
          </div>
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
          {recent.error && (
            <p role="alert" className="note">
              Activity unavailable: {recent.error}
            </p>
          )}
        </section>
      </div>
      <footer className="wallet-details">
        <section className="wallet-connections" data-testid="home-accounts">
          <h3 className="caps">Connected accounts</h3>
          {wallet.accounts.map((account, index) => (
            <AccountRow
              key={account.counterpartyId}
              account={account}
              first={index === 0}
              onClick={() => navigate(`/accounts/${account.counterpartyId}`)}
            />
          ))}
          <button type="button" className="btn quiet sm" onClick={() => setOpening(true)} data-testid="home-open-account">
            Connect another account
          </button>
        </section>
        <details className="disclosure">
          <summary>Wallet address and technical details</summary>
          <div className="kv">
            <span className="k">Payment address (Entity ID)</span>
            <CopyId value={wallet.entityId} label="Entity ID" full />
          </div>
          <p className="note">Confirmed frame: {wallet.frameHeight}</p>
        </details>
        <button type="button" className="more" onClick={() => navigate('/move')} data-testid="home-move">
          Transfer between accounts
        </button>
      </footer>
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

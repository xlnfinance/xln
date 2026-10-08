import { useNavigate } from 'react-router-dom';
import { isAccountTxKindAvailable } from '@xln/core/account/tx/admission-policy';
import { CopyId } from '../CopyId';
import { Icon, type IconName } from '../Icons';
import { AccountRow } from './Balances';
import { formatAmount, formatUsd, getTokenMeta } from '../../runtime/format';
import type { TokenTotals, WalletView } from '../../runtime/views';

/** The quiet right column: what the selected asset can do now, who it runs through, where the rest lives. */
export function HomeAside({
  wallet,
  token,
  onConnect,
}: {
  wallet: WalletView;
  token: TokenTotals | undefined;
  onConnect: () => void;
}) {
  const navigate = useNavigate();
  const meta = token ? getTokenMeta(token.tokenId) : null;
  const money = (amount: bigint): string =>
    meta ? `${formatAmount(amount, meta.decimals, meta.decimals)} ${meta.symbol}` : '—';
  const lending = isAccountTxKindAvailable('lending_fund') && isAccountTxKindAvailable('lending_borrow_request');
  const resources: Array<{ to: string; icon: IconName; title: string; hint: string }> = [
    { to: '/sovereignty', icon: 'shield', title: 'Security and recovery', hint: 'Keys, proofs, watchtowers' },
    { to: '/assets', icon: 'wallet', title: 'Assets and deposits', hint: 'On-chain wallet, reserve, faucets' },
    {
      to: '/lend',
      icon: 'bank',
      title: 'Lending',
      hint: lending ? 'Lend to a hub pool or borrow' : 'View existing positions',
    },
    { to: '/ownership', icon: 'accounts', title: 'Ownership', hint: 'Board, shares, takeovers' },
  ];

  return (
    <aside className="dash-aside" aria-label="Wallet details">
      <section className="side-card">
        <h3 className="side-title">Payment capacity</h3>
        <div className="side-box">
          <div className="side-hero">
            <span className="display num">{formatUsd(wallet.usd.sendCapacity)}</span>
            <p className="note">Spendable now across all accounts, credit included</p>
          </div>
          <div className="kv">
            <span className="k">Can send {meta?.symbol ?? ''}</span>
            <span className="v num">{money(token?.sendCapacity ?? 0n)}</span>
          </div>
          <div className="kv">
            <span className="k">Can receive {meta?.symbol ?? ''}</span>
            <span className="v num">{money(token?.receiveCapacity ?? 0n)}</span>
          </div>
          {token && token.owed < 0n ? (
            <div className="kv">
              <span className="k">You owe</span>
              <span className="v num st-pending">{money(-token.owed)}</span>
            </div>
          ) : null}
        </div>
      </section>

      <section className="side-card wallet-connections" data-testid="home-accounts">
        <h3 className="side-title">Connected accounts</h3>
        <div className="side-box">
          {wallet.accounts.map((account, index) => (
            <AccountRow
              key={account.counterpartyId}
              account={account}
              first={index === 0}
              onClick={() => navigate(`/accounts/${account.counterpartyId}`)}
            />
          ))}
          <button type="button" className="btn quiet sm" onClick={onConnect}>
            Connect another account
          </button>
        </div>
      </section>

      <section className="side-card">
        <h3 className="side-title">Resources</h3>
        <div className="resources">
          {resources.map(resource => (
            <button key={resource.to} type="button" className="resource" onClick={() => navigate(resource.to)}>
              <span className="resource-ic">
                <Icon name={resource.icon} size={15} />
              </span>
              <span>
                {resource.title}
                <span className="s">{resource.hint}</span>
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="side-card wallet-id">
        <h3 className="side-title">Entity ID</h3>
        <div className="id-box">
          <CopyId value={wallet.entityId} label="Entity ID" full />
          <Icon name="copy" size={14} />
        </div>
        <p className="note" style={{ marginTop: 8 }}>
          Your payment address. Share it to get paid.
        </p>
      </section>
    </aside>
  );
}

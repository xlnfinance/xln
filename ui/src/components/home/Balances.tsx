import { Bar } from '../Bars';
import { AccountBalance } from './AccountBalance';
import { Icon } from '../Icons';
import { TokenIcon } from '../TokenPicker';
import { useApp } from '../../runtime/store';
import { formatAmount, formatMoney, formatUsd, getTokenMeta } from '../../runtime/format';
import { isUsdStable, usdOf } from '../../runtime/financial/prices';
import type { AccountView, TokenTotals, WalletView } from '../../runtime/views';

export function TokenRow({
  total,
  wallet,
  first,
  open,
  onToggle,
  onAccount,
}: {
  total: TokenTotals;
  wallet: WalletView;
  first: boolean;
  open: boolean;
  onToggle: () => void;
  onAccount: (counterpartyId: string) => void;
}) {
  const places = useApp(s => s.places);
  const meta = getTokenMeta(total.tokenId);
  const money = (value: bigint): string =>
    isUsdStable(total.tokenId) && value % 10n ** BigInt(Math.max(0, meta.decimals - 2)) === 0n
      ? formatMoney(value, meta.decimals)
      : formatAmount(value, meta.decimals, meta.decimals);
  const segments = [
    { usd: places.onchain ? usdOf(total.tokenId, total.onchain) : 0, kind: 'onchain' as const },
    { usd: places.reserve ? usdOf(total.tokenId, total.reserve) : 0, kind: 'reserve' as const },
    { usd: places.reserve ? usdOf(total.tokenId, total.pending) : 0, kind: 'pend' as const },
    { usd: places.accounts ? usdOf(total.tokenId, total.secured) : 0, kind: 'coll' as const },
    { usd: places.accounts ? usdOf(total.tokenId, total.risk) : 0, kind: 'risk' as const },
  ];
  const visibleNet =
    (places.onchain ? total.onchain : 0n) +
    (places.reserve ? total.reserve : 0n) +
    (places.accounts ? total.receivable + total.owed : 0n);
  const accounts = wallet.accounts.filter(account => account.tokens.some(token => token.tokenId === total.tokenId));

  return (
    <div className={`row${first ? ' first' : ''}`} data-testid={`token-row-${meta.symbol}`}>
      <button
        type="button"
        className="rt"
        style={{ width: '100%', textAlign: 'left' }}
        onClick={onToggle}
        aria-expanded={open}
      >
        <TokenIcon tokenId={total.tokenId} />
        <span className="tx">
          <span className="t">{meta.symbol}</span>
          <span className="s">
            {meta.name}
            {places.accounts && total.owed < 0n ? (
              <>
                {' · '}
                <span className="st-pending num">you owe {money(-total.owed)}</span>
              </>
            ) : null}
          </span>
        </span>
        <span className="r">
          <span className="v num" data-testid={`token-net-${meta.symbol}`}>
            {money(visibleNet)}
          </span>
          <span className="u num">
            {isUsdStable(total.tokenId) ? '' : `≈ ${formatUsd(usdOf(total.tokenId, visibleNet))}`}
            {places.reserve && total.pending > 0n ? (
              <span className="st-pending"> +{money(total.pending)} pending</span>
            ) : null}
          </span>
        </span>
        <span className="chev">
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={16} />
        </span>
      </button>
      <div className="rb">
        <Bar segments={segments} />
      </div>
      {open && (
        <div className="fade-in">
          {places.onchain &&
            wallet.onchain
              .filter(row => row.tokenId === total.tokenId)
              .map(row => (
                <div key={`onchain-${row.jurisdiction}`} className="sub">
                  <div className="rt">
                    <span className="tx">
                      <span className="t">Blockchain wallet{row.jurisdiction ? ` · ${row.jurisdiction}` : ''}</span>
                      <span className="s">Your wallet</span>
                    </span>
                    <span className="r">
                      <span className="v num">{money(row.amount)}</span>
                    </span>
                  </div>
                  <div className="rb">
                    <Bar segments={[{ usd: usdOf(total.tokenId, row.amount), kind: 'onchain' }]} height={4} />
                  </div>
                </div>
              ))}
          {places.reserve &&
            wallet.reserves
              .filter(row => row.tokenId === total.tokenId)
              .map(row => (
                <div key={`reserve-${row.jurisdiction}`} className="sub">
                  <div className="rt">
                    <span className="tx">
                      <span className="t">Reserve{row.jurisdiction ? ` · ${row.jurisdiction}` : ''}</span>
                      <span className="s">
                        Held in the XLN contract
                        {row.pending > 0n ? (
                          <>
                            {' · '}
                            <span className="st-pending num">{money(row.pending)} depositing</span>
                          </>
                        ) : null}
                      </span>
                    </span>
                    <span className="r">
                      <span className="v num">{money(row.amount)}</span>
                    </span>
                  </div>
                  <div className="rb">
                    <Bar
                      segments={[
                        { usd: usdOf(total.tokenId, row.amount), kind: 'reserve' },
                        { usd: usdOf(total.tokenId, row.pending), kind: 'pend' },
                      ]}
                      height={4}
                    />
                  </div>
                </div>
              ))}
          {places.accounts &&
            accounts.map(account => {
              const token = account.tokens.find(entry => entry.tokenId === total.tokenId);
              if (!token) return null;
              return (
                <button
                  key={account.counterpartyId}
                  type="button"
                  className="sub wallet-account"
                  style={{ width: '100%', textAlign: 'left', display: 'block' }}
                  onClick={() => onAccount(account.counterpartyId)}
                >
                  <div className="rt">
                    <span className="tx">
                      <span className="t">
                        {account.label}
                        {account.isHub ? <span className="chip hub">Payment hub</span> : null}
                        {wallet.jurisdiction ? <span className="faint">· {wallet.jurisdiction}</span> : null}
                      </span>
                      <span className="s">
                        {token.signed < 0n ? 'Your debt on this account' : 'Your balance on this account'}
                      </span>
                    </span>
                    <span className="r">
                      <span className="v num">
                        {money(token.signed)} {meta.symbol}
                      </span>
                    </span>
                  </div>
                  <AccountBalance closed={account.dispute === 'closed'} disputed={account.disputed} token={token} symbol={meta.symbol} money={money} />
                </button>
              );
            })}
        </div>
      )}
    </div>
  );
}

export function AccountRow({ account, first, onClick }: { account: AccountView; first: boolean; onClick: () => void }) {
  const status = account.dispute === 'closed'
    ? 'Closed after dispute'
    : account.disputed
    ? 'Dispute in progress'
    : account.settlement !== 'none'
      ? 'Settlement in progress'
      : 'Payment connection';
  return (
    <button
      type="button"
      className={`row tappable${first ? ' first' : ''}`}
      onClick={onClick}
      data-testid="account-row"
    >
      <span className="rt">
        <span className="avatar">{account.label.slice(0, 1).toUpperCase()}</span>
        <span className="tx">
          <span className="t">{account.label}</span>
          <span className="s">{status}</span>
        </span>
        <Icon name="chevronRight" size={16} />
      </span>
    </button>
  );
}

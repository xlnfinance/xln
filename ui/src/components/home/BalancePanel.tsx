import { useNavigate } from 'react-router-dom';
import { CopyId } from '../CopyId';
import { Icon } from '../Icons';
import { TokenIcon } from '../TokenPicker';
import { useApp } from '../../runtime/store';
import { formatAmount, getTokenMeta } from '../../runtime/format';
import type { TokenTotals, WalletView } from '../../runtime/views';

/** The exact committed amount; digits past the cent are dimmed, never rounded away. */
function HeroAmount({ text }: { text: string }) {
  const dot = text.indexOf('.');
  const cut = dot < 0 ? text.length : Math.min(text.length, dot + 3);
  return (
    <span className="display num" data-testid="home-total">
      {text.slice(0, cut)}
      {cut < text.length ? <span className="dec">{text.slice(cut)}</span> : null}
    </span>
  );
}

/**
 * The selected asset as one lifted card: the visible total, its payment
 * capacity, how it is held, and every action that moves it. The tray under it
 * carries the payment address and the confirmed frame.
 */
export function BalancePanel({
  wallet,
  token,
  onAddMoney,
}: {
  wallet: WalletView;
  token: TokenTotals | undefined;
  onAddMoney: () => void;
}) {
  const navigate = useNavigate();
  const commandReady = useApp(s => s.commandReady);
  const places = useApp(s => s.places);
  const meta = token ? getTokenMeta(token.tokenId) : null;
  const visibleNet = token
    ? (places.onchain ? token.onchain : 0n) +
      (places.reserve ? token.reserve : 0n) +
      (places.accounts ? token.receivable + token.owed : 0n)
    : 0n;
  const money = (amount: bigint): string =>
    meta ? `${formatAmount(amount, meta.decimals, meta.decimals)} ${meta.symbol}` : '0';
  const held = wallet.accounts.reduce(
    (sum, account) =>
      sum +
      account.tokens
        .filter(entry => entry.tokenId === token?.tokenId)
        .reduce((amount, entry) => amount + entry.derived.outTotalHold, 0n),
    0n,
  );
  const blocked = !commandReady || !wallet.frame || Boolean(wallet.error);
  const all = places.onchain && places.reserve && places.accounts;

  return (
    <section className="panel wallet-overview" aria-label="Your balance">
      <div className="panel-card">
        <div className="panel-token">
          {token ? <TokenIcon tokenId={token.tokenId} size="sm" /> : null}
          {meta?.symbol ?? 'Balance'}
          <span className="faint">· {all ? 'Balance' : 'Selected balances'}</span>
        </div>
        {wallet.frame ? (
          <div className="panel-amount">
            <HeroAmount text={meta ? formatAmount(visibleNet, meta.decimals, meta.decimals) : '0'} />
            {meta ? <span className="sym">{meta.symbol}</span> : null}
          </div>
        ) : (
          <p className="hero-label" role="status">
            {wallet.error ? 'Balance unavailable' : 'Loading balance…'}
          </p>
        )}
        {wallet.frame && places.accounts && (
          <p className="note" data-testid="home-send-capacity">
            {!commandReady
              ? 'Wallet connection stopped. Reopen the wallet to continue.'
              : `Payment capacity: ${money(token?.sendCapacity ?? 0n)} · includes available credit`}
          </p>
        )}
        {held > 0n && (
          <button type="button" className="wallet-pending" onClick={() => navigate('/activity')}>
            {money(held)} pending · View activity <Icon name="chevronRight" size={14} />
          </button>
        )}
        <div className="actions pills wallet-actions">
          <button
            type="button"
            className="btn primary"
            disabled={blocked}
            onClick={() => navigate('/pay')}
            data-testid="home-pay"
          >
            <Icon name="pay" size={16} />
            Pay
          </button>
          <button type="button" className="btn" onClick={() => navigate('/receive')} data-testid="home-receive">
            <Icon name="receive" size={16} />
            Receive
          </button>
          <button
            type="button"
            className="btn"
            disabled={blocked}
            onClick={() => navigate('/swap')}
            data-testid="home-swap"
          >
            <Icon name="swap" size={16} />
            Swap
          </button>
          <button type="button" className="btn" onClick={onAddMoney} data-testid="home-add-money">
            <Icon name="plus" size={16} />
            Add money
          </button>
          <button type="button" className="btn" onClick={() => navigate('/move')} data-testid="home-move">
            <Icon name="arrow" size={16} />
            Move
          </button>
        </div>
      </div>
      <div className="panel-foot">
        <span>
          <Icon name="eye" size={15} />
          Payment address <CopyId value={wallet.entityId} label="Entity ID" head={6} tail={4} />
        </span>
        <i className="dot" />
        <span>
          Confirmed frame <strong className="num">#{wallet.frameHeight.toLocaleString('en-US')}</strong>
        </span>
      </div>
    </section>
  );
}

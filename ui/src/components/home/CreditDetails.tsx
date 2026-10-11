import { Bar } from '../Bars';
import { formatAmount, formatUsd, getTokenMeta } from '../../runtime/format';
import { usdOf } from '../../runtime/financial/prices';
import type { WalletView } from '../../runtime/views';

/** Signed credit limits are risk permissions, never an addition to the wallet balance. */
export function CreditDetails({ wallet, tokenId }: { wallet: WalletView; tokenId: number | undefined }) {
  const tokens = wallet.accounts
    .flatMap(account => account.tokens)
    .filter(token => tokenId === undefined || token.tokenId === tokenId);
  const meta = tokenId === undefined ? null : getTokenMeta(tokenId);
  const lines = [
    {
      label: 'You extend',
      used: 'outPeerCredit',
      unused: 'inPeerCredit',
      limit: 'peerCreditLimit',
      kind: 'risk',
      note: 'Their debt to you',
    },
    {
      label: 'Extended to you',
      used: 'inOwnCredit',
      unused: 'outOwnCredit',
      limit: 'ownCreditLimit',
      kind: 'debt',
      note: 'Your debt to them',
    },
  ] as const;
  return (
    <section className="wallet-credit" aria-label="Credit limits" data-testid="home-credit-limits">
      <div className="field-head">
        <h3 className="caps">Credit limits</h3>
        <span className="credit-tag">Not a balance</span>
      </div>
      {lines.map(line => {
        const sum = (key: typeof line.used | typeof line.unused | typeof line.limit) =>
          tokens.reduce((value, token) => value + usdOf(token.tokenId, token.derived[key]), 0);
        const money = (key: typeof line.used | typeof line.unused | typeof line.limit) =>
          meta
            ? `${formatAmount(
                tokens.reduce((value, token) => value + token.derived[key], 0n),
                meta.decimals,
                meta.decimals,
              )} ${meta.symbol}`
            : formatUsd(sum(key));
        return (
          <div className="credit-line" key={line.used}>
            <div className="credit-line-head">
              <span>{line.label}</span>
              <strong className="num">{money(line.limit)}</strong>
            </div>
            <Bar
              segments={[
                { usd: sum(line.used), kind: line.kind },
                { usd: sum(line.unused), kind: 'room' },
              ]}
              height={8}
            />
            <div className="credit-line-caption">
              <span>
                {line.note} <b className="num">{money(line.used)}</b>
              </span>
              <span>
                Unused <b className="num">{money(line.unused)}</b>
              </span>
            </div>
          </div>
        );
      })}
      <p className="note">Solid: debt already used. Outline: unused limit. Credit does not guarantee repayment.</p>
    </section>
  );
}

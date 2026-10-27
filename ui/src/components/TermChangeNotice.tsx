import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AccountView } from '../runtime/views';
import { getTokenMeta } from '../runtime/token-meta';
import { plainAmount } from '../runtime/format';

/** Notices come from the signed Account register, never a profile or wall clock. */
export function TermChangeNotice({
  accounts,
  onClose,
}: {
  accounts: readonly Pick<AccountView, 'counterpartyId' | 'label' | 'isLeft' | 'doc'>[];
  onClose?: () => void;
}) {
  const navigate = useNavigate();
  const [kept, setKept] = useState<ReadonlySet<string>>(() => new Set());
  const notices = accounts.flatMap(account =>
    [...(account.doc.state.rebalanceFeePolicies ?? [])].flatMap(([tokenId, register]) => {
      const next = register[account.isLeft ? 'right' : 'left'];
      if (!next?.previous || account.doc.currentFrame.timestamp >= next.effectiveAt) return [];
      const key = `${account.counterpartyId}:${tokenId}:${next.policyVersion}`;
      if (kept.has(key)) return [];
      const meta = getTokenMeta(tokenId);
      const old = next.previous;
      const changes = [
        [
          'collateral base fee',
          plainAmount(old.baseFee, meta.decimals),
          plainAmount(next.baseFee, meta.decimals),
          meta.symbol,
        ],
        [
          'collateral gas fee',
          plainAmount(old.gasFee, meta.decimals),
          plainAmount(next.gasFee, meta.decimals),
          meta.symbol,
        ],
        [`collateral liquidity fee (${meta.symbol})`, String(old.liquidityFeeBps), String(next.liquidityFeeBps), 'bps'],
        ['term notice period', String(old.noticePeriodSeconds), String(next.noticePeriodSeconds), 'seconds'],
      ].filter(([, from, to]) => from !== to);
      return [{ account, key, changes, effectiveAt: next.effectiveAt }];
    }),
  );
  if (notices.length === 0) return null;
  return (
    <section className="note" role="status" aria-label="Bank term changes" data-testid="term-change-notice">
      {notices.map(({ account, key, changes, effectiveAt }) => (
        <div key={key}>
          {changes.map(([term, from, to, unit]) => (
            <p key={term}>
              {account.label} changes {term} from {from} to {to} {unit} on {new Date(effectiveAt).toISOString()}.
            </p>
          ))}
          <button className="btn sm" type="button" onClick={() => setKept(previous => new Set([...previous, key]))}>
            Keep the account
          </button>{' '}
          <button
            className="btn sm"
            type="button"
            onClick={() => navigate(`/move?from=account&to=reserve&account=${account.counterpartyId}`)}
          >
            Move funds
          </button>{' '}
          <button
            className="btn sm"
            type="button"
            onClick={() => (onClose ? onClose() : navigate(`/accounts/${account.counterpartyId}?close=1`))}
          >
            Close the account
          </button>
          <p>
            The scheduled terms apply if you keep the account. Closure opens the existing dispute and withdrawal
            controls; review the costs before confirming.
          </p>
        </div>
      ))}
    </section>
  );
}

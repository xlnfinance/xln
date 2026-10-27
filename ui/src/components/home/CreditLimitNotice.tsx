import { useNavigate } from 'react-router-dom';
import { fullCreditLimits } from '../../runtime/financial/credit-limit';
import { formatAmount } from '../../runtime/format';
import { getTokenMeta } from '../../runtime/token-meta';
import type { WalletView } from '../../runtime/views';

/** A full limit blocks every further incoming payment; only the user may raise it. */
export function CreditLimitNotice({ wallet }: { wallet: WalletView }) {
  const navigate = useNavigate();
  const full = fullCreditLimits(wallet.accounts);
  if (full.length === 0) return null;
  return (
    <section className="note" role="status" aria-label="Credit limit full" data-testid="credit-limit-full">
      {full.map(line => {
        const meta = getTokenMeta(line.tokenId);
        return (
          <p key={`${line.accountId}:${line.tokenId}`}>
            Your {formatAmount(line.limit, meta.decimals, 2)} {meta.symbol} credit limit to {line.label} is full: incoming
            {' '}{meta.symbol} payments through {line.label} fail until you raise it.{' '}
            <button type="button" className="btn sm" onClick={() => navigate(`/accounts/${line.accountId}`)}>
              Raise limit
            </button>
          </p>
        );
      })}
    </section>
  );
}

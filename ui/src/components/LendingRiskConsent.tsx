import { useState } from 'react';
import { sendEntityTxs } from '../runtime/tx';
import { formatAmount, getTokenMeta } from '../runtime/format';

/** The saver authorizes a maximum exposure; opening an Account never does. */
export function LendingRiskConsent({ entityId, signerId, hubId, tokenId, currentLimit, requiredLimit, disabled }: {
  entityId: string; signerId: string; hubId: string; tokenId: number;
  currentLimit: bigint; requiredLimit: bigint; disabled: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const meta = getTokenMeta(tokenId);
  const money = (value: bigint) => `${formatAmount(value, meta.decimals, meta.decimals)} ${meta.symbol}`;
  const authorize = async () => {
    if (disabled || busy) return;
    setBusy(true);
    setError('');
    try {
      await sendEntityTxs(entityId, signerId, [{
        type: 'extendCredit', data: { counterpartyEntityId: hubId, tokenId, amount: requiredLimit },
      }]);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return <div className="card" data-testid="lending-risk-consent">
    <p>Your current maximum unsecured risk with this bank is {money(currentLimit)}.</p>
    <p>Including this deposit's interest requires {money(requiredLimit)}. This limit covers all obligations on this Account. Only collateral secures recovery.</p>
    <button type="button" className="btn ghost" disabled={disabled || busy} onClick={() => void authorize()} data-testid="lending-risk-authorize">
      {busy ? 'Authorizing…' : `Set maximum risk to ${money(requiredLimit)}`}
    </button>
    {error && <p role="alert">{error}</p>}
  </div>;
}

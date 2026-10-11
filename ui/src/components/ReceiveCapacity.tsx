import { useEffect, useId, useState } from 'react';
import type { AccountCapacityViewInput } from '@xln/core/account/capacity-plan';
import { peekXLN } from '../runtime/xln-loader';
import { readAccountState } from '../runtime/financial/swap';
import { sendEntityTxs } from '../runtime/tx';
import { formatMoney } from '../runtime/format';
import { getTokenMeta } from '../runtime/token-meta';

type Props = {
  account: NonNullable<AccountCapacityViewInput['account']>;
  ownerEntityId: string;
  signerId: string;
  counterpartyEntityId: string;
  accountLabel: string;
  jurisdiction: string;
  tokenId: number;
  requiredAmount: bigint;
  disabled?: boolean;
};

/** A new receive intent always starts with full collateral, regardless of the previous risk choice. */
export function ReceiveCapacity(props: Props) {
  return (
    <ReceiveCapacityIntent
      key={`${props.ownerEntityId}:${props.counterpartyEntityId}:${props.jurisdiction}:${props.tokenId}:${props.requiredAmount}`}
      {...props}
    />
  );
}

function ReceiveCapacityIntent(props: Props) {
  const id = useId();
  const [creditPercent, setCreditPercent] = useState(0);
  const [buffer, setBuffer] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pendingLimit, setPendingLimit] = useState<bigint | null>(null);
  const [error, setError] = useState('');
  const xln = peekXLN();
  const meta = getTokenMeta(props.tokenId);
  const input = {
    account: props.account,
    ownerEntityId: props.ownerEntityId,
    counterpartyEntityId: props.counterpartyEntityId,
    tokenId: props.tokenId,
    requiredInboundAmount: props.requiredAmount,
    collateralPercent: 100 - creditPercent,
    creditBufferBps: buffer ? (1000 as const) : (0 as const),
    allowOpenAccount: false,
  };
  const plan = xln && props.requiredAmount > 0n ? xln.planReceiveCapacity(input) : null;
  useEffect(() => {
    if (pendingLimit !== null && plan && plan.currentPeerCreditLimit >= pendingLimit) setPendingLimit(null);
  }, [pendingLimit, plan?.currentPeerCreditLimit]);
  if (!xln || !plan || plan.shortfall === 0n) return null;
  // Six places are plenty to read; 18-decimal coins otherwise print a wall of zeros.
  const money = (value: bigint) => {
    const text = formatMoney(value, meta.decimals, Math.min(meta.decimals, 6));
    // "0.007998" not "0.007998000000000000"; "20.00" keeps its cents.
    const trimmed = text.includes('.')
      ? text
          .replace(/0+$/, '')
          .replace(/\.$/, '.00')
          .replace(/\.(\d)$/, '.$10')
      : text;
    return `${trimmed} ${meta.symbol}`;
  };
  const prepare = async () => {
    if (busy || pendingLimit !== null || props.disabled || !props.signerId || plan.status !== 'credit') return;
    setBusy(true);
    setError('');
    try {
      const account = await readAccountState(props.ownerEntityId, props.counterpartyEntityId);
      const fresh = xln.planReceiveCapacity({ ...input, account });
      if (fresh.status === 'ready') return;
      if (fresh.status !== 'credit' || fresh.requiredPeerCreditLimit !== plan.requiredPeerCreditLimit)
        throw new Error('Account capacity changed. Review the updated limit before confirming.');
      await sendEntityTxs(props.ownerEntityId, props.signerId, [...fresh.setupTxs]);
      setPendingLimit(fresh.requiredPeerCreditLimit);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="receive-spectrum" aria-labelledby={`${id}-title`} data-testid="receive-spectrum">
      <div className="field-head">
        <b id={`${id}-title`}>Prepare to receive</b>
        <span>
          {props.accountLabel} · {props.jurisdiction}
        </span>
      </div>
      <p className="note">
        Available {money(plan.currentInboundCapacity)} · Need {money(plan.shortfall)} more
      </p>
      <label htmlFor={id} className="sr-only">
        Collateral for the missing incoming capacity
      </label>
      <div className="spectrum-ends">
        <span>100% collateral</span>
        <span>0% collateral</span>
      </div>
      <input
        id={id}
        type="range"
        min={0}
        max={100}
        step={1}
        value={creditPercent}
        disabled={busy || pendingLimit !== null || props.disabled}
        onChange={event => {
          setCreditPercent(Number(event.target.value));
          setError('');
        }}
        aria-valuetext={`${100 - creditPercent}% collateral: ${money(plan.collateralRequired)}; additional credit: ${money(plan.creditIncrease)}`}
        data-testid="receive-spectrum-slider"
      />
      <div className="spectrum-amounts">
        <span>
          Collateral <b>{money(plan.collateralRequired)}</b>
        </span>
        <span>
          New credit <b>{money(plan.creditIncrease)}</b>
        </span>
      </div>
      <div className="actions spectrum-presets">
        {[0, 50, 100].map(value => (
          <button
            key={value}
            type="button"
            className={`btn quiet${creditPercent === value ? ' active' : ''}`}
            disabled={busy || pendingLimit !== null || props.disabled}
            onClick={() => setCreditPercent(value)}
          >
            {100 - value}% collateral
          </button>
        ))}
      </div>
      {creditPercent > 0 ? (
        <>
          <label className="note spectrum-buffer">
            <input
              type="checkbox"
              checked={buffer}
              disabled={busy || pendingLimit !== null || props.disabled}
              onChange={event => setBuffer(event.target.checked)}
            />{' '}
            Add 10% buffer to the entire credit limit ({money(plan.creditBuffer)})
          </label>
          {plan.requestedCreditBuffer > plan.creditBuffer ? (
            <p className="note">
              The optional buffer is reduced to the remaining integer headroom. The required receiving capacity is
              preserved.
            </p>
          ) : null}
          <p className="note">
            Permanent limit you grant {props.accountLabel}: {money(plan.currentPeerCreditLimit)} →{' '}
            {money(plan.requiredPeerCreditLimit ?? plan.currentPeerCreditLimit)}. The extra credit allows{' '}
            {props.accountLabel} to owe you without collateral.
          </p>
        </>
      ) : null}
      {plan.status === 'collateral-unavailable' ? (
        <p className="note" role="status">
          Collateral for a future receipt is not available yet. This preparation submits no collateral request. You can
          explicitly choose credit, or wait for collateral support.
        </p>
      ) : null}
      {plan.status === 'credit-unavailable' ? (
        <p className="note" role="alert">
          Requested limit {money(plan.requiredPeerCreditLimit)} exceeds the uint256 representation limit. Reduce the
          receive amount.
        </p>
      ) : null}
      {plan.status === 'collateral-unavailable' && !busy && pendingLimit === null ? (
        // The hub cannot lock collateral for a future receipt yet; the one working choice is a tap away.
        <button
          type="button"
          className="btn primary"
          disabled={props.disabled || !props.signerId}
          onClick={() => setCreditPercent(100)}
          data-testid="receive-spectrum-confirm"
        >
          Accept it as credit instead
        </button>
      ) : (
        <button
          type="button"
          className="btn primary"
          disabled={plan.status !== 'credit' || busy || pendingLimit !== null || props.disabled || !props.signerId}
          onClick={() => void prepare()}
          data-testid="receive-spectrum-confirm"
        >
          {busy ? 'Submitting…' : pendingLimit !== null ? 'Waiting for the hub to countersign…' : 'Extend credit limit'}
        </button>
      )}
      {error ? (
        <p className="note" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

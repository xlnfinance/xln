import { useState } from 'react';
import { buildLendingRepayTx, isLendingLoanRepayable, type LendingLoan } from '../runtime/financial/lending';
import type { WalletView } from '../runtime/views';
import { parseAmount } from '../runtime/format';
import { getTokenMeta } from '../runtime/token-meta';
import { sendEntityTxs } from '../runtime/tx';
import { useApp } from '../runtime/store';

export function LendingRepay({
  loan,
  wallet,
  onSubmitted,
}: {
  loan: LendingLoan;
  wallet: WalletView;
  onSubmitted: () => void;
}) {
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useApp(s => s.toast);
  const commandReady = useApp(s => s.commandReady);
  if (!isLendingLoanRepayable(loan)) return null;
  const meta = getTokenMeta(loan.tokenId);
  const disabled = busy || !wallet.signerId || !commandReady;
  const repay = async () => {
    if (disabled) return;
    setBusy(true);
    try {
      const maximum = amount.trim() ? parseAmount(amount, meta.decimals) : undefined;
      await sendEntityTxs(wallet.entityId, wallet.signerId, [buildLendingRepayTx(loan, wallet.entityId, maximum)]);
      setAmount('');
      toast('Repayment sent');
      onSubmitted();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'danger');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack">
      <label className="field">
        <span className="field-label">Repayment amount · {meta.symbol}</span>
        <input
          className="input"
          inputMode="decimal"
          placeholder="Full balance"
          value={amount}
          disabled={disabled}
          onChange={event => setAmount(event.target.value)}
          data-testid="lending-repay-amount"
        />
      </label>
      <p className="note">Interest first, then principal. Leave blank to repay the full balance.</p>
      <button
        type="button"
        className="btn ghost sm"
        disabled={disabled}
        onClick={() => void repay()}
        data-testid="lending-repay"
      >
        {busy ? 'Sending…' : 'Repay'}
      </button>
    </div>
  );
}

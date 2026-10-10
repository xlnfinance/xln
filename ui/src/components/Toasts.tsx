import { useReceipts } from '../runtime/financial/receipt-state';
import { paymentReceiptFacts } from '../runtime/financial/payment-receipt-view';
import { formatAmount, getTokenMeta } from '../runtime/format';
import { useApp } from '../runtime/store';
import { explainWalletError } from '@xln/frontend/lib/utils/ui/walletError';

export function Toasts() {
	const toasts = useApp(s => s.toasts);
	const receipt = useReceipts(s => s.latest);
	if (toasts.length === 0 && !receipt) return null;
	const facts = receipt ? paymentReceiptFacts(receipt.name, receipt.data) : null;
	const meta = facts?.tokenId == null ? null : getTokenMeta(facts.tokenId);
	const amount = facts?.amount != null && meta ? `${formatAmount(facts.amount, meta.decimals, meta.decimals)} ${meta.symbol}` : 'Payment';
	return (
		<div className="toasts" aria-live="polite">
			{receipt && <div className="toast" data-testid="payment-notification" role="status">
				<span>{facts?.sent ? 'Paid' : 'Received'} {amount}</span>
				<button type="button" className="btn quiet sm" data-testid="receipt-open" onClick={() => useReceipts.getState().open()}>Receipt</button>
				<button type="button" className="icon-btn" aria-label="Dismiss payment notification" onClick={() => useReceipts.getState().dismissNotification()}>×</button>
			</div>}
			{toasts.map(toast => (
				<div key={toast.id} className={`toast${toast.kind === 'danger' ? ' toast-danger' : ''}`} role={toast.kind === 'danger' ? 'alert' : 'status'} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
					{toast.kind === 'danger' ? explainWalletError(toast.text) : toast.text}
					<button type="button" className="icon-btn" aria-label="Dismiss notification" onClick={() => useApp.getState().dismissToast(toast.id)}>×</button>
				</div>
			))}
		</div>
	);
}

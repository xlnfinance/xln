import { Icon } from './Icons';
import { Sheet } from './Sheet';
import { useApp } from '../runtime/store';
import { useReceipts } from '../runtime/financial/receipts';
import { formatMoney, getTokenMeta } from '../runtime/format';
import { displayEntityName, useWallet } from '../runtime/views';

/**
 * The receipt for a terminal HTLC event. Shown from the durable frame log the
 * runtime committed, never from an optimistic local guess.
 */
export function PaymentReceiptSheet() {
	const receipt = useReceipts(s => s.latest);
	const dismiss = useReceipts(s => s.dismiss);
	const entityId = useApp(s => s.activeEntityId);
	// Same name source as Home: the entity's own view frame.
	const { names } = useWallet(receipt ? entityId : null);

	if (!receipt) return null;

	const data = receipt.data;
	const tokenId = Number(data['tokenId']);
	const meta = getTokenMeta(Number.isFinite(tokenId) ? tokenId : 1);
	let amount = 0n;
	try {
		amount = BigInt(String(data['amount'] ?? '0'));
	} catch {
		amount = 0n;
	}
	const sent = receipt.name === 'HtlcFinalized';
	const hop = String((sent ? data['toEntity'] : data['fromEntity']) || '').toLowerCase();
	const counterparty = receipt.recipientId ?? hop;
	const via = sent && receipt.recipientId && hop && hop !== receipt.recipientId ? displayEntityName(names, hop) : '';
	const elapsedRaw = Number(data['finalizedInMs'] ?? data['elapsedMs'] ?? 0);
	const elapsed = Number.isFinite(elapsedRaw) && elapsedRaw > 0 ? Math.max(1, Math.floor(elapsedRaw)) : null;
	const description = String(data['description'] || '').trim();
	const proof = String(data['hashlock'] || data['lockId'] || '');

	return (
		<Sheet onClose={dismiss} testId="payment-receipt">
			<div className="rcpt">
				<div className="ok">
					<Icon name="check" size={26} />
				</div>
				<div className="caps" data-testid="receipt-kicker">
					{sent ? 'Paid' : 'Received'}
				</div>
				<div className="a num" data-testid="receipt-amount">
					{formatMoney(amount, meta.decimals)} <small>{meta.symbol}</small>
				</div>
				<div className="to" data-testid="receipt-title">
					{sent ? 'to' : 'from'} {counterparty ? displayEntityName(names, counterparty) : '—'}
					{via ? <span className="faint"> via {via}</span> : null}
					{description ? ` · ${description}` : ''}
				</div>
			</div>
			<div>
				<div className="kv">
					<span className="k">Settled</span>
					<span className="v st-settled">{elapsed ? `Instantly · ${elapsed} ms` : 'Instantly'}</span>
				</div>
				<div className="kv">
					<span className="k">Frame</span>
					<span className="v num">#{receipt.height.toLocaleString('en-US')}</span>
				</div>
				{proof ? (
					<div className="kv">
						<span className="k">Proof</span>
						<span className="v mono" style={{ color: 'var(--ink-2)' }}>
							{proof.slice(0, 10)}…{proof.slice(-4)}
						</span>
					</div>
				) : null}
			</div>
			<div className="state st-settled" style={{ justifyContent: 'center', display: 'flex' }}>
				Verified by your runtime
			</div>
			<button type="button" className="btn ghost" onClick={dismiss} data-testid="receipt-done">
				Done
			</button>
		</Sheet>
	);
}

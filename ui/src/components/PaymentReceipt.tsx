import { useMemo } from 'react';
import type { RuntimeAdapterActivityPage } from '@xln/core/api/public/runtime-module';
import { useAdapterRead } from '../runtime/hooks';
import { originatedRecipient, paymentReceiptFacts } from '../runtime/financial/payment-receipt-view';
import { CopyId } from './CopyId';
import { Icon } from './Icons';
import { Sheet } from './Sheet';
import { useApp } from '../runtime/store';
import { useReceipts } from '../runtime/financial/receipt-state';
import { formatClock, formatMoney, getTokenMeta } from '../runtime/format';
import { displayEntityName, useWallet } from '../runtime/views';

/**
 * The receipt for a terminal HTLC event. Shown from the durable frame log the
 * runtime committed, never from an optimistic local guess.
 */
export function PaymentReceiptSheet() {
	const receipt = useReceipts(s => s.opened);
	const dismiss = useReceipts(s => s.close);
	const entityId = useApp(s => s.activeEntityId);
	// Same name source as Home: the entity's own view frame.
	const { names } = useWallet(receipt ? entityId : null);

	const hash = String(receipt?.data['hashlock'] ?? receipt?.data['lockId'] ?? '');
	const query = useMemo(() => ({ entityId: entityId ?? '', q: hash, types: ['payment'], limit: 100, scanLimit: 1000 }), [entityId, hash]);
	const history = useAdapterRead<RuntimeAdapterActivityPage>(receipt && hash ? 'activity' : null, query);
	const recipient = originatedRecipient(history.data?.events ?? [], entityId ?? '', hash);
	if (!receipt) return null;

	const data = receipt.data;
	const { sent, counterparty: observedAccount, tokenId, amount } = paymentReceiptFacts(receipt.name, data);
	const counterparty = recipient ?? observedAccount;
	const partyLabel = sent ? recipient ? 'to' : 'via account' : 'from account';
	const meta = tokenId === null ? null : getTokenMeta(tokenId);
	const amountLabel = amount !== null && meta ? `${formatMoney(amount, meta.decimals)} ${meta.symbol}` : 'Amount not recorded';
	const elapsedRaw = Number(data['finalizedInMs'] ?? data['elapsedMs'] ?? 0);
	const elapsed = Number.isFinite(elapsedRaw) && elapsedRaw > 0 ? Math.max(1, Math.floor(elapsedRaw)) : null;
	const description = String(data['description'] || '').trim();
	const finalizedAt = Number(data['finalizedAtMs'] ?? 0);
	const clock = Number.isFinite(finalizedAt) && finalizedAt > 0 ? formatClock(finalizedAt) : '';
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
					{amountLabel}
				</div>
				<div className="to" data-testid="receipt-title">
					{partyLabel} {counterparty ? displayEntityName(names, counterparty) : '—'}
					{description ? ` · ${description}` : ''}
				</div>
			</div>
			<div>
				<div className="kv">
					<span className="k">Settled</span>
					<span className="v st-settled">
						{clock ? <span className="mono" style={{ color: 'var(--ink-2)', marginRight: 8 }}>{clock}</span> : null}
						{elapsed === null ? 'Duration not recorded' : elapsed < 1_000 ? 'in under a second' : `in ${Math.round(elapsed / 1000)} s`}
					</span>
				</div>
				<div className="kv">
					<span className="k">Frame</span>
					<span className="v num">#{receipt.height.toLocaleString('en-US')}</span>
				</div>
				{proof ? (
					<div className="kv">
						<span className="k">Hashlock</span>
						<span className="v">
							<CopyId value={proof} label="Hashlock" head={10} tail={4} />
						</span>
					</div>
				) : null}
			</div>
			<div className="state st-settled" style={{ justifyContent: 'center', display: 'flex' }}>
				Recorded by your runtime
			</div>
			<div className="actions" style={{ display: 'flex', gap: 8 }}>
				<button
					type="button"
					className="btn"
					style={{ flex: 1 }}
					data-testid="receipt-copy"
					onClick={() => {
						const lines = [
							`${sent ? 'Paid' : 'Received'} ${amountLabel} ${partyLabel} ${counterparty ? displayEntityName(names, counterparty) : '—'}`,
							description ? `For: ${description}` : '',
							clock ? `Settled: ${clock}` : '',
							`Frame: #${receipt.height}`,
							proof ? `Hashlock: ${proof}` : '',
							'Committed payment event · xln',
						].filter(Boolean);
						void navigator.clipboard?.writeText(lines.join('\n'));
					}}
				>
					Copy receipt
				</button>
				<button
					type="button"
					className="btn"
					style={{ flex: 1 }}
					data-testid="receipt-download"
					title="The receipt with its frame, proof and every event, as a file for your books"
					onClick={() => {
						const blob = new Blob([JSON.stringify({ kind: sent ? 'paid' : 'received', amount: amount?.toString() ?? null, tokenId, counterparty, description: description || undefined, settledAt: clock || undefined, frame: receipt.height, proof: proof || undefined, event: receipt.name, data }, (_key, value) => (typeof value === 'bigint' ? String(value) : value), 2)], { type: 'application/json' });
						const url = URL.createObjectURL(blob);
						const link = document.createElement('a');
						link.href = url;
						link.download = `xln-receipt-frame-${receipt.height}.json`;
						link.click();
						setTimeout(() => URL.revokeObjectURL(url), 1_000);
					}}
				>
					Download
				</button>
				<button type="button" className="btn" style={{ flex: 1 }} onClick={() => window.print()} data-testid="receipt-print" title="Print, or save as PDF from the print dialog">
					Print / PDF
				</button>
				<button type="button" className="btn primary" style={{ flex: 1 }} onClick={dismiss} data-testid="receipt-done">
					Done
				</button>
			</div>
		</Sheet>
	);
}

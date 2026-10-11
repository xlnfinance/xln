import { formatMoney } from '../../runtime/format';
import { getTokenMeta } from '../../runtime/token-meta';
import type { Movement } from '../../runtime/financial/movements';
/** A statement for the books: one line per movement, with the frame that carries it. */
export function exportCsv(movements: Movement[]): void {
	const cell = (value: string | number | null | undefined): string => `"${String(value ?? '').replace(/"/g, '""')}"`;
	const lines = [
		['date', 'title', 'direction', 'amount', 'token', 'quote_amount', 'quote_token', 'counterparty', 'via', 'state', 'detail', 'frame', 'hash'].join(','),
		...movements.map(movement => {
			const meta = movement.tokenId !== null ? getTokenMeta(movement.tokenId) : null;
			return [
				movement.timestamp ? new Date(movement.timestamp).toISOString() : '',
				movement.title,
				movement.direction,
				movement.amount !== null && meta ? formatMoney(movement.amount, meta.decimals, meta.decimals) : '',
				meta?.symbol ?? '',
				movement.quoteAmount != null && movement.quoteTokenId != null ? formatMoney(movement.quoteAmount, getTokenMeta(movement.quoteTokenId).decimals, getTokenMeta(movement.quoteTokenId).decimals) : '',
				movement.quoteTokenId != null ? getTokenMeta(movement.quoteTokenId).symbol : '',
				movement.counterpartyId ?? '',
				movement.viaId ?? '',
				movement.state,
				movement.detail,
				movement.height,
				movement.hash ?? '',
			].map(cell).join(',');
		}),
	];
	const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
	const url = URL.createObjectURL(blob);
	const link = document.createElement('a');
	link.href = url;
	link.download = `xln-activity-${new Date().toISOString().slice(0, 10)}.csv`;
	link.click();
	setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

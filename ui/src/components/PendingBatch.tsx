import { useState } from 'react';
import type { JBatch } from '@xln/core/api/public/runtime-module';
import { Icon } from './Icons';
import { useApp } from '../runtime/store';
import { sendEntityTxs } from '../runtime/tx';
import { formatMoney, getTokenMeta } from '../runtime/format';
import { countBatchOps } from '../runtime/financial/move';
import { displayEntityName, type WalletView } from '../runtime/views';

type Item = { key: string; title: string; detail: string };

const normalizeId = (value: unknown): String => String(value || '').trim().toLowerCase();

/** One line per queued on-chain operation, in the order the Depository applies them. */
export function batchItems(batch: JBatch, self: string, names: Map<string, string>): Item[] {
	const money = (tokenId: number, amount: bigint): string => {
		const meta = getTokenMeta(tokenId);
		return `${formatMoney(amount, meta.decimals)} ${meta.symbol}`;
	};
	const who = (id: unknown): string => displayEntityName(names, String(id || ''));
	const items: Item[] = [];
	(batch.externalTokenToReserve ?? []).forEach((op, index) =>
		items.push({ key: `e2r-${index}`, title: 'Wallet → Reserve', detail: `${money(op.internalTokenId, op.amount)} to ${normalizeId(op.entity) === self || !op.entity ? 'you' : who(op.entity)}` }),
	);
	(batch.reserveToReserve ?? []).forEach((op, index) =>
		items.push({ key: `r2r-${index}`, title: normalizeId(op.receivingEntity) === self ? 'Reserve ← Reserve' : 'Reserve → Reserve', detail: `${money(op.tokenId, op.amount)} to ${who(op.receivingEntity)}` }),
	);
	(batch.collateralToReserve ?? []).forEach((op, index) =>
		items.push({ key: `c2r-${index}`, title: 'Account → Reserve', detail: `${money(op.tokenId, op.amount)} from ${who(op.counterparty)}` }),
	);
	(batch.settlements ?? []).forEach((op, index) => {
		const other = normalizeId(op.leftEntity) === self ? op.rightEntity : op.leftEntity;
		items.push({ key: `settle-${index}`, title: 'Settlement', detail: `with ${who(other)} · ${op.diffs?.length ?? 0} ${op.diffs?.length === 1 ? 'token' : 'tokens'}` });
	});
	(batch.reserveToCollateral ?? []).forEach((op, index) => {
		for (const pair of op.pairs ?? []) items.push({ key: `r2c-${index}-${pair.entity}`, title: 'Reserve → Account', detail: `${money(op.tokenId, pair.amount)} with ${who(pair.entity)}` });
	});
	(batch.reserveToExternalToken ?? []).forEach((op, index) =>
		items.push({ key: `r2e-${index}`, title: 'Reserve → Wallet', detail: `${money(op.tokenId, op.amount)} to ${String(op.receivingEntity || '').slice(0, 10)}…` }),
	);
	(batch.disputeStarts ?? []).forEach((_, index) => items.push({ key: `ds-${index}`, title: 'Dispute start', detail: 'on-chain proof' }));
	(batch.counterDisputes ?? []).forEach((_, index) => items.push({ key: `cd-${index}`, title: 'Dispute answer', detail: 'on-chain proof' }));
	(batch.disputeFinalizations ?? []).forEach((_, index) => items.push({ key: `df-${index}`, title: 'Dispute finalize', detail: 'on-chain proof' }));
	(batch.flashloans ?? []).forEach((op, index) => items.push({ key: `fl-${index}`, title: 'Flashloan', detail: money(op.tokenId, op.amount) }));
	(batch.revealSecrets ?? []).forEach((_, index) => items.push({ key: `rs-${index}`, title: 'Reveal secret', detail: 'HTLC on-chain' }));
	(batch.hashLadderRegistrations ?? []).forEach((_, index) => items.push({ key: `hl-${index}`, title: 'Hash ladder', detail: 'registration' }));
	return items;
}

/**
 * The entity's queued on-chain batch. A draft waits for "Sign & send"; a sent
 * batch waits for the chain. Same three actions as the SvelteKit notice.
 */
export function PendingBatch({ wallet, compact = false }: { wallet: WalletView; compact?: boolean }) {
	const toast = useApp(s => s.toast);
	const [busy, setBusy] = useState<string | null>(null);
	const [open, setOpen] = useState(!compact);
	const state = wallet.frame?.activeEntity?.core?.jBatchState;
	const draft = state?.batch ?? null;
	const sent = state?.sentBatch?.batch ?? null;
	const draftCount = countBatchOps(draft);
	const sentCount = countBatchOps(sent);
	if (draftCount === 0 && sentCount === 0) return null;
	const mode: 'draft' | 'sent' = draftCount > 0 ? 'draft' : 'sent';
	const batch = (mode === 'draft' ? draft : sent) as JBatch;
	const items = batchItems(batch, wallet.entityId, wallet.names);

	const run = async (action: 'clear' | 'broadcast' | 'rebroadcast'): Promise<void> => {
		if (!wallet.signerId) return;
		setBusy(action);
		try {
			await sendEntityTxs(wallet.entityId, wallet.signerId, [
				action === 'clear'
					? { type: 'j_clear_batch', data: { reason: 'global-batch-bar-clear' } }
					: action === 'broadcast'
						? { type: 'j_broadcast', data: {} }
						: { type: 'j_rebroadcast', data: { gasBumpBps: 1000 } },
			]);
			toast(action === 'clear' ? 'Batch cleared' : action === 'broadcast' ? 'Batch signed and sent to the chain' : 'Batch re-sent with a higher fee');
		} catch (error) {
			toast(error instanceof Error ? error.message : String(error), 'danger');
		} finally {
			setBusy(null);
		}
	};

	return (
		<div className="card batch" data-testid="pending-batch" data-mode={mode}>
			<div className="sect" style={{ marginTop: 0 }}>
				<h3 className="caps">
					{mode === 'draft' ? 'On-chain batch' : 'Batch on the chain'} · {mode === 'draft' ? draftCount : sentCount}
					{!open ? (
						<span className="faint" style={{ textTransform: 'none', letterSpacing: 0, marginLeft: 8 }}>
							{Array.from(new Set(items.map(item => item.title))).slice(0, 3).join(' · ')}
						</span>
					) : null}
				</h3>
				<button type="button" className="more" onClick={() => setOpen(value => !value)}>
					{open ? 'Hide' : 'Show'}
				</button>
			</div>
			{open ? (
				<div>
					{items.map(item => (
						<div key={item.key} className="kv">
							<span className="k">{item.title}</span>
							<span className="v" style={{ fontWeight: 400 }}>
								{item.detail}
							</span>
						</div>
					))}
				</div>
			) : null}
			<div className="actions" style={{ marginTop: 12 }}>
				{mode === 'draft' ? (
					<>
						<button type="button" className="btn" disabled={busy !== null || sentCount > 0} onClick={() => void run('broadcast')} data-testid="batch-broadcast">
							<Icon name="check" size={15} />
							{busy === 'broadcast' ? 'Signing…' : 'Sign & send'}
						</button>
						<button type="button" className="btn ghost" disabled={busy !== null} onClick={() => void run('clear')}>
							Clear
						</button>
					</>
				) : (
					<button type="button" className="btn ghost" disabled={busy !== null} onClick={() => void run('rebroadcast')}>
						{busy === 'rebroadcast' ? 'Sending…' : 'Re-send with higher fee'}
					</button>
				)}
			</div>
			<p className="note" style={{ marginTop: 8 }}>
				{mode === 'draft'
					? 'Queued operations settle together in one Depository transaction. Nothing moves until you sign.'
					: 'Waiting for the chain to confirm. Re-send only if it stalls.'}
			</p>
		</div>
	);
}

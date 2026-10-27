import { useState } from 'react';
import { Icon } from '../Icons';
import { useApp } from '../../runtime/store';
import { sendEntityTxs } from '../../runtime/tx';
import { formatMoney } from '../../runtime/format';
import { getTokenMeta } from '../../runtime/token-meta';
import type { AccountView, WalletView } from '../../runtime/views';
import { buildSettleApproveTx, describeSettlementOp, settlementView } from '../../runtime/financial/manage';
const moneyOf = (tokenId: number, amount: bigint): string => {
	const meta = getTokenMeta(tokenId);
	return `${formatMoney(amount, meta.decimals)} ${meta.symbol}`;
};

/**
 * Settlement workspace on this account: who proposed, who signed, and the one
 * action the wallet can take (sign when it is our turn). Execution and the
 * on-chain batch follow automatically once both hankos are in.
 */
export function SettlementCard({ account, wallet }: { account: AccountView; wallet: WalletView }) {
	const toast = useApp(s => s.toast);
	const commandReady = useApp(s => s.commandReady);
	const [busy, setBusy] = useState(false);
	const view = settlementView(account.doc, account.isLeft);
	if (!view) return null;

	const sign = async (): Promise<void> => {
		if (!wallet.signerId) return;
		setBusy(true);
		try {
			await sendEntityTxs(wallet.entityId, wallet.signerId, [buildSettleApproveTx(account.counterpartyId, view.workspaceHash)]);
			toast('Settlement signed');
		} catch (error) {
			toast(error instanceof Error ? error.message : String(error), 'danger');
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="card" style={{ marginBottom: 14 }} data-testid="settlement-card" data-phase={view.phase}>
			<div className="sect" style={{ marginTop: 0 }}>
				<h3 className="caps">Settlement</h3>
				<span className={`state ${view.phase === 'awaiting_you' ? 'st-pending' : view.phase === 'submitted' || view.phase === 'ready' ? 'st-inflight' : 'st-settled'}`}>
					{view.label}
				</span>
			</div>
			{view.ops.map((op, index) => (
				<div key={index} className="kv">
					<span className="k">{op.type}</span>
					<span className="v" style={{ fontWeight: 400 }}>
						{describeSettlementOp(op, moneyOf, view.proposedByUs)}
					</span>
				</div>
			))}
			<div className="kv">
				<span className="k">Signatures</span>
				<span className="v" style={{ fontWeight: 400 }}>
					you {view.signedByUs ? '✓' : '·'} · {account.label} {view.signedByThem ? '✓' : '·'}
				</span>
			</div>
			<div className="kv">
				<span className="k">Submits on-chain</span>
				<span className="v" style={{ fontWeight: 400 }}>
					{view.weExecute ? 'you' : account.label}
				</span>
			</div>
			{view.memo ? (
				<p className="note" style={{ marginTop: 8 }}>
					{view.memo}
				</p>
			) : null}
			{view.phase === 'awaiting_you' ? (
				<button type="button" className="btn primary" style={{ marginTop: 12 }} disabled={busy || !wallet.signerId || !commandReady} onClick={() => void sign()} data-testid="settlement-sign">
					<Icon name="check" size={15} />
					{busy ? 'Signing…' : 'Sign settlement'}
				</button>
			) : null}
		</div>
	);
}

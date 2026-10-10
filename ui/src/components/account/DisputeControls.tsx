import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { accountSafety, formatDuration } from '../../runtime/financial/sovereignty';
import { buildDisputeFinalizeTx, buildPrepareDisputeTx, disputeView } from '../../runtime/financial/manage';
import type { AccountView, WalletView } from '../../runtime/views';
import { sendEntityTxs } from '../../runtime/tx';
import { useApp } from '../../runtime/store';

export function DisputeControls({ account, wallet, onClose }: { account: AccountView; wallet: WalletView; onClose: () => void }) {
	const navigate = useNavigate();
	const toast = useApp(s => s.toast);
	const [busy, setBusy] = useState(false);
	const [confirmDispute, setConfirmDispute] = useState(false);
	const counterpartyId = account.counterpartyId;
	const dispute = disputeView(account.doc, account.isLeft, wallet.frame?.activeEntity?.core?.jBatchState?.batch ?? null);
	const finalizationReady = dispute.observedOnChain && dispute.timeout > 0 && Number(wallet.frame?.activeEntity?.core?.timestamp ?? 0) >= dispute.timeout * 1000;
	const send = (txs: Parameters<typeof sendEntityTxs>[2]) => sendEntityTxs(wallet.entityId, wallet.signerId, txs);
	const run = async (label: string, work: () => Promise<void>) => {
		setBusy(true);
		try { await work(); toast(label); onClose(); }
		catch (error) { toast(error instanceof Error ? error.message : String(error), 'danger'); }
		finally { setBusy(false); }
	};
	return (
				<div className="fade-in">
					{dispute.phase === 'closed' ? (
						<p className="note" data-testid="dispute-closed">Dispute finalized. This account is permanently closed.</p>
					) : dispute.phase === 'active' ? (
						<>
							<p className="state st-dispute" style={{ marginBottom: 10 }}>
								Dispute {dispute.observedOnChain ? 'on-chain' : 'queued'} · started by {dispute.startedByUs ? 'you' : account.label}
							</p>
							<p className="note">
								{dispute.timeout > 0 ? `Challenge window closes ${new Date(dispute.timeout * 1000).toLocaleString()}. ` : ''}
								While this wallet is unlocked and online, it automatically submits finalization after the challenge window. If it locks, unlock it to resume. The chain releases the winning balance to your reserve; gas is required.
							</p>
							<button type="button" className="btn primary danger" disabled={busy || dispute.finalizeQueued || !finalizationReady} onClick={() => void run('Dispute finalization queued', async () => { await send([buildDisputeFinalizeTx(counterpartyId)]); })} data-testid="dispute-finalize">
								{dispute.finalizeQueued ? 'Finalize already queued' : !finalizationReady ? 'Waiting for challenge window' : busy ? 'Queuing…' : 'Queue dispute finalize'}
							</button>
						</>
					) : dispute.phase === 'queued' ? (
						<>
							<p className="state st-dispute" style={{ marginBottom: 10 }}>
								Dispute start queued
							</p>
							<p className="note">
								This account is frozen and the on-chain dispute start sits in your batch. Sign and send the batch from Home; the chain then opens the challenge
								window.
							</p>
							<button type="button" className="btn" onClick={() => { onClose(); navigate('/'); }} data-testid="dispute-go-batch">
								Go to the batch
							</button>
						</>
					) : dispute.phase === 'sent' ? (
						<>
							<p className="state st-dispute" style={{ marginBottom: 10 }}>
								Dispute start sent
							</p>
							<p className="note">
								The batch with the dispute start went to the chain. The account stays frozen; the challenge window and the finalize step appear once the
								runtime observes DisputeStarted.
							</p>
						</>
					) : dispute.phase === 'preparing' ? (
						<>
							<p className="state st-dispute" style={{ marginBottom: 10 }}>
								Preparing the dispute
							</p>
							<p className="note">
								Traffic on this account is frozen and open orders are being withdrawn. The on-chain dispute start joins your batch as soon as the evidence is
								stable.
							</p>
						</>
					) : (
						<>
							<p className="note">
								Disputing freezes this account, withdraws your orders at the hub and puts the latest signed state on-chain. Use it when {account.label} stops
								responding or refuses a settlement. It cannot be undone.
							</p>
							<ol className="note" style={{ margin: '0 0 12px', paddingLeft: 18, display: 'grid', gap: 4 }} data-testid="dispute-window-note">
								<li>You start it: the latest page both of you signed goes on-chain with your next batch. The account freezes.</li>
								<li>
									{account.label} has <b>{formatDuration(accountSafety(account).theirResponseSeconds)}</b> to answer with a newer signed page. The newer page wins.
								</li>
								<li>When the window closes, your online wallet submits finalization automatically. The chain pays the winning balance into your reserve.</li>
							</ol>
							{!confirmDispute ? (
								<button type="button" className="btn danger" disabled={busy} onClick={() => setConfirmDispute(true)} data-testid="dispute-prepare">
									Dispute this account…
								</button>
							) : (
								<div className="actions">
									<button type="button" className="btn primary danger" disabled={busy} onClick={() => void run('Dispute prepared; the on-chain start joins your batch', async () => { await send([buildPrepareDisputeTx(counterpartyId)]); })} data-testid="dispute-prepare-confirm">
										{busy ? 'Preparing…' : 'Yes, dispute'}
									</button>
									<button type="button" className="btn ghost" disabled={busy} onClick={() => setConfirmDispute(false)}>
										Keep the account
									</button>
								</div>
							)}
						</>
					)}
				</div>
	);
}

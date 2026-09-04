import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CopyId } from '../components/CopyId';
import { Icon } from '../components/Icons';
import { useApp } from '../runtime/store';
import { formatMoney, shortId } from '../runtime/format';
import { useWallet } from '../runtime/views';
import {
	activateTakeover,
	isNumbered,
	proposeTakeover,
	readTakeoverStatus,
	releaseShares,
	releaseState,
	shareTokens,
	takeoverTargets,
	type EntityShareTokenProjection,
	type TakeoverStatus,
} from '../runtime/financial/ownership';

const SHARE_DECIMALS = 0;

/**
 * Who owns this entity: its CONTROL and DIVIDEND share tokens on the
 * EntityProvider, the treasury release that mints them into the Depository,
 * and a takeover of another entity this signer already validates.
 */
export function Ownership() {
	const navigate = useNavigate();
	const entityId = useApp(s => s.activeEntityId);
	const toast = useApp(s => s.toast);
	const height = useApp(s => s.height);
	const wallet = useWallet(entityId);
	const numbered = isNumbered(wallet.entityId);
	const release = releaseState(wallet.frame);
	const core = wallet.frame?.activeEntity?.core;
	const depository = String(core?.config?.jurisdiction?.depositoryAddress || '').toLowerCase();
	const [shares, setShares] = useState<readonly EntityShareTokenProjection[]>([]);
	const [sharesError, setSharesError] = useState('');
	const [busy, setBusy] = useState<string | null>(null);
	const [targetId, setTargetId] = useState('');
	const [status, setStatus] = useState<TakeoverStatus | null>(null);
	const targets = takeoverTargets(wallet.entityId, wallet.signerId, wallet.names);
	const validators = core?.config?.validators ?? [];
	const threshold = core?.config?.threshold ?? 0n;

	const refreshShares = useCallback(async () => {
		if (!numbered || !wallet.entityId || !wallet.signerId) return;
		try {
			setShares(await shareTokens(wallet.entityId, wallet.signerId, core?.reserves ?? new Map()));
			setSharesError('');
		} catch (error) {
			setSharesError(error instanceof Error ? error.message : String(error));
		}
	}, [numbered, wallet.entityId, wallet.signerId, core?.reserves]);

	useEffect(() => {
		void refreshShares();
	}, [refreshShares, height]);

	const run = async (key: string, label: string, work: () => Promise<void>): Promise<void> => {
		setBusy(key);
		try {
			await work();
			toast(label);
		} catch (error) {
			toast(error instanceof Error ? error.message : String(error), 'danger');
		} finally {
			setBusy(null);
		}
	};

	return (
		<div className="screen fade-in">
			<div className="screen-header">
				<span className="screen-title">
					<button type="button" className="icon-btn" onClick={() => navigate(-1)} aria-label="Back" data-testid="back">
						<Icon name="chevronLeft" size={18} />
					</button>
					Ownership
				</span>
			</div>
			<div className="two-col">
				<div>
					<div className="card" data-testid="board">
						<h3 className="caps">Board</h3>
						<div className="kv" style={{ marginTop: 8 }}>
							<span className="k">Entity</span>
							<span className="v" style={{ fontWeight: 400 }}>
								<CopyId value={wallet.entityId} label="Entity id" />
							</span>
						</div>
						<div className="kv">
							<span className="k">Kind</span>
							<span className="v">{numbered ? 'Registered on the EntityProvider' : 'Lazy (hash of its board)'}</span>
						</div>
						<div className="kv">
							<span className="k">Threshold</span>
							<span className="v num">
								{threshold.toString()} of {validators.length}
							</span>
						</div>
						{validators.map(validator => (
							<div key={validator} className="kv">
								<span className="k">Signer</span>
								<span className="v mono" style={{ fontWeight: 400 }}>
									{shortId(validator, 8, 6)}
									{validator.toLowerCase() === wallet.signerId ? <span className="chip hub" style={{ marginLeft: 6 }}>you</span> : null}
								</span>
							</div>
						))}
						<p className="note" style={{ marginTop: 10 }}>
							{numbered
								? 'A registered entity has a number on-chain; its CONTROL shares decide the board and its DIVIDEND shares carry the economics.'
								: 'A lazy entity is identified by the hash of its board. Register it on the EntityProvider to issue shares or change owners.'}
						</p>
					</div>

					{numbered ? (
						<div className="card" data-testid="shares">
							<h3 className="caps">Shares</h3>
							{sharesError ? (
								<p className="note" style={{ color: 'var(--debt)' }}>
									{sharesError.includes('LOCAL_RUNTIME') ? 'Share balances are read from the chain by a local runtime only.' : sharesError}
								</p>
							) : null}
							{shares.map(share => (
								<div key={share.shareClass} className="kv">
									<span className="k">{share.shareClass === 'control' ? 'CONTROL' : 'DIVIDEND'} in reserve</span>
									<span className="v num">{share.internalTokenId === null ? 'not issued' : formatMoney(share.reserve, SHARE_DECIMALS, 0)}</span>
								</div>
							))}
							<div className="kv">
								<span className="k">Release</span>
								<span className="v" style={{ fontWeight: 400 }}>
									{release.pendingNonce !== null ? `pending · nonce ${release.pendingNonce.toString()}` : `confirmed nonce ${release.confirmedNonce.toString()}`}
								</span>
							</div>
							<button
								type="button"
								className="btn"
								style={{ marginTop: 10 }}
								disabled={busy !== null || release.pendingNonce !== null || !depository}
								onClick={() => void run('release', 'Share issuance submitted to the board', () => releaseShares(wallet.entityId, wallet.signerId, depository))}
								data-testid="release-shares"
							>
								{busy === 'release' ? 'Submitting…' : 'Release treasury shares to the Depository'}
							</button>
							<p className="note" style={{ marginTop: 8 }}>
								Mints the full CONTROL and DIVIDEND supply into this entity's Depository reserve. From there they move like any other token.
							</p>
						</div>
					) : null}
				</div>
				<div className="aside">
					<div className="card" data-testid="takeover">
						<h3 className="caps">Take control of another entity</h3>
						{targets.length === 0 ? (
							<p className="note" style={{ marginTop: 8 }}>
								Nothing to take over: no other entity in this runtime lists your signer on its board.
							</p>
						) : (
							<>
								<div className="field" style={{ marginTop: 8 }}>
									<span className="field-label">Target</span>
									<div className="mode-grid">
										{targets.map(target => (
											<button key={target.entityId} type="button" className={`mode-card${targetId === target.entityId ? ' active' : ''}`} onClick={() => { setTargetId(target.entityId); setStatus(null); }}>
												<span className="t">{target.name}</span>
												<span className="s">{shortId(target.entityId, 8, 4)}</span>
											</button>
										))}
									</div>
								</div>
								{status ? (
									<>
										<div className="kv">
											<span className="k">Current board</span>
											<span className="v mono" style={{ fontWeight: 400 }}>
												{shortId(status.currentBoardHash, 8, 6)}
											</span>
										</div>
										<div className="kv">
											<span className="k">Proposed board</span>
											<span className="v mono" style={{ fontWeight: 400 }}>
												{/^0x0+$/.test(status.proposedBoardHash) ? 'none' : shortId(status.proposedBoardHash, 8, 6)}
											</span>
										</div>
										<div className="kv">
											<span className="k">Activates at block</span>
											<span className="v num">
												{status.activateAtBlock.toString()} · now {status.currentBlock.toString()}
											</span>
										</div>
									</>
								) : null}
								<div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
									<button type="button" className="btn ghost" disabled={!targetId || busy !== null} onClick={() => void run('status', 'Takeover status refreshed', async () => { setStatus(await readTakeoverStatus(wallet.entityId, wallet.signerId, targetId)); })}>
										{busy === 'status' ? 'Reading…' : 'Read status'}
									</button>
									<button type="button" className="btn" disabled={!targetId || busy !== null} onClick={() => void run('propose', 'CONTROL board proposal submitted', () => proposeTakeover(wallet.entityId, wallet.signerId, targetId))} data-testid="takeover-propose">
										{busy === 'propose' ? 'Proposing…' : 'Propose a board with only me'}
									</button>
									<button type="button" className="btn danger" disabled={!targetId || busy !== null} onClick={() => void run('activate', 'Board activation and handover submitted', () => activateTakeover(wallet.entityId, wallet.signerId, targetId))} data-testid="takeover-activate">
										{busy === 'activate' ? 'Activating…' : 'Activate after the delay'}
									</button>
								</div>
								<p className="note" style={{ marginTop: 8 }}>
									The proposal needs a CONTROL majority on-chain and waits out the activation delay before the handover.
								</p>
							</>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}

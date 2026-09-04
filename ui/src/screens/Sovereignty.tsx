import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bar } from '../components/Bars';
import { CopyId } from '../components/CopyId';
import { Icon } from '../components/Icons';
import { getAdapter } from '../runtime/adapter';
import { useApp } from '../runtime/store';
import { formatUsd, shortId, timeAgo } from '../runtime/format';
import { useWallet } from '../runtime/views';
import { accountSafety, evidenceBundle, formatDuration, serializeEvidence } from '../runtime/financial/sovereignty';

/**
 * The certainty screen. Not balances: who holds the keys, which state is
 * enforceable right now, what is exposed to whom, and the evidence a dispute
 * would use. Everything shown is read from signed state, nothing is inferred.
 */
export function Sovereignty() {
	const navigate = useNavigate();
	const entityId = useApp(s => s.activeEntityId);
	const vaults = useApp(s => s.vaults);
	const activeVaultId = useApp(s => s.activeVaultId);
	const toast = useApp(s => s.toast);
	const wallet = useWallet(entityId);
	const vault = vaults.find(entry => entry.id === activeVaultId) ?? null;
	const adapter = getAdapter();
	const core = wallet.frame?.activeEntity?.core;
	const safety = useMemo(() => wallet.accounts.map(accountSafety), [wallet.accounts]);
	const totals = safety.reduce(
		(sum, entry) => ({ risk: sum.risk + entry.riskUsd, secured: sum.secured + entry.securedUsd, owed: sum.owed + entry.owedUsd }),
		{ risk: 0, secured: 0, owed: 0 },
	);
	const cosigned = safety.filter(entry => entry.frameCosigned).length;
	const alone = safety.filter(entry => entry.canDisputeAlone).length;
	const lastFrameAt = Number(core?.timestamp || 0);

	const keysWhere =
		vault?.kind === 'brainvault'
			? `Derived from your name and passphrase on this device (brainvault, factor ${vault.brainvault?.factor ?? '—'}). Nothing is stored anywhere.`
			: vault?.kind === 'mnemonic'
				? 'A recovery phrase unlocked on this device; it never leaves the page.'
				: vault?.kind === 'remote'
					? `Held by the runtime at ${vault.remote?.wsUrl ?? '—'}. This device only reads and, with an admin key, instructs.`
					: 'A throwaway sandbox phrase. Test money only.';

	const exportEvidence = (): void => {
		const text = serializeEvidence(evidenceBundle(wallet.frame, wallet.accounts, wallet.entityId));
		const blob = new Blob([text], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement('a');
		anchor.href = url;
		anchor.download = `xln-evidence-${wallet.entityId.slice(2, 10)}-${wallet.frameHeight}.json`;
		anchor.click();
		setTimeout(() => URL.revokeObjectURL(url), 1_000);
		toast('Evidence bundle saved');
	};

	return (
		<div className="screen fade-in">
			<div className="screen-header">
				<span className="screen-title">
					<button type="button" className="icon-btn" onClick={() => navigate(-1)} aria-label="Back">
						<Icon name="chevronLeft" size={18} />
					</button>
					Sovereignty
				</span>
			</div>
			<div className="two-col">
				<div>
					<div className="hero" data-testid="sovereignty-hero">
						<div className="hero-label">Enforceable right now</div>
						<div className="display num" style={{ fontSize: 40, lineHeight: 1.1 }}>
							{formatUsd(wallet.usd.onchain + wallet.usd.reserve + totals.secured)}
						</div>
						<div className="rb">
							<Bar
								segments={[
									{ usd: wallet.usd.onchain, kind: 'onchain' },
									{ usd: wallet.usd.reserve, kind: 'reserve' },
									{ usd: totals.secured, kind: 'coll' },
									{ usd: totals.risk, kind: 'risk' },
								]}
								height={8}
							/>
						</div>
						<div className="tiers">
							<span>
								<i className="sw c-onchain" /> On-chain <b className="num">{formatUsd(wallet.usd.onchain)}</b>
							</span>
							<span>
								<i className="sw c-reserve" /> Reserve <b className="num">{formatUsd(wallet.usd.reserve)}</b>
							</span>
							<span>
								<i className="sw c-coll" /> Collateral behind what you are owed <b className="num">{formatUsd(totals.secured)}</b>
							</span>
							<span data-testid="sovereignty-risk">
								<i className="sw c-risk" /> Trust only <b className="num">{formatUsd(totals.risk)}</b>
							</span>
						</div>
						<p className="note" style={{ marginTop: 10 }}>
							Green is yours whatever anyone does: on-chain, in the Depository, or locked as collateral by a counterparty. Violet is what a
							counterparty owes you on their signature alone; if they vanish, that is the most you can lose.
						</p>
					</div>

					<div className="card" data-testid="sovereignty-keys">
						<h3 className="caps">Keys</h3>
						<div className="kv" style={{ marginTop: 8 }}>
							<span className="k">Vault</span>
							<span className="v">{vault?.name ?? '—'}</span>
						</div>
						<div className="kv">
							<span className="k">Signer</span>
							<span className="v" style={{ fontWeight: 400 }}>
								<CopyId value={wallet.signerId} label="Signer address" />
							</span>
						</div>
						<div className="kv">
							<span className="k">Entity</span>
							<span className="v" style={{ fontWeight: 400 }}>
								<CopyId value={wallet.entityId} label="Entity id" />
							</span>
						</div>
						<p className="note" style={{ marginTop: 8 }}>
							{keysWhere}
						</p>
					</div>

					<div className="card" data-testid="sovereignty-ledger">
						<h3 className="caps">Ledger</h3>
						<div className="kv" style={{ marginTop: 8 }}>
							<span className="k">Runtime</span>
							<span className="v" style={{ fontWeight: 400 }}>
								{adapter?.mode === 'remote' ? 'remote' : 'in this page'} · {adapter ? shortId(adapter.runtimeId, 8, 4) : '—'}
							</span>
						</div>
						<div className="kv">
							<span className="k">Frame</span>
							<span className="v num">
								#{wallet.frameHeight.toLocaleString('en-US')}
								{lastFrameAt > 0 ? <span className="faint"> · signed {timeAgo(lastFrameAt)}</span> : null}
							</span>
						</div>
						<div className="kv">
							<span className="k">Jurisdiction</span>
							<span className="v" style={{ fontWeight: 400 }}>
								{wallet.jurisdiction || '—'}
								{core?.config?.jurisdiction?.depositoryAddress ? <span className="mono faint"> · Depository {shortId(core.config.jurisdiction.depositoryAddress, 6, 4)}</span> : null}
							</span>
						</div>
						<div className="kv">
							<span className="k">Accounts co-signed</span>
							<span className={`v num ${cosigned === safety.length ? 'st-settled' : 'st-pending'}`}>
								{cosigned} of {safety.length}
							</span>
						</div>
						<div className="kv">
							<span className="k">Can dispute without asking</span>
							<span className={`v num ${alone === safety.length ? 'st-settled' : 'st-pending'}`}>
								{alone} of {safety.length}
							</span>
						</div>
						<button type="button" className="btn" style={{ marginTop: 12 }} onClick={exportEvidence} disabled={safety.length === 0} data-testid="evidence-export">
							<Icon name="shield" size={15} />
							Save evidence bundle
						</button>
						<p className="note" style={{ marginTop: 8 }}>
							Frame hashes and both parties' signatures for every account. Keep it off this device; any runtime can open a dispute from it.
						</p>
					</div>
				</div>
				<div className="aside">
					<div className="card" data-testid="sovereignty-accounts">
						<h3 className="caps">Per counterparty</h3>
						{safety.length === 0 ? (
							<p className="note" style={{ padding: '6px 0' }}>
								No accounts yet.
							</p>
						) : null}
						{safety.map((entry, index) => (
							<button key={entry.counterpartyId} type="button" className={`row tappable${index === 0 ? ' first' : ''}`} onClick={() => navigate(`/accounts/${entry.counterpartyId}`)}>
								<span className="rt">
									<span className="avatar">{entry.label.slice(0, 1).toUpperCase()}</span>
									<span className="tx">
										<span className="t">
											{entry.label}
											{entry.isHub ? <span className="chip hub">hub</span> : null}
											{entry.disputePhase !== 'none' ? <span className="state st-dispute">dispute</span> : null}
										</span>
										<span className="s">
											{entry.frameCosigned ? 'co-signed' : 'awaiting their signature'} · {entry.canDisputeAlone ? 'proof on file' : 'no proof yet'} · they answer in{' '}
											{formatDuration(entry.theirResponseSeconds)}, you in {formatDuration(entry.ourResponseSeconds)}
										</span>
									</span>
									<span className="r">
										<span className={`v num ${entry.riskUsd > 0 ? 'st-inflight' : 'st-settled'}`}>{entry.riskUsd > 0 ? `${formatUsd(entry.riskUsd)} at risk` : 'nothing at risk'}</span>
										<span className="u num">{entry.owedUsd > 0 ? `you owe ${formatUsd(entry.owedUsd)}` : entry.securedUsd > 0 ? `${formatUsd(entry.securedUsd)} secured` : ''}</span>
									</span>
								</span>
								<span className="rb" style={{ display: 'block' }}>
									<Bar
										segments={[
											{ usd: entry.securedUsd, kind: 'coll' },
											{ usd: entry.riskUsd, kind: 'risk' },
											{ usd: entry.owedUsd, kind: 'debt' },
										]}
										height={4}
									/>
								</span>
								{entry.disputeTimeout > 0 ? (
									<span className="note" style={{ display: 'block', marginTop: 6 }}>
										Challenge window closes {new Date(entry.disputeTimeout * 1000).toLocaleString()}
									</span>
								) : null}
							</button>
						))}
					</div>
				</div>
			</div>
		</div>
	);
}

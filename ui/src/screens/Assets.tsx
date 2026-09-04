import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bar } from '../components/Bars';
import { CopyId } from '../components/CopyId';
import { Icon } from '../components/Icons';
import { TokenIcon } from '../components/TokenPicker';
import { useApp } from '../runtime/store';
import { formatMoney, getTokenMeta, knownTokenIds, parseAmount, shortId } from '../runtime/format';
import { usdOf } from '../runtime/financial/prices';
import { useWallet } from '../runtime/views';
import { requestFaucet, readExternalWallet, sandboxFaucet, sandboxFaucetsAvailable, type ExternalWallet, type FaucetKind } from '../runtime/financial/external';
import { debtGroups, enforceDebts, type DebtGroup } from '../runtime/financial/debts';
import { getAdapter } from '../runtime/adapter';

/**
 * Money outside the bilateral accounts: the signer's on-chain wallet with
 * its Depository allowances, the faucets a test runtime offers, and the
 * Depository's debt ledger against this entity.
 */
export function Assets() {
	const navigate = useNavigate();
	const entityId = useApp(s => s.activeEntityId);
	const toast = useApp(s => s.toast);
	const height = useApp(s => s.height);
	const wallet = useWallet(entityId);
	const [external, setExternal] = useState<ExternalWallet | null>(null);
	const [externalError, setExternalError] = useState('');
	const [loading, setLoading] = useState(false);
	const [busy, setBusy] = useState<string | null>(null);
	const [faucetAmount, setFaucetAmount] = useState('100');
	const [faucetTokenId, setFaucetTokenId] = useState(1);
	const sandbox = sandboxFaucetsAvailable();
	const debts = debtGroups(wallet.frame);
	const hubs = wallet.accounts.filter(account => account.isHub);
	const faucetMeta = getTokenMeta(faucetTokenId);

	const refresh = useCallback(async () => {
		if (!wallet.entityId || !wallet.signerId) return;
		setLoading(true);
		try {
			setExternal(await readExternalWallet(wallet.entityId, wallet.signerId));
			setExternalError('');
		} catch (error) {
			setExternal(null);
			setExternalError(error instanceof Error ? error.message : String(error));
		} finally {
			setLoading(false);
		}
	}, [wallet.entityId, wallet.signerId]);

	useEffect(() => {
		void refresh();
	}, [refresh, height]);

	const run = async (key: string, label: string, work: () => Promise<void>): Promise<void> => {
		setBusy(key);
		try {
			await work();
			toast(label);
			void refresh();
		} catch (error) {
			toast(error instanceof Error ? error.message : String(error), 'danger');
		} finally {
			setBusy(null);
		}
	};

	const faucet = (kind: FaucetKind): Promise<void> =>
		run(`faucet-${kind}`, `Faucet request sent (${kind})`, async () => {
			const amount = faucetAmount.trim() || '0';
			if (sandbox && (kind === 'offchain' || kind === 'erc20')) {
				await sandboxFaucet(kind, {
					entityId: wallet.entityId,
					signerId: wallet.signerId,
					tokenSymbol: faucetMeta.symbol,
					amount: parseAmount(amount, faucetMeta.decimals),
				});
				return;
			}
			await requestFaucet(kind, {
				entityId: wallet.entityId,
				signerId: wallet.signerId,
				runtimeId: getAdapter()?.runtimeId ?? '',
				...(hubs[0] ? { hubEntityId: hubs[0].counterpartyId } : {}),
				tokenId: faucetTokenId,
				tokenSymbol: kind === 'gas' ? 'ETH' : faucetMeta.symbol,
				amount,
			});
		});

	return (
		<div className="screen fade-in">
			<div className="screen-header">
				<span className="screen-title">
					<button type="button" className="icon-btn" onClick={() => navigate(-1)} aria-label="Back" data-testid="back">
						<Icon name="chevronLeft" size={18} />
					</button>
					Assets
				</span>
			</div>
			<div className="two-col">
				<div>
					<div className="card" data-testid="external-wallet">
						<div className="sect" style={{ marginTop: 0 }}>
							<h3 className="caps">On-chain wallet</h3>
							<button type="button" className="more" onClick={() => void refresh()} disabled={loading}>
								{loading ? 'Reading…' : 'Refresh'}
							</button>
						</div>
						<div className="kv">
							<span className="k">Signer</span>
							<span className="v" style={{ fontWeight: 400 }}>
								<CopyId value={wallet.signerId} label="Signer address" />
							</span>
						</div>
						{external ? (
							<>
								<div className="kv">
									<span className="k">Depository</span>
									<span className="v mono" style={{ fontWeight: 400 }}>
										{shortId(external.depository, 8, 6)}
									</span>
								</div>
								<div className="kv">
									<span className="k">Gas</span>
									<span className="v num">{external.native === null ? '—' : `${formatMoney(external.native, 18, 4)} ETH`}</span>
								</div>
								{external.rows.map((row, index) => (
									<div key={row.address} className={`row${index === 0 ? ' first' : ''}`} data-testid={`external-row-${row.symbol}`}>
										<span className="rt">
											<TokenIcon tokenId={row.tokenId} />
											<span className="tx">
												<span className="t">{row.symbol}</span>
												<span className="s">
													{row.error
														? row.error
														: row.allowance === null
															? row.name
															: `Depository may pull ${formatMoney(row.allowance, row.decimals)}`}
												</span>
											</span>
											<span className="r">
												<span className="v num" data-testid={`external-balance-${row.symbol}`}>
													{formatMoney(row.balance, row.decimals)}
												</span>
											</span>
										</span>
										<span className="rb" style={{ display: 'block' }}>
											<Bar segments={[{ usd: usdOf(row.tokenId, row.balance), kind: 'onchain' }]} height={4} />
										</span>
									</div>
								))}
								<div className="actions" style={{ marginTop: 12 }}>
									<button type="button" className="btn" onClick={() => navigate('/move?from=external&to=reserve')}>
										<Icon name="arrow" size={15} />
										Move into reserve
									</button>
								</div>
							</>
						) : (
							<p className="note" style={{ marginTop: 8 }}>
								{externalError
									? externalError.includes('LOCAL_RUNTIME')
										? 'A remote runtime does not expose the signer wallet here. Read it from the chain explorer or the SvelteKit console.'
										: externalError
									: 'Reading the chain…'}
							</p>
						)}
					</div>

					<div className="card" data-testid="debts">
						<h3 className="caps">Debts</h3>
						{debts.owed.length === 0 && debts.owedToUs.length === 0 ? (
							<p className="note" style={{ marginTop: 8 }}>
								No debts on the Depository. A debt appears when a settlement or dispute closes with more owed than there was collateral.
							</p>
						) : null}
						{debts.owed.map(group => (
							<DebtRows key={`out-${group.tokenId}`} group={group} names={wallet.names} busy={busy === `debt-${group.tokenId}`} onEnforce={() => void run(`debt-${group.tokenId}`, 'Repayment from reserve queued', () => enforceDebts({ entityId: wallet.entityId, signerId: wallet.signerId, jurisdictionName: wallet.jurisdiction, tokenId: group.tokenId }))} />
						))}
						{debts.owedToUs.map(group => (
							<DebtRows key={`in-${group.tokenId}`} group={group} names={wallet.names} busy={false} />
						))}
					</div>
				</div>
				<div className="aside">
					<div className="card" data-testid="faucets">
						<h3 className="caps">Faucets</h3>
						<p className="note" style={{ marginTop: 8 }}>
							{sandbox ? 'Test money on the sandbox chain and hub. Nothing here is real.' : 'Test money from the runtime you are connected to. Only test networks answer.'}
						</p>
						<div className="field">
							<span className="field-label">Token</span>
							<div className="mode-grid">
								{knownTokenIds().map(id => (
									<button key={id} type="button" className={`mode-card${faucetTokenId === id ? ' active' : ''}`} onClick={() => setFaucetTokenId(id)}>
										<span className="t">{getTokenMeta(id).symbol}</span>
									</button>
								))}
							</div>
						</div>
						<div className="field">
							<span className="field-label">Amount</span>
							<div className="field-row">
								<input className="input" inputMode="decimal" value={faucetAmount} onChange={event => setFaucetAmount(event.target.value)} data-testid="faucet-amount" />
								<span className="muted">{faucetMeta.symbol}</span>
							</div>
						</div>
						<div style={{ display: 'grid', gap: 8 }}>
							<button type="button" className="btn" disabled={busy !== null || hubs.length === 0} onClick={() => void faucet('offchain')} data-testid="faucet-offchain">
								{busy === 'faucet-offchain' ? 'Asking…' : `Hub pays me ${faucetMeta.symbol} over credit`}
							</button>
							<button type="button" className="btn" disabled={busy !== null} onClick={() => void faucet('erc20')} data-testid="faucet-erc20">
								{busy === 'faucet-erc20' ? 'Minting…' : `${faucetMeta.symbol} to my on-chain wallet`}
							</button>
							{!sandbox ? (
								<>
									<button type="button" className="btn" disabled={busy !== null} onClick={() => void faucet('gas')} data-testid="faucet-gas">
										{busy === 'faucet-gas' ? 'Sending…' : 'Gas (ETH) to my on-chain wallet'}
									</button>
									<button type="button" className="btn" disabled={busy !== null} onClick={() => void faucet('reserve')} data-testid="faucet-reserve">
										{busy === 'faucet-reserve' ? 'Asking…' : `${faucetMeta.symbol} straight into my reserve`}
									</button>
								</>
							) : null}
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

function DebtRows({ group, names, busy, onEnforce }: { group: DebtGroup; names: Map<string, string>; busy: boolean; onEnforce?: () => void }) {
	const meta = getTokenMeta(group.tokenId);
	const open = group.entries.filter(entry => entry.remainingAmount > 0n);
	return (
		<div style={{ marginTop: 10 }} data-testid={`debt-group-${group.direction}-${meta.symbol}`}>
			<div className="kv">
				<span className="k">
					{group.direction === 'out' ? 'You owe' : 'Owed to you'} · {meta.symbol}
				</span>
				<span className={`v num ${group.direction === 'out' ? 'st-pending' : 'st-settled'}`}>{formatMoney(group.outstanding, meta.decimals)}</span>
			</div>
			{open.slice(0, 6).map(entry => (
				<div key={entry.debtId} className="kv">
					<span className="k">
						#{entry.currentDebtIndex ?? entry.createdDebtIndex} · {names.get(String(entry.counterparty).toLowerCase()) || shortId(String(entry.counterparty), 8, 4)}
					</span>
					<span className="v num" style={{ fontWeight: 400 }}>
						{formatMoney(entry.remainingAmount, meta.decimals)} of {formatMoney(entry.createdAmount, meta.decimals)}
					</span>
				</div>
			))}
			{group.direction === 'out' && onEnforce && group.outstanding > 0n ? (
				<button type="button" className="btn ghost sm" style={{ marginTop: 8 }} disabled={busy} onClick={onEnforce} data-testid={`debt-enforce-${meta.symbol}`}>
					{busy ? 'Queuing…' : 'Pay down from reserve'}
				</button>
			) : null}
		</div>
	);
}

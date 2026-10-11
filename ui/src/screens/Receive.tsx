import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import QRCode from 'qrcode';
import { buildWalletPayHref, buildXlnInvoiceDeepLink, buildXlnInvoiceUri } from '$lib/utils/xlnInvoice';
import { Bar } from '../components/Bars';
import { CopyId } from '../components/CopyId';
import { Icon } from '../components/Icons';
import { TokenPicker } from '../components/TokenPicker';
import { ReceiveCapacity } from '../components/ReceiveCapacity';
import { useApp } from '../runtime/store';
import { formatMoney, parseAmount } from '../runtime/format';
import { getTokenMeta } from '../runtime/token-meta';
import { usdOf } from '../runtime/financial/prices';
import { useWallet } from '../runtime/views';

/**
 * Same invoice contract as the SvelteKit ReceivePanel: the QR encodes the
 * canonical wallet link, the copy buttons hand out the bare invoice and the
 * xln:// deep link. One builder, imported, never re-implemented.
 */
export function Receive() {
	const navigate = useNavigate();
	const entityId = useApp(s => s.activeEntityId) ?? '';
	const selectedTokenId = useApp(s => s.selectedTokenId);
	const setSelectedTokenId = useApp(s => s.setSelectedTokenId);
	const toast = useApp(s => s.toast);
	const wallet = useWallet(entityId || null);
	const [amount, setAmount] = useState('');
	const [description, setDescription] = useState('');
	const [qr, setQr] = useState<string | null>(null);
	const [accountId, setAccountId] = useState('');
	const meta = getTokenMeta(selectedTokenId);

	const intent = useMemo(
		() => ({ targetEntityId: entityId, tokenId: selectedTokenId, amount: amount.trim(), description: description.trim() }),
		[entityId, selectedTokenId, amount, description],
	);
	const walletHref = useMemo(() => buildWalletPayHref(intent), [intent]);
	const invoice = useMemo(() => buildXlnInvoiceUri(intent), [intent]);
	const deepLink = useMemo(() => buildXlnInvoiceDeepLink(intent), [intent]);

	useEffect(() => {
		let cancelled = false;
		QRCode.toDataURL(walletHref, { errorCorrectionLevel: 'M', margin: 1, width: 480, color: { dark: '#111111', light: '#f6f4ef' } })
			.then(dataUrl => {
				if (!cancelled) setQr(dataUrl);
			})
			.catch(() => {
				if (!cancelled) setQr(null);
			});
		return () => {
			cancelled = true;
		};
	}, [walletHref]);

	const accounts = wallet.accounts.filter(account => !account.disputed);
	const hub = accounts.find(account => account.counterpartyId === accountId) ?? accounts[0];
	const receivable = hub?.tokens.find(token => token.tokenId === selectedTokenId)?.derived.inCapacity ?? 0n;
	const requiredAmount = useMemo(() => {
		try { return parseAmount(amount, meta.decimals); } catch { return 0n; }
	}, [amount, meta.decimals]);

	const copy = async (text: string, label: string): Promise<void> => {
		await navigator.clipboard.writeText(text);
		toast(`${label} copied`);
	};

	return (
		<div className="screen fade-in">
			<div className="screen-header">
				<span className="screen-title">
					<button type="button" className="icon-btn" onClick={() => navigate(-1)} aria-label="Back" data-testid="back">
						<Icon name="chevronLeft" size={18} />
					</button>
					Receive
				</span>
			</div>

			<div className="two-col">
			<div className="stack" style={{ alignItems: 'center' }}>
				{qr && (
					<div className="qr">
						<img src={qr} alt="Invoice QR" />
					</div>
				)}

				<div className="stack" style={{ width: '100%' }}>
					<div className="field">
						<div className="field-head">
							<span>Amount · optional</span>
							<span className="num">{formatMoney(receivable, meta.decimals)} capacity via {hub?.label ?? 'no account'}</span>
						</div>
						<div className="field-row">
							<input className="input big" placeholder="0.00" inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} data-testid="receive-amount" />
							<TokenPicker
								tokenId={selectedTokenId}
								onChange={tokenId => {
									setSelectedTokenId(tokenId);
								}}
							/>
						</div>
						<Bar segments={[{ usd: usdOf(selectedTokenId, receivable), kind: 'coll' }]} height={4} />
					</div>
					{accounts.length > 0 ? <label className="field">Prepare incoming account
						<select className="input" value={hub?.counterpartyId ?? ''} onChange={event => setAccountId(event.target.value)} data-testid="receive-account">
							{accounts.map(account => <option key={account.counterpartyId} value={account.counterpartyId}>{account.label} · {wallet.jurisdiction}</option>)}
						</select>
						<span className="note">Capacity is checked for this account. The sender chooses the final route.</span>
					</label> : null}
					{hub && requiredAmount > 0n ? <ReceiveCapacity account={hub.doc.state}
						ownerEntityId={wallet.entityId} signerId={wallet.signerId} counterpartyEntityId={hub.counterpartyId}
						accountLabel={hub.label} jurisdiction={wallet.jurisdiction} tokenId={selectedTokenId} requiredAmount={requiredAmount}
						disabled={hub.disputed} /> : null}
					<div className="field">
						<span className="field-label">Note · optional</span>
						<input className="input" value={description} onChange={event => setDescription(event.target.value)} placeholder="What is this for?" />
					</div>
				</div>

				{receivable === 0n && requiredAmount <= 0n && (
					<div className="card" style={{ width: '100%', display: 'flex', gap: 12, alignItems: 'flex-start' }}>
						<span style={{ color: 'var(--accent-2)' }}>
							<Icon name="bolt" size={18} />
						</span>
						<div className="note">
							<b style={{ color: 'var(--ink)', fontWeight: 600 }}>Type an amount to get paid.</b> The wallet then asks how much of your hub&apos;s
							promise you accept for it; once you agree, anyone can pay you instantly and the hub passes it along.
							{hub ? (
								<>
									{' '}
									<button type="button" className="btn quiet" onClick={() => navigate(`/accounts/${hub.counterpartyId}`)}>
										Open {hub.label}
									</button>
								</>
							) : null}
						</div>
					</div>
				)}

			</div>

			<div className="aside">
				<div className="card">
					<h3 className="caps">Share</h3>
					<p className="note" style={{ marginTop: 10 }}>
						Send the link or show the code. It opens in any browser with the amount and note filled in; the payer just confirms.
					</p>
					<button type="button" className="btn primary" style={{ marginTop: 14, width: '100%' }} onClick={() => void copy(walletHref, 'Payment link')} data-testid="receive-copy-link">
						<Icon name="link" size={14} /> Copy payment link
					</button>
					<button type="button" className="btn quiet" style={{ marginTop: 8, width: '100%' }} onClick={() => window.print()} data-testid="receive-print" title="The code and the amount on paper, or as a PDF to attach to an invoice">
						Print / PDF
					</button>
					<details style={{ marginTop: 8 }}>
						<summary className="note" style={{ cursor: 'pointer' }}>Other ways to share</summary>
						<div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
							<button type="button" className="btn quiet" style={{ flex: 1 }} onClick={() => void copy(invoice, 'Invoice')} title="The same request as plain text, for a wallet that has no browser">
								Copy as text
							</button>
							<button type="button" className="btn quiet" style={{ flex: 1 }} onClick={() => void copy(deepLink, 'App link')} title="Opens the installed xln app directly">
								Copy app link
							</button>
						</div>
					</details>
				</div>
				<div className="card">
					<h3 className="caps">Your entity id</h3>
					<p style={{ marginTop: 8 }}>
						<CopyId value={entityId} label="Entity id" head={10} tail={6} />
					</p>
					<p className="note" style={{ marginTop: 10 }}>
						Anyone with an account route to you can pay this id directly. Payments arrive instantly up to your inbound room.
					</p>
				</div>
			</div>
			</div>
		</div>
	);
}

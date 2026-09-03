import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import QRCode from 'qrcode';
import { buildWalletPayHref, buildXlnInvoiceDeepLink, buildXlnInvoiceUri } from '$lib/utils/xlnInvoice';
import { Bar } from '../components/Bars';
import { Icon } from '../components/Icons';
import { TokenPicker } from '../components/TokenPicker';
import { useApp } from '../runtime/store';
import { formatMoney, getTokenMeta } from '../runtime/format';
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

	const receivable = wallet.accounts
		.flatMap(account => account.tokens)
		.filter(token => token.tokenId === selectedTokenId)
		.reduce((sum, token) => sum + token.derived.inCapacity, 0n);
	const hub = wallet.accounts.find(account => account.isHub);

	const copy = async (text: string, label: string): Promise<void> => {
		await navigator.clipboard.writeText(text);
		toast(`${label} copied`);
	};

	return (
		<div className="screen screen-narrow fade-in">
			<div className="screen-header">
				<span className="screen-title">
					<button type="button" className="icon-btn" onClick={() => navigate(-1)} aria-label="Back">
						<Icon name="chevronLeft" size={18} />
					</button>
					Receive
				</span>
			</div>

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
							<span className="num">receive up to {formatMoney(receivable, meta.decimals)} instantly</span>
						</div>
						<div className="field-row">
							<input className="input big" placeholder="0.00" inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} />
							<TokenPicker
								tokenId={selectedTokenId}
								onChange={tokenId => {
									setSelectedTokenId(tokenId);
								}}
							/>
						</div>
						<Bar segments={[{ usd: usdOf(selectedTokenId, receivable), kind: 'credit' }]} height={4} />
					</div>
					<div className="field">
						<span className="field-label">Note · optional</span>
						<input className="input" value={description} onChange={event => setDescription(event.target.value)} placeholder="What is this for?" />
					</div>
				</div>

				{receivable === 0n && (
					<div className="card" style={{ width: '100%', display: 'flex', gap: 12, alignItems: 'flex-start' }}>
						<span style={{ color: 'var(--accent-2)' }}>
							<Icon name="bolt" size={18} />
						</span>
						<div className="note">
							<b style={{ color: 'var(--ink)', fontWeight: 600 }}>No inbound room yet.</b> Extend a credit line to a hub and it can pay you instantly, no
							pre-funding.
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

				<div style={{ width: '100%' }}>
					<span className="caps" style={{ display: 'block', marginBottom: 6 }}>
						Your entity id
					</span>
					<p className="hash">{entityId}</p>
				</div>

				<div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, width: '100%' }}>
					<button type="button" className="btn ghost" onClick={() => void copy(invoice, 'Invoice')}>
						<Icon name="copy" size={14} /> Copy invoice
					</button>
					<button type="button" className="btn" onClick={() => void copy(walletHref, 'Payment link')}>
						<Icon name="link" size={14} /> Copy link
					</button>
				</div>
				<button type="button" className="btn quiet" onClick={() => void copy(deepLink, 'App link')}>
					Copy xln:// app link
				</button>
			</div>
		</div>
	);
}

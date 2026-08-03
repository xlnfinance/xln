import { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import { useApp } from '../runtime/store';
import { getTokenMeta, shortId } from '../runtime/format';
import { Icon } from '../components/Icons';

export function Receive() {
	const entityId = useApp(s => s.activeEntityId) ?? '';
	const selectedTokenId = useApp(s => s.selectedTokenId);
	const toast = useApp(s => s.toast);
	const [amount, setAmount] = useState('');
	const [description, setDescription] = useState('');
	const [qr, setQr] = useState<string | null>(null);
	const meta = getTokenMeta(selectedTokenId);

	const link = useMemo(() => {
		const url = new URL('/pay', window.location.origin);
		url.searchParams.set('to', entityId);
		if (amount.trim()) url.searchParams.set('amount', amount.trim());
		url.searchParams.set('token', String(selectedTokenId));
		if (description.trim()) url.searchParams.set('desc', description.trim());
		return url.toString();
	}, [entityId, amount, selectedTokenId, description]);

	useEffect(() => {
		let cancelled = false;
		QRCode.toDataURL(link, { margin: 1, width: 480, color: { dark: '#111111', light: '#f6f4ef' } })
			.then(dataUrl => {
				if (!cancelled) setQr(dataUrl);
			})
			.catch(() => {
				if (!cancelled) setQr(null);
			});
		return () => {
			cancelled = true;
		};
	}, [link]);

	const copy = async (text: string, label: string): Promise<void> => {
		await navigator.clipboard.writeText(text);
		toast(`${label} copied`);
	};

	return (
		<div className="screen screen-narrow fade-in">
			<div className="screen-header">
				<span className="screen-title">Request</span>
			</div>

			<div style={{ display: 'flex', flexDirection: 'column', gap: 22, alignItems: 'center' }}>
				{qr && (
					<div className="glass" style={{ padding: 18, borderRadius: 24 }}>
						<img src={qr} alt="Invoice QR" style={{ display: 'block', width: 232, height: 232, borderRadius: 12 }} />
					</div>
				)}

				<div style={{ display: 'flex', flexDirection: 'column', gap: 16, width: '100%' }}>
					<div className="field">
						<span className="field-label">Amount · optional</span>
						<div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
							<input
								className="input display"
								style={{ fontSize: 26, fontWeight: 300 }}
								placeholder="0.00"
								inputMode="decimal"
								value={amount}
								onChange={e => setAmount(e.target.value)}
							/>
							<span className="muted">{meta.symbol}</span>
						</div>
					</div>
					<div className="field">
						<span className="field-label">Note · optional</span>
						<input className="input" value={description} onChange={e => setDescription(e.target.value)} placeholder="What is this for?" />
					</div>
				</div>

				<div style={{ display: 'flex', gap: 10, width: '100%' }}>
					<button type="button" className="btn btn-ghost" style={{ flex: 1 }} onClick={() => void copy(entityId, 'Entity id')}>
						<Icon name="copy" size={14} /> {shortId(entityId)}
					</button>
					<button type="button" className="btn btn-primary" style={{ flex: 1 }} onClick={() => void copy(link, 'Invoice link')}>
						<Icon name="copy" size={14} /> Copy invoice
					</button>
				</div>
			</div>
		</div>
	);
}

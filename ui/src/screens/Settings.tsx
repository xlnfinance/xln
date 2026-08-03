import { useState } from 'react';
import { Sheet } from '../components/Sheet';
import { Icon } from '../components/Icons';
import { useApp } from '../runtime/store';
import { disconnectAdapter, getAdapter } from '../runtime/adapter';
import { shortId } from '../runtime/format';

export function SettingsScreen() {
	const theme = useApp(s => s.theme);
	const setTheme = useApp(s => s.setTheme);
	const vaults = useApp(s => s.vaults);
	const activeVaultId = useApp(s => s.activeVaultId);
	const sessionSeeds = useApp(s => s.sessionSeeds);
	const lockAll = useApp(s => s.lockAll);
	const removeVault = useApp(s => s.removeVault);
	const height = useApp(s => s.height);
	const toast = useApp(s => s.toast);
	const [revealing, setRevealing] = useState(false);

	const adapter = getAdapter();
	const activeVault = vaults.find(v => v.id === activeVaultId) ?? null;
	const seed = activeVaultId ? sessionSeeds[activeVaultId] : undefined;

	const lock = (): void => {
		lockAll();
		disconnectAdapter();
	};

	return (
		<div className="screen fade-in" style={{ maxWidth: 620 }}>
			<div className="screen-header">
				<span className="screen-title">Settings</span>
			</div>

			<div className="section-head" style={{ marginTop: 0 }}>
				<span className="caps">Appearance</span>
			</div>
			<div className="row">
				<span style={{ fontSize: 13.5 }}>Theme</span>
				<span className="token-switch">
					<button type="button" className={theme === 'dark' ? 'active' : ''} onClick={() => setTheme('dark')}>
						<Icon name="moon" size={13} /> Dark
					</button>
					<button type="button" className={theme === 'light' ? 'active' : ''} onClick={() => setTheme('light')}>
						<Icon name="sun" size={13} /> Light
					</button>
				</span>
			</div>

			<div className="section-head">
				<span className="caps">Runtime</span>
			</div>
			<div className="row">
				<span className="muted" style={{ fontSize: 13 }}>
					Mode
				</span>
				<span style={{ fontSize: 13 }}>{adapter?.mode ?? '—'}</span>
			</div>
			<div className="row">
				<span className="muted" style={{ fontSize: 13 }}>
					Runtime id
				</span>
				<span className="mono">{adapter ? shortId(adapter.runtimeId, 10, 6) : '—'}</span>
			</div>
			<div className="row">
				<span className="muted" style={{ fontSize: 13 }}>
					Frame
				</span>
				<span className="mono">#{height.toLocaleString('en-US')}</span>
			</div>

			<div className="section-head">
				<span className="caps">Vault</span>
			</div>
			<div className="row">
				<span style={{ fontSize: 13.5 }}>{activeVault?.name ?? '—'}</span>
				<span className="faint" style={{ fontSize: 12 }}>
					{activeVault?.kind ?? ''}
				</span>
			</div>

			<div style={{ display: 'flex', gap: 10, marginTop: 26, flexWrap: 'wrap' }}>
				{seed && (
					<button type="button" className="btn btn-ghost" onClick={() => setRevealing(true)}>
						Reveal recovery phrase
					</button>
				)}
				<button type="button" className="btn btn-ghost" onClick={lock}>
					<Icon name="lock" size={14} /> Lock
				</button>
				{activeVault && activeVault.kind !== 'sandbox' && (
					<button
						type="button"
						className="btn btn-danger"
						onClick={() => {
							removeVault(activeVault.id);
							lock();
							toast('Vault forgotten on this device. The name and passphrase still recover it anywhere.');
						}}
					>
						Forget vault
					</button>
				)}
			</div>

			{revealing && seed && (
				<Sheet title="Recovery phrase" onClose={() => setRevealing(false)}>
					<p className="muted" style={{ fontSize: 13 }}>
						Anyone with these words controls the money. Read them in private.
					</p>
					<p className="mono" style={{ fontSize: 14, lineHeight: 1.9, userSelect: 'all' }}>
						{seed}
					</p>
					<button
						type="button"
						className="btn btn-ghost btn-block"
						onClick={() => {
							void navigator.clipboard.writeText(seed).then(() => toast('Copied — clear your clipboard after use'));
						}}
					>
						<Icon name="copy" size={14} /> Copy
					</button>
				</Sheet>
			)}
		</div>
	);
}

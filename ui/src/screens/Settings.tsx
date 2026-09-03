import { useState } from 'react';
import { Sheet } from '../components/Sheet';
import { Bar } from '../components/Bars';
import { Icon } from '../components/Icons';
import { clampUsdPerPx, USD_PER_PX_MAX, USD_PER_PX_MIN, useApp, type PlaceKey } from '../runtime/store';
import { disconnectAdapter, getAdapter } from '../runtime/adapter';

const PRESETS = [1, 2, 5, 10, 25, 100, 1000];
const LOG_MIN = Math.log10(USD_PER_PX_MIN);
const LOG_MAX = Math.log10(USD_PER_PX_MAX);

const sliderToUsd = (value: number): number => clampUsdPerPx(Math.pow(10, LOG_MIN + ((LOG_MAX - LOG_MIN) * value) / 1000));
const usdToSlider = (usd: number): number => Math.round(((Math.log10(usd) - LOG_MIN) / (LOG_MAX - LOG_MIN)) * 1000);
const roundUsd = (usd: number): number => (usd >= 10 ? Math.round(usd) : Math.round(usd * 10) / 10);

const PLACES: Array<{ key: PlaceKey; title: string; detail: string }> = [
	{ key: 'onchain', title: 'On-chain wallet', detail: 'Tokens held by your signer on the chain itself. Slow, fully yours.' },
	{ key: 'reserve', title: 'Reserve', detail: 'Escrowed in the Depository. Enforceable on-chain, funds collateral.' },
	{ key: 'accounts', title: 'Accounts', detail: 'Bilateral credit and collateral with hubs and people. Instant.' },
];

const PREVIEW_AMOUNTS = [100, 1_000, 10_000, 100_000];

/** The scale, shown as money: the same bar the whole wallet draws. */
function ScalePreview({ usdPerPx }: { usdPerPx: number }) {
	return (
		<div className="card">
			<h3 className="caps">At this scale</h3>
			{PREVIEW_AMOUNTS.map(amount => (
				<div key={amount} style={{ marginTop: 12 }}>
					<div className="kv" style={{ padding: '0 0 6px', border: 0 }}>
						<span className="k">${amount.toLocaleString('en-US')}</span>
						<span className="v num" style={{ color: 'var(--ink-3)' }}>
							{Math.max(1, Math.round(amount / usdPerPx)).toLocaleString('en-US')} px
						</span>
					</div>
					<Bar segments={[{ usd: amount, kind: 'credit' }]} height={6} />
				</div>
			))}
			<p className="note" style={{ marginTop: 14 }}>
				A bar wider than its card fades out at the edge. Lower the scale to fit big balances, raise it to see small payments.
			</p>
		</div>
	);
}

export function SettingsScreen() {
	const theme = useApp(s => s.theme);
	const setTheme = useApp(s => s.setTheme);
	const usdPerPx = useApp(s => s.usdPerPx);
	const setUsdPerPx = useApp(s => s.setUsdPerPx);
	const scaleMode = useApp(s => s.scaleMode);
	const setScaleMode = useApp(s => s.setScaleMode);
	const places = useApp(s => s.places);
	const setPlaceVisible = useApp(s => s.setPlaceVisible);
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
		<div className="screen fade-in">
			<div className="screen-header">
				<span className="screen-title">Settings</span>
			</div>

			<div className="two-col">
			<div>
			<div className="sect" style={{ marginTop: 0 }}>
				<h3 className="caps">Scale</h3>
				<span className="more num">1 px = ${roundUsd(usdPerPx)}</span>
			</div>
			<div className="setting first" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 12 }}>
				<div>
					<div className="t">Dollars per pixel</div>
					<div className="s">
						Every bar in the wallet is drawn to this one scale, so amounts stay comparable at a glance.
						{scaleMode === 'auto' ? ' Auto follows your largest balance; pick a value to pin it.' : ' Pinned; choose Auto to follow your largest balance.'}
					</div>
				</div>
				<div className="scale-row">
					<input
						type="range"
						min={0}
						max={1000}
						value={usdToSlider(usdPerPx)}
						onChange={event => setUsdPerPx(roundUsd(sliderToUsd(Number(event.target.value))))}
						aria-label="Dollars per pixel"
					/>
					<output className="num">1 px = ${roundUsd(usdPerPx)}</output>
				</div>
				<div className="chips">
					<button type="button" className={scaleMode === 'auto' ? 'active' : ''} onClick={() => setScaleMode('auto')} title="Fit the largest bar on Home to the track">
						Auto
					</button>
					{PRESETS.map(value => (
						<button key={value} type="button" className={scaleMode === 'fixed' && usdPerPx === value ? 'active' : ''} onClick={() => setUsdPerPx(value)}>
							${value}
						</button>
					))}
				</div>
			</div>

			<div className="sect">
				<h3 className="caps">Home</h3>
			</div>
			{PLACES.map((place, index) => (
				<div key={place.key} className={`setting${index === 0 ? ' first' : ''}`}>
					<div>
						<div className="t">{place.title}</div>
						<div className="s">{place.detail}</div>
					</div>
					<button
						type="button"
						className={`switch${places[place.key] ? ' on' : ''}`}
						role="switch"
						aria-checked={places[place.key]}
						aria-label={`Show ${place.title}`}
						onClick={() => setPlaceVisible(place.key, !places[place.key])}
					/>
				</div>
			))}

			<div className="sect">
				<h3 className="caps">Appearance</h3>
			</div>
			<div className="setting first">
				<div className="t">Theme</div>
				<span className="segc">
					<button type="button" className={theme === 'dark' ? 'active' : ''} onClick={() => setTheme('dark')}>
						<Icon name="moon" size={13} /> Dark
					</button>
					<button type="button" className={theme === 'light' ? 'active' : ''} onClick={() => setTheme('light')}>
						<Icon name="sun" size={13} /> Light
					</button>
				</span>
			</div>

			<div className="sect">
				<h3 className="caps">Runtime</h3>
			</div>
			<div className="setting first">
				<div className="t">Mode</div>
				<span className="muted">{adapter?.mode ?? '—'}</span>
			</div>
			<div className="setting" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
				<div className="t">Runtime id</div>
				<span className="hash">{adapter ? adapter.runtimeId : '—'}</span>
			</div>
			<div className="setting">
				<div className="t">Frame</div>
				<span className="mono muted">#{height.toLocaleString('en-US')}</span>
			</div>

			<div className="sect">
				<h3 className="caps">Vault</h3>
			</div>
			<div className="setting first">
				<div>
					<div className="t">{activeVault?.name ?? '—'}</div>
					<div className="s">{activeVault?.kind ?? ''}</div>
				</div>
			</div>
			<div style={{ display: 'flex', gap: 10, marginTop: 18, flexWrap: 'wrap' }}>
				{seed && (
					<button type="button" className="btn ghost sm" onClick={() => setRevealing(true)}>
						<Icon name="eye" size={14} /> Reveal recovery phrase
					</button>
				)}
				<button type="button" className="btn ghost sm" onClick={lock}>
					<Icon name="lock" size={14} /> Lock
				</button>
				{activeVault && activeVault.kind !== 'sandbox' && (
					<button
						type="button"
						className="btn danger sm"
						onClick={() => {
							removeVault(activeVault.id);
							lock();
							toast('Vault forgotten on this device. The name and passphrase still recover it anywhere.');
						}}
					>
						<Icon name="trash" size={14} /> Forget vault
					</button>
				)}
			</div>

			{revealing && seed && (
				<Sheet title="Recovery phrase" onClose={() => setRevealing(false)}>
					<p className="note">Anyone with these words controls the money. Read them in private.</p>
					<p className="mono" style={{ fontSize: 14, lineHeight: 1.9, userSelect: 'all' }}>
						{seed}
					</p>
					<button
						type="button"
						className="btn ghost"
						onClick={() => {
							void navigator.clipboard.writeText(seed).then(() => toast('Copied. Clear your clipboard after use.'));
						}}
					>
						<Icon name="copy" size={14} /> Copy
					</button>
				</Sheet>
			)}
			</div>
			<div className="aside">
				<ScalePreview usdPerPx={usdPerPx} />
			</div>
			</div>
		</div>
	);
}

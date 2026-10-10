import { useNavigate } from 'react-router-dom';
import { explainWalletError } from '@xln/frontend/lib/utils/ui/walletError';
import { PasswordEntry } from '../components/PasswordEntry';
import { hasPasswordVault, savePasswordVault } from '../../../frontend/src/lib/security/passwordVault';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../components/Icons';
import { Logo } from '../components/Logo';
import { GateWelcome } from '../components/GateWelcome';
import { RestoreChoice } from '../components/RestoreChoice';
import { discoverTowerRestore } from '../runtime/restore';
import { defaultTowerUrl, normalizeTowerUrl, saveRecovery } from '../runtime/recovery';
import { useApp } from '../runtime/store';
import { bootHostedVault, bootLearnVault, detectStack, type Stack } from '../runtime/hosted';
import {
	FACTOR_PRESETS,
	customWork,
	deriveBrainvaultMnemonic,
	type BrainvaultProgress,
	type BrainvaultWork,
} from '../runtime/brainvault';
import { isValidMnemonic, runtimeIdForSeed } from '../runtime/keys';
import { connectRemote, requireAdapter } from '../runtime/adapter';
import type { RuntimeAdapterEntitySummary } from '@xln/core/api/public/runtime-module';

type GateMode = 'landing' | 'create' | 'import' | 'remote';

export function Gate() {
	const navigate = useNavigate();
	const [mode, setMode] = useState<GateMode>('landing');
	const [passwordEntry, setPasswordEntry] = useState<{ id: string; name: string; seed?: string; open: (seed: string) => Promise<void> } | null>(null);

	/** The xln stack serving this page (local orchestrator or xln.finance); null on a static host. */
	const [stack, setStack] = useState<Stack | null | undefined>(undefined);
	useEffect(() => {
		let alive = true;
		void detectStack().then(found => {
			if (alive) setStack(found);
		});
		return () => {
			alive = false;
		};
	}, []);
	const [busyStep, setBusyStep] = useState<string | null>(null);
	const [progress, setProgress] = useState<BrainvaultProgress | null>(null);
	const [error, setError] = useState<string | null>(null);
	const toast = useApp(s => s.toast);

	const [name, setName] = useState('');
	const [passphrase, setPassphrase] = useState('');
	const [factor, setFactor] = useState(3);
	const [customShards, setCustomShards] = useState('');
	const [phrase, setPhrase] = useState('');
	const [restore, setRestore] = useState(false);
	const [towerUrl, setTowerUrl] = useState(defaultTowerUrl);
	const [backupEnabled, setBackupEnabled] = useState(() => Boolean(defaultTowerUrl()));
	const [wsUrl, setWsUrl] = useState('wss://xln.finance/rpc');
	const [authKey, setAuthKey] = useState('');
	const [remoteEntities, setRemoteEntities] = useState<RuntimeAdapterEntitySummary[] | null>(null);
	const deriveAbort = useRef<AbortController | null>(null);

	const work: BrainvaultWork | null = useMemo(() => {
		const custom = customShards.trim();
		if (custom) {
			try {
				return customWork(Number(custom));
			} catch {
				return null;
			}
		}
		return FACTOR_PRESETS.find(p => p.factor === factor) ?? null;
	}, [factor, customShards]);

	const run = async (work: () => Promise<void>): Promise<void> => {
		setError(null);
		try {
			await work();
		} catch (workError) {
			const message = workError instanceof Error ? workError.message : String(workError);
			setError(message);
			setBusyStep(null);
			setProgress(null);
		}
	};

	const recoveryFor = async (seed: string) => {
		if (!restore) return undefined;
		setBusyStep('Finding and verifying your encrypted backup');
		return discoverTowerRestore(seed, towerUrl);
	};
	const rememberTower = (vaultId: string): void => {
		if (restore || backupEnabled) saveRecovery(vaultId, { mode: 'tower', towers: [normalizeTowerUrl(towerUrl)] });
	};

	const NO_STACK = 'No xln network answers at this address. Open the wallet from a running stack (bun run dev, or xln.finance/ui).';

	/** A throwaway wallet on the live network, with the guided tour open from step one. */
	const learn = (): void => {
		void run(async () => {
			if (!stack) throw new Error(NO_STACK);
			await bootLearnVault(stack, step => setBusyStep(step));
			navigate('/', { replace: true });
			useApp.getState().setTour({ active: true, index: 0 });
		});
	};

	const createVault = (): void => {
		if (!work) return;
		void run(async () => {
			if (backupEnabled || restore) normalizeTowerUrl(towerUrl);
			setBusyStep('Deriving your vault');
			deriveAbort.current = new AbortController();
			let result;
			try {
				result = await deriveBrainvaultMnemonic(name.trim(), passphrase, work, p => setProgress(p), deriveAbort.current.signal);
			} catch (deriveError) {
				if (deriveError instanceof Error && deriveError.message === 'BRAINVAULT_ABORTED') {
					setBusyStep(null);
					setProgress(null);
					return;
				}
				throw deriveError;
			} finally {
				deriveAbort.current = null;
			}
			setProgress(null);
			const vaultId = runtimeIdForSeed(result.mnemonic).toLowerCase();
			const vaultOptions = { vaultId, vaultName: name.trim(), kind: 'brainvault' as const, selfLabel: name.trim(), onStep: (step: string) => setBusyStep(step) };
			if (!stack) throw new Error(NO_STACK);
			const recovery = await recoveryFor(result.mnemonic);
			await savePasswordVault(vaultId, result.mnemonic, passphrase);
			setPassphrase('');
			await bootHostedVault(result.mnemonic, { ...vaultOptions, stack, ...(recovery ? { recovery } : {}) });
			rememberTower(vaultId);
			toast(recovery ? 'Verified backup restored.' : 'Wallet opened.');
			setBusyStep(null);
		});
	};

	const importPhrase = (): void => {
		void run(async () => {
			const seed = phrase.trim().toLowerCase().replace(/\s+/g, ' ');
			if (!isValidMnemonic(seed)) throw new Error('That is not a valid BIP39 phrase');
			const vaultId = runtimeIdForSeed(seed).toLowerCase();
			const vaultOptions = { vaultId, vaultName: 'Imported vault', kind: 'mnemonic' as const, selfLabel: 'Main', onStep: (step: string) => setBusyStep(step) };
			if (!stack) throw new Error(NO_STACK);
			const recovery = await recoveryFor(seed);
			setPhrase('');
			setPasswordEntry({ id: vaultId, name: vaultOptions.vaultName, seed, open: async unlocked => {
				await bootHostedVault(unlocked, { ...vaultOptions, stack, ...(recovery ? { recovery } : {}) });
				rememberTower(vaultId);
			} });
			setBusyStep(null);
		});
	};

	const connectRemoteRuntime = (entityId?: string): void => {
		void run(async () => {
			setBusyStep('Connecting to runtime');
			await connectRemote(wsUrl.trim(), authKey.trim() || undefined);
			// Connecting is not opening a wallet: the app stays on this screen until
			// an entity is chosen, so a runtime that offers none has to say so.
			setBusyStep('Reading the entities it serves');
			const summaries = await requireAdapter().read<RuntimeAdapterEntitySummary[]>('entities');
			if (!summaries.length) throw new Error('That runtime serves no entity this key can open.');
			const chosen = entityId ? summaries.find(entry => entry.entityId === entityId) : summaries[0];
			if (summaries.length > 1 && !entityId) {
				setRemoteEntities(summaries);
				setBusyStep(null);
				return;
			}
			if (!chosen) throw new Error('That entity is no longer served by this runtime.');
			const app = useApp.getState();
			app.setActiveEntityId(chosen.entityId);
			const vaultId = `remote:${wsUrl.trim()}:${chosen.entityId}`;
			if (!app.vaults.some(entry => entry.id === vaultId)) {
				app.addVault({
					id: vaultId,
					name: chosen.label || 'Remote runtime',
					kind: 'remote',
					createdAt: Date.now(),
					remote: { wsUrl: wsUrl.trim() },
				});
			}
			app.setActiveVault(vaultId);
			setRemoteEntities(null);
			setBusyStep(null);
		});
	};

	const unlockVault = (vault: import('../runtime/store').VaultMeta): void => {
		if (vault.kind === 'remote') {
			// A remote runtime holds the keys; asking this person for a seed phrase
			// they never had is the wrong question. Reopen the endpoint instead.
			if (vault.remote?.wsUrl) setWsUrl(vault.remote.wsUrl);
			setMode('remote');
			return;
		}
		if (hasPasswordVault(vault.id)) {
			setPasswordEntry({ id: vault.id, name: vault.name, open: async seed => {
				if (!stack) throw new Error(NO_STACK);
				if (runtimeIdForSeed(seed).toLowerCase() !== vault.id.toLowerCase()) throw new Error('Wallet identity mismatch.');
				await bootHostedVault(seed, { vaultId: vault.id, vaultName: vault.name, kind: vault.kind, selfLabel: vault.name, stack, onStep: setBusyStep });
			} });
			return;
		}
		if (vault.kind === 'brainvault') {
			setName(vault.name);
			setMode('create');
			return;
		}
		setMode('import');
	};

	if (passwordEntry) return <PasswordEntry {...passwordEntry} status={busyStep} onOpen={passwordEntry.open} onBack={() => setPasswordEntry(null)} />;

	if (busyStep) {
		const etaSeconds =
			progress && progress.completed > 0
				? Math.max(0, Math.round(((progress.elapsedMs / progress.completed) * (progress.total - progress.completed)) / 1000))
				: null;
		return (
			<div className="gate" data-testid="gate-busy">
				<GateMark />
				<div className="gate-busy fade-in">
					<p className="caps">{busyStep}</p>
					{progress ? (
						<>
							<div className="gate-progress">
								<span style={{ width: `${Math.round((progress.completed / Math.max(1, progress.total)) * 100)}%` }} />
							</div>
							<p className="faint" style={{ fontSize: 12 }}>
								Shard {progress.completed.toLocaleString('en-US')} of {progress.total.toLocaleString('en-US')} ·{' '}
								{(progress.elapsedMs / 1000).toFixed(0)}s elapsed
								{etaSeconds !== null ? ` · ~${etaSeconds >= 90 ? `${Math.round(etaSeconds / 60)} min` : `${etaSeconds}s`} left` : ''}
							</p>
							<button
								type="button"
								className="btn ghost sm"
								onClick={() => {
									deriveAbort.current?.abort();
								}}
							>
								Cancel
							</button>
						</>
					) : (
						<div className="gate-progress gate-progress-indeterminate">
							<span />
						</div>
					)}
				</div>
			</div>
		);
	}

	return (
		<div className="gate">
			<GateMark />
			<h1 className="gate-title">xln</h1>
			<p className="gate-sub muted">Payments and swaps, under your control.</p>
			<p className="gate-stack muted" data-testid="gate-stack" data-state={stack === undefined ? 'probing' : stack ? 'online' : 'offline'}>
				{stack === undefined
					? 'Looking for a network at this address…'
					: stack
						? `${stack.jurisdiction.name} · Connected`
						: 'No xln network at this address. Open the wallet from a running stack.'}
			</p>

			{error ? (
				<p className="gate-error" role="alert">
					{explainWalletError(error)}
				</p>
			) : null}

			{mode === 'landing' && <GateWelcome onMode={setMode} onUnlock={unlockVault} onLearn={learn} networkReady={Boolean(stack)} />}

			{mode === 'create' && (
				<form
					className="gate-form fade-in"
					onSubmit={event => {
						event.preventDefault();
						createVault();
					}}
				>
					<label className="field">
						<span className="field-label">Vault name</span>
						<input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="alice" autoFocus />
					</label>
					<label className="field">
						<span className="field-label">Passphrase</span>
						<input className="input" type="password" value={passphrase} onChange={e => setPassphrase(e.target.value)} placeholder="Long and memorable" />
					</label>
					<div className="field">
						<span className="field-label">Security work factor</span>
						<div className="gate-factors">
							{FACTOR_PRESETS.map(preset => {
								const active = !customShards.trim() && preset.factor === factor;
								return (
									<button
										key={preset.factor}
										type="button"
										className={`gate-factor${active ? ' active' : ''}`}
										onClick={() => {
											setFactor(preset.factor);
											setCustomShards('');
										}}
									>
										<span className="gate-factor-tier">{preset.tier}</span>
										<span className="gate-factor-shards">
											{preset.shardCount.toLocaleString('en-US')} {preset.shardCount === 1 ? 'shard' : 'shards'}
										</span>
									</button>
								);
							})}
						</div>
						<div className="field-row">
							<input
								className="input num"
								style={{ maxWidth: 200 }}
								placeholder="custom shards · 6+"
								inputMode="numeric"
								value={customShards}
								onChange={e => setCustomShards(e.target.value.replace(/[^\d]/g, ''))}
							/>
							<span className="faint" style={{ fontSize: 12 }}>
								{work ? `${work.tier} · ${work.shardCount.toLocaleString('en-US')} shards · factor ${work.factor}` : 'At least 6 shards'}
							</span>
						</div>
						<span className="note">
							Each shard is one unit of Argon2 memory-hard work. The same name, passphrase, and work reopen this vault on any device.
						</span>
					</div>
					<details className="disclosure">
						<summary>Backup and dispute protection · {backupEnabled ? 'encrypted backups' : 'local only'}</summary>
						<label className="field"><span><input type="checkbox" checked={backupEnabled} onChange={event => setBackupEnabled(event.target.checked)} /> Automatically back up this wallet</span></label>
						{backupEnabled && <label className="field"><span className="field-label">Backup tower</span><input className="input" value={towerUrl} onChange={event => setTowerUrl(event.target.value)} placeholder="https://tower.example.com" /></label>}
						<p className="note">Backups are encrypted before leaving your device and update while the wallet is open. Your exact name, passphrase and work factor recover the keys; the backup recovers the latest signed wallet state. Older activity remains on the original device.</p>
						<p className="note">Dispute protection is offered on the home screen after your first account is signed. Check the tower’s response status; storing a backup does not mean it will answer disputes.</p>
						{!defaultTowerUrl() && <p className="note">This local testnet has no default tower. Add a running local service to enable backups.</p>}
					</details>
					<RestoreChoice enabled={restore} address={towerUrl} onToggle={setRestore} onAddress={setTowerUrl} />
					<div className="gate-form-actions">
						<button type="button" className="btn quiet" onClick={() => setMode('landing')}>
							Back
						</button>
						<button type="submit" className="btn" disabled={name.trim().length < 2 || passphrase.length < 8 || !work}>
							{restore ? 'Derive and restore' : 'Derive vault'}
						</button>
					</div>
				</form>
			)}

			{mode === 'import' && (
				<form
					className="gate-form fade-in"
					onSubmit={event => {
						event.preventDefault();
						importPhrase();
					}}
				>
					<label className="field">
						<span className="field-label">Recovery phrase</span>
						<textarea className="input boxed" rows={3} value={phrase} onChange={e => setPhrase(e.target.value)} placeholder="words separated by spaces" autoFocus />
					</label>
					<RestoreChoice enabled={restore} address={towerUrl} onToggle={setRestore} onAddress={setTowerUrl} />
					<div className="gate-form-actions">
						<button type="button" className="btn quiet" onClick={() => setMode('landing')}>
							Back
						</button>
						<button type="submit" className="btn" disabled={phrase.trim().split(/\s+/).length < 12}>
							{restore ? 'Restore wallet' : 'Unlock'}
						</button>
					</div>
				</form>
			)}

			{mode === 'remote' && remoteEntities && (
				<div className="gate-cards fade-in">
					<p className="muted">That runtime serves more than one entity. Pick the one to open.</p>
					{remoteEntities.map(entry => (
						<button
							key={entry.entityId}
							type="button"
							className="gate-card"
							onClick={() => connectRemoteRuntime(entry.entityId)}
						>
							<span className="gate-card-icon">
								<Icon name="bank" size={18} />
							</span>
							<span>
								<span className="gate-card-title">{entry.label || entry.entityId.slice(0, 10)}</span>
								<span className="gate-card-sub muted mono">{entry.entityId.slice(0, 18)}…</span>
							</span>
							<Icon name="chevronRight" size={16} />
						</button>
					))}
					<button type="button" className="btn quiet" onClick={() => setRemoteEntities(null)}>
						Back
					</button>
				</div>
			)}

			{mode === 'remote' && !remoteEntities && (
				<form
					className="gate-form fade-in"
					onSubmit={event => {
						event.preventDefault();
						connectRemoteRuntime();
					}}
				>
					<label className="field">
						<span className="field-label">Runtime endpoint</span>
						<input className="input mono" value={wsUrl} onChange={e => setWsUrl(e.target.value)} autoFocus />
					</label>
					<label className="field">
						<span className="field-label">Access key · optional</span>
						<input className="input mono" type="password" value={authKey} onChange={e => setAuthKey(e.target.value)} />
					</label>
					<div className="gate-form-actions">
						<button type="button" className="btn quiet" onClick={() => setMode('landing')}>
							Back
						</button>
						<button type="submit" className="btn" disabled={!wsUrl.trim()}>
							Connect
						</button>
					</div>
				</form>
			)}
		</div>
	);
}

function GateMark() {
	return (
		<div className="rail-mark gate-mark" aria-hidden>
			<Logo size={26} />
		</div>
	);
}

import { useState } from 'react';
import { Icon } from '../components/Icons';
import { useApp } from '../runtime/store';
import { bootEmbeddedDemo, connectSandbox } from '../runtime/sandbox';
import { deriveBrainvaultMnemonic, type BrainvaultProgress } from '../runtime/brainvault';
import { isValidMnemonic, runtimeIdForSeed } from '../runtime/keys';
import { connectRemote } from '../runtime/adapter';

type GateMode = 'landing' | 'create' | 'import' | 'remote';

export function Gate() {
	const [mode, setMode] = useState<GateMode>('landing');
	const [busyStep, setBusyStep] = useState<string | null>(null);
	const [progress, setProgress] = useState<BrainvaultProgress | null>(null);
	const [error, setError] = useState<string | null>(null);
	const vaults = useApp(s => s.vaults);
	const toast = useApp(s => s.toast);

	const [name, setName] = useState('');
	const [passphrase, setPassphrase] = useState('');
	const [factor, setFactor] = useState(1);
	const [phrase, setPhrase] = useState('');
	const [wsUrl, setWsUrl] = useState('wss://xln.finance/rpc');
	const [authKey, setAuthKey] = useState('');

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

	const enterSandbox = (): void => {
		void run(async () => {
			await connectSandbox(step => setBusyStep(step));
		});
	};

	const createVault = (): void => {
		void run(async () => {
			setBusyStep('Deriving your vault');
			const result = await deriveBrainvaultMnemonic(name.trim(), passphrase, factor, p => setProgress(p));
			setProgress(null);
			const vaultId = runtimeIdForSeed(result.mnemonic).toLowerCase();
			await bootEmbeddedDemo(result.mnemonic, {
				vaultId,
				vaultName: name.trim(),
				kind: 'brainvault',
				selfLabel: name.trim(),
				onStep: step => setBusyStep(step),
			});
			toast('Vault created — write nothing down, your name and passphrase are the backup');
		});
	};

	const importPhrase = (): void => {
		void run(async () => {
			const seed = phrase.trim().toLowerCase().replace(/\s+/g, ' ');
			if (!isValidMnemonic(seed)) throw new Error('That is not a valid BIP39 phrase');
			const vaultId = runtimeIdForSeed(seed).toLowerCase();
			await bootEmbeddedDemo(seed, {
				vaultId,
				vaultName: 'Imported vault',
				kind: 'mnemonic',
				selfLabel: 'Main',
				onStep: step => setBusyStep(step),
			});
		});
	};

	const connectRemoteRuntime = (): void => {
		void run(async () => {
			setBusyStep('Connecting to runtime');
			await connectRemote(wsUrl.trim(), authKey.trim() || undefined);
			setBusyStep(null);
		});
	};

	const unlockVault = (vaultId: string, kind: string): void => {
		if (kind === 'sandbox') return enterSandbox();
		if (kind === 'brainvault') {
			setMode('create');
			return;
		}
		setMode('import');
	};

	if (busyStep) {
		return (
			<div className="gate">
				<GateMark />
				<div className="gate-busy fade-in">
					<p className="caps">{busyStep}</p>
					{progress ? (
						<>
							<div className="gate-progress">
								<span style={{ width: `${Math.round((progress.completed / Math.max(1, progress.total)) * 100)}%` }} />
							</div>
							<p className="faint" style={{ fontSize: 12 }}>
								Shard {progress.completed} of {progress.total} · {(progress.elapsedMs / 1000).toFixed(0)}s
							</p>
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
			<h1 className="gate-title display">Sovereign asset terminal</h1>
			<p className="gate-sub muted">Your runtime. Your proofs. Your money.</p>

			{error ? (
				<p className="gate-error" role="alert">
					{error}
				</p>
			) : null}

			{mode === 'landing' && (
				<div className="gate-cards fade-in">
					{vaults.map(vault => (
						<button key={vault.id} type="button" className="glass gate-card" onClick={() => unlockVault(vault.id, vault.kind)}>
							<span className="gate-card-icon">
								<Icon name={vault.kind === 'remote' ? 'bank' : 'lock'} size={18} />
							</span>
							<span>
								<span className="gate-card-title">{vault.name}</span>
								<span className="gate-card-sub muted">
									{vault.kind === 'sandbox' ? 'Local sandbox' : vault.kind === 'remote' ? 'Remote runtime' : 'Unlock'}
								</span>
							</span>
							<Icon name="chevronRight" size={16} />
						</button>
					))}

					<button type="button" className="glass gate-card" onClick={() => setMode('create')}>
						<span className="gate-card-icon">
							<Icon name="shield" size={18} />
						</span>
						<span>
							<span className="gate-card-title">Create a BrainVault</span>
							<span className="gate-card-sub muted">A name and a passphrase are the whole wallet</span>
						</span>
						<Icon name="chevronRight" size={16} />
					</button>

					<button type="button" className="glass gate-card" onClick={() => setMode('import')}>
						<span className="gate-card-icon">
							<Icon name="request" size={18} />
						</span>
						<span>
							<span className="gate-card-title">Import a phrase</span>
							<span className="gate-card-sub muted">24 words, standard BIP39</span>
						</span>
						<Icon name="chevronRight" size={16} />
					</button>

					<button type="button" className="glass gate-card" onClick={() => setMode('remote')}>
						<span className="gate-card-icon">
							<Icon name="bank" size={18} />
						</span>
						<span>
							<span className="gate-card-title">Connect a remote runtime</span>
							<span className="gate-card-sub muted">Your server, over an authenticated channel</span>
						</span>
						<Icon name="chevronRight" size={16} />
					</button>

					<button type="button" className="btn btn-quiet gate-sandbox" onClick={enterSandbox}>
						Enter the sandbox — three actors, funded, instant
					</button>
				</div>
			)}

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
						<input
							className="input"
							type="password"
							value={passphrase}
							onChange={e => setPassphrase(e.target.value)}
							placeholder="Long and memorable"
						/>
					</label>
					<label className="field">
						<span className="field-label">Difficulty · factor {factor}</span>
						<input type="range" min={1} max={4} step={1} value={factor} onChange={e => setFactor(Number(e.target.value))} />
						<span className="faint" style={{ fontSize: 12 }}>
							Higher factors take longer to derive — and longer to attack.
						</span>
					</label>
					<div className="gate-form-actions">
						<button type="button" className="btn btn-quiet" onClick={() => setMode('landing')}>
							Back
						</button>
						<button type="submit" className="btn btn-primary" disabled={name.trim().length < 2 || passphrase.length < 8}>
							Derive vault
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
						<textarea
							className="input"
							rows={3}
							value={phrase}
							onChange={e => setPhrase(e.target.value)}
							placeholder="twenty four words separated by spaces"
							autoFocus
						/>
					</label>
					<div className="gate-form-actions">
						<button type="button" className="btn btn-quiet" onClick={() => setMode('landing')}>
							Back
						</button>
						<button type="submit" className="btn btn-primary" disabled={phrase.trim().split(/\s+/).length < 12}>
							Unlock
						</button>
					</div>
				</form>
			)}

			{mode === 'remote' && (
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
						<button type="button" className="btn btn-quiet" onClick={() => setMode('landing')}>
							Back
						</button>
						<button type="submit" className="btn btn-primary" disabled={!wsUrl.trim()}>
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
			<span />
		</div>
	);
}

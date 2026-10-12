type Props = {
	enabled: boolean; address: string; onToggle: (enabled: boolean) => void; onAddress: (address: string) => void;
	source: 'tower' | 'file'; onSource: (source: 'tower' | 'file') => void; onFile: (file: File | null) => void;
};

export function RestoreChoice({ enabled, address, onToggle, onAddress, source, onSource, onFile }: Props) {
	return (
		<div className="field">
			<label className="field-row">
				<input type="checkbox" checked={enabled} onChange={event => onToggle(event.target.checked)} data-testid="restore-from-tower" />
				<span>Restore a backup on this device</span>
			</label>
			{enabled && <>
				<label className="field">
					<span className="field-label">Backup source</span>
					<select className="input" value={source} onChange={event => onSource(event.target.value === 'file' ? 'file' : 'tower')} data-testid="restore-source">
						<option value="tower">Backup tower</option>
						<option value="file">Saved backup file</option>
					</select>
				</label>
				{source === 'file' ? <label className="field">
					<span className="field-label">Encrypted backup file</span>
					<input className="input" type="file" accept=".json,application/json" required onChange={event => onFile(event.target.files?.[0] ?? null)} data-testid="restore-file" />
				</label> :
				<label className="field">
					<span className="field-label">Your backup tower</span>
					<input className="input" type="url" value={address} onChange={event => onAddress(event.target.value)} placeholder="https://your-tower.example" required data-testid="restore-tower-url" />
				</label>}
				<p className="note">Your phrase decrypts the backup here. Restoration checks its signatures and requires a device with no local data for this wallet.</p>
			</>}
		</div>
	);
}

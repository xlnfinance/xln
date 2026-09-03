import { useState } from 'react';
import { Icon } from './Icons';
import { getTokenMeta, knownTokenIds, tokenGlyph } from '../runtime/format';

export function TokenIcon({ tokenId, size = 'md' }: { tokenId: number; size?: 'md' | 'sm' }) {
	const meta = getTokenMeta(tokenId);
	return (
		<span className={`token-icon${size === 'sm' ? ' sm' : ''}`} style={{ background: meta.color }} aria-hidden>
			{tokenGlyph(meta.symbol)}
		</span>
	);
}

export function TokenPicker({
	tokenId,
	onChange,
	exclude,
	chip,
}: {
	tokenId: number;
	onChange: (tokenId: number) => void;
	exclude?: number;
	chip?: string;
}) {
	const [open, setOpen] = useState(false);
	const meta = getTokenMeta(tokenId);
	return (
		<div className="picker">
			<button type="button" className="pill" onClick={() => setOpen(value => !value)} aria-haspopup="listbox" aria-expanded={open}>
				<TokenIcon tokenId={tokenId} size="sm" />
				{meta.symbol}
				{chip ? <span className="chip">{chip}</span> : null}
				<Icon name="chevronDown" size={14} />
			</button>
			{open && (
				<div className="picker-menu right" role="listbox" style={{ minWidth: 220 }}>
					{knownTokenIds()
						.filter(id => id !== exclude)
						.map(id => {
							const option = getTokenMeta(id);
							return (
								<button
									key={id}
									type="button"
									role="option"
									aria-selected={id === tokenId}
									className={`picker-option${id === tokenId ? ' active' : ''}`}
									onClick={() => {
										onChange(id);
										setOpen(false);
									}}
								>
									<span className="t">
										<TokenIcon tokenId={id} size="sm" />
										{option.symbol}
									</span>
									<span className="faint" style={{ fontSize: 11.5 }}>
										{option.name}
									</span>
								</button>
							);
						})}
				</div>
			)}
		</div>
	);
}

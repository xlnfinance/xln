import type { ReactNode } from 'react';
import { Icon } from './Icons';

export function Sheet({
	title,
	onClose,
	children,
}: {
	title: string;
	onClose: () => void;
	children: ReactNode;
}) {
	return (
		<>
			<div className="scrim" onClick={onClose} />
			<div className="sheet" role="dialog" aria-modal aria-label={title}>
				<div className="sheet-header">
					<span className="caps">{title}</span>
					<button type="button" className="btn-quiet btn" onClick={onClose} aria-label="Close">
						<Icon name="close" size={16} />
					</button>
				</div>
				<div className="sheet-body">{children}</div>
			</div>
		</>
	);
}

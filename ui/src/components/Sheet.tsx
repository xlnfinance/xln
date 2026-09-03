import { useEffect, type ReactNode } from 'react';
import { Icon } from './Icons';

/** Bottom sheet on phones, centered dialog on desktop. Escape and scrim both close it. */
export function Sheet({
	title,
	onClose,
	children,
	testId,
}: {
	title?: string;
	onClose: () => void;
	children: ReactNode;
	testId?: string;
}) {
	useEffect(() => {
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === 'Escape') onClose();
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [onClose]);

	return (
		<>
			<div className="scrim" onClick={onClose} />
			<div className="sheet" role="dialog" aria-modal aria-label={title ?? 'Details'} {...(testId ? { 'data-testid': testId } : {})}>
				<div className="sheet-grab" />
				<div className="sheet-header">
					<span className="caps">{title ?? ''}</span>
					<button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
						<Icon name="close" size={16} />
					</button>
				</div>
				<div className="sheet-body">{children}</div>
			</div>
		</>
	);
}

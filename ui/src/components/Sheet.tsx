import { useLayoutEffect, useRef, type ReactNode } from 'react';
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
	const dialog = useRef<HTMLDialogElement>(null);
	useLayoutEffect(() => {
		const node = dialog.current!;
		const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		// Native modal ownership makes the background inert and handles entry.
		// Closing must return focus to the opener even if focus left the dialog.
		node.showModal();
		return () => {
			node.close();
			if (opener?.isConnected) opener.focus({ preventScroll: true });
		};
	}, []);

	return (
		<dialog ref={dialog} className="sheet" aria-label={title ?? 'Details'}
			onCancel={event => { event.preventDefault(); onClose(); }}
			onClick={event => {
				if (event.target !== event.currentTarget) return;
				const rect = event.currentTarget.getBoundingClientRect();
				if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
			}}
			{...(testId ? { 'data-testid': testId } : {})}>
			<div className="sheet-grab" />
			<div className="sheet-header">
				<span className="caps">{title ?? ''}</span>
				<button type="button" className="icon-btn" onClick={onClose} aria-label="Close" data-testid="sheet-close">
					<Icon name="close" size={16} />
				</button>
			</div>
			<div className="sheet-body">{children}</div>
		</dialog>
	);
}

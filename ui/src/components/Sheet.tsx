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
		// Native modal ownership makes the background inert and handles keyboard
		// focus entry/restoration, including nested dialogs.
		node.showModal();
		return () => node.close();
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
				<button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
					<Icon name="close" size={16} />
				</button>
			</div>
			<div className="sheet-body">{children}</div>
		</dialog>
	);
}

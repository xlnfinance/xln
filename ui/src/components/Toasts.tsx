import { useApp } from '../runtime/store';

export function Toasts() {
	const toasts = useApp(s => s.toasts);
	if (toasts.length === 0) return null;
	return (
		<div className="toasts" role="status">
			{toasts.map(toast => (
				<div key={toast.id} className={`toast${toast.kind === 'danger' ? ' toast-danger' : ''}`}>
					{toast.text}
				</div>
			))}
		</div>
	);
}

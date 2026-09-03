import { useApp } from '../runtime/store';
import { shortId } from '../runtime/format';

/**
 * An entity id or hash that copies itself on tap. The full value stays in the
 * tooltip; the visible text is the shortened form unless `full` is set.
 */
export function CopyId({ value, label = 'Id', full = false, head = 10, tail = 6, className = '' }: {
	value: string;
	label?: string;
	full?: boolean;
	head?: number;
	tail?: number;
	className?: string;
}) {
	const toast = useApp(s => s.toast);
	const text = String(value || '');
	if (!text) return <span className={`hash ${className}`.trim()}>—</span>;
	const copy = async (): Promise<void> => {
		try {
			await navigator.clipboard.writeText(text);
			toast(`${label} copied`);
		} catch {
			toast(`Could not copy the ${label.toLowerCase()}`, 'danger');
		}
	};
	return (
		<button type="button" className={`hash copy ${className}`.trim()} title={`${text} · tap to copy`} onClick={() => void copy()}>
			{full ? text : shortId(text, head, tail)}
		</button>
	);
}

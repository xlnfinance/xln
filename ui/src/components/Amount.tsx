import { splitAmountForDisplay } from '../runtime/format';

/** Serif display numeral with dimmed decimals — the Sovereign signature. */
export function Amount({
	value,
	decimals,
	symbol,
	size = 46,
}: {
	value: bigint;
	decimals: number;
	symbol?: string;
	size?: number;
}) {
	const [whole, fraction] = splitAmountForDisplay(value, decimals);
	return (
		<span className="display num" style={{ fontSize: size, lineHeight: 1 }}>
			{whole}
			{fraction ? <span className="faint">{fraction}</span> : null}
			{symbol ? (
				<span className="muted" style={{ fontSize: Math.round(size * 0.42), marginLeft: '0.35em', fontFamily: 'var(--font-ui)' }}>
					{symbol}
				</span>
			) : null}
		</span>
	);
}

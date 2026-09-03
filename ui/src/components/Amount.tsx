import { formatUsd, splitAmountForDisplay } from '../runtime/format';

/** Display numeral with dimmed decimals. Tabular digits so columns line up. */
export function Amount({
	value,
	decimals,
	symbol,
	size = 40,
	testId,
}: {
	value: bigint;
	decimals: number;
	symbol?: string;
	size?: number;
	testId?: string;
}) {
	const [whole, fraction] = splitAmountForDisplay(value, decimals);
	return (
		<span className="display num" style={{ fontSize: size }} {...(testId ? { 'data-testid': testId } : {})}>
			{whole}
			{fraction ? <span className="dec">{fraction}</span> : null}
			{symbol ? (
				<span className="muted" style={{ fontSize: Math.round(size * 0.4), marginLeft: '0.3em', fontWeight: 500, letterSpacing: 0 }}>
					{symbol}
				</span>
			) : null}
		</span>
	);
}

/** USD display numeral: "$3,762" with ".00" dimmed. */
export function UsdAmount({ value, size = 40, testId }: { value: number; size?: number; testId?: string }) {
	const text = formatUsd(value);
	const dot = text.lastIndexOf('.');
	const whole = dot >= 0 ? text.slice(0, dot) : text;
	const fraction = dot >= 0 ? text.slice(dot) : '';
	return (
		<span className="display num" style={{ fontSize: size }} {...(testId ? { 'data-testid': testId } : {})}>
			{whole}
			{fraction ? <span className="dec">{fraction}</span> : null}
		</span>
	);
}

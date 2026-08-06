/**
 * The XLN invariant at a glance: white = collateral, champagne = credit in
 * use, dim = free capacity. Same visual on account rows and detail views.
 */
export function CapacityBar({
	collateral,
	creditUsed,
	free,
	height = 2,
}: {
	collateral: bigint;
	creditUsed: bigint;
	free: bigint;
	height?: number;
}) {
	const total = collateral + creditUsed + free;
	const pct = (part: bigint): string => (total <= 0n ? '0%' : `${Number((part * 1000n) / total) / 10}%`);
	return (
		<div className="capbar" style={{ height }} aria-hidden>
			<span className="capbar-collateral" style={{ width: pct(collateral) }} />
			<span className="capbar-credit" style={{ width: pct(creditUsed) }} />
		</div>
	);
}

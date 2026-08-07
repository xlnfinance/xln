import type { DerivedDelta } from '@xln/runtime/api/public/runtime-module';
import { formatAmount } from '../runtime/format';

const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);

function pct(value: bigint, base: bigint): number {
	if (base <= 0n || value <= 0n) return 0;
	return Number((value * 10000n) / base) / 100;
}

/**
 * The wallet's canonical center-layout capacity bar (DeltaCapacityBar):
 * left half = outCapacity decomposed, right half = inCapacity decomposed.
 *
 *   [their debt][collateral][your unused credit] ‖ [your debt][collateral][their free line]
 *      red          green         champagne          champagne     green        red
 *
 * Both halves share one scale (the larger half = 100%). Every segment is a
 * deriveDelta field: out/inOwnCredit, out/inCollateral, out/inPeerCredit.
 */
export function DeltaBar({ derived, height = 6 }: { derived: DerivedDelta; height?: number }) {
	const outTotal = derived.outOwnCredit + derived.outCollateral + derived.outPeerCredit;
	const inTotal = derived.inOwnCredit + derived.inCollateral + derived.inPeerCredit;
	const halfMax = max(outTotal, inTotal);

	return (
		<div className="dbar" style={{ height }} aria-hidden>
			<div className="dbar-half dbar-out">
				<span className="dbar-seg dbar-own" style={{ width: `${pct(derived.outOwnCredit, halfMax)}%` }} />
				<span className="dbar-seg dbar-coll" style={{ width: `${pct(derived.outCollateral, halfMax)}%` }} />
				<span className="dbar-seg dbar-peer" style={{ width: `${pct(derived.outPeerCredit, halfMax)}%` }} />
			</div>
			<span className="dbar-notch" />
			<div className="dbar-half">
				<span className="dbar-seg dbar-own" style={{ width: `${pct(derived.inOwnCredit, halfMax)}%` }} />
				<span className="dbar-seg dbar-coll" style={{ width: `${pct(derived.inCollateral, halfMax)}%` }} />
				<span className="dbar-seg dbar-peer" style={{ width: `${pct(derived.inPeerCredit, halfMax)}%` }} />
			</div>
		</div>
	);
}

function LegendItem({
	cls,
	label,
	value,
	decimals,
}: {
	cls: string;
	label: string;
	value: bigint;
	decimals: number;
}) {
	return (
		<span style={{ opacity: value > 0n ? 1 : 0.35 }}>
			<i className={cls} /> {label} <b className="num">{formatAmount(value, decimals, 2)}</b>
		</span>
	);
}

/**
 * Numbers under the bar, one line per direction — every segment named and
 * quantified so credit vs collateral vs unused credit reads at a glance.
 */
export function DeltaBreakdown({
	derived,
	decimals,
	symbol,
}: {
	derived: DerivedDelta;
	decimals: number;
	symbol: string;
}) {
	return (
		<div className="delta-breakdown">
			<div className="delta-legend">
				<span className="delta-side">
					← send {formatAmount(derived.outCapacity, decimals, 2)} {symbol}
				</span>
				<LegendItem cls="dbar-own" label="your unused credit" value={derived.outOwnCredit} decimals={decimals} />
				<LegendItem cls="dbar-coll" label="collateral" value={derived.outCollateral} decimals={decimals} />
				<LegendItem cls="dbar-peer" label="their debt to you" value={derived.outPeerCredit} decimals={decimals} />
			</div>
			<div className="delta-legend">
				<span className="delta-side">
					receive {formatAmount(derived.inCapacity, decimals, 2)} {symbol} →
				</span>
				<LegendItem cls="dbar-own" label="your debt" value={derived.inOwnCredit} decimals={decimals} />
				<LegendItem cls="dbar-coll" label="collateral" value={derived.inCollateral} decimals={decimals} />
				<LegendItem cls="dbar-peer" label="their unused credit" value={derived.inPeerCredit} decimals={decimals} />
			</div>
		</div>
	);
}

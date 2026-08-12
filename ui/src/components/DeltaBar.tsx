import type { DerivedDelta } from '@xln/runtime/api/public/runtime-module';

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

/** Static color key for the bar's three segment kinds — own credit, collateral, peer credit. */
export function DeltaLegend() {
	return (
		<div className="delta-legend">
			<span>
				<i className="dbar-own" /> unused credit
			</span>
			<span>
				<i className="dbar-coll" /> collateral
			</span>
			<span>
				<i className="dbar-peer" /> counterparty credit
			</span>
		</div>
	);
}

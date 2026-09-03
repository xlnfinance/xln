import type { DerivedDelta } from '@xln/core/api/public/runtime-module';
import { usdOf } from '../runtime/financial/prices';

export type SegmentKind = 'slate' | 'coll' | 'credit' | 'debt' | 'pend' | 'this';

export type BarSegment = { usd: number; kind: SegmentKind };

/**
 * Visceral value. A segment is exactly `usd * --ppu` pixels wide; the scale is one
 * CSS variable shared by every bar in the app. Long money runs off the row and
 * fades instead of being squeezed, so two rows are always comparable.
 */
export function Bar({ segments, height = 6 }: { segments: BarSegment[]; height?: 4 | 6 | 8 }) {
	const heightClass = height === 4 ? ' h4' : height === 8 ? ' h8' : '';
	return (
		<div className="bw" aria-hidden>
			<div className={`bar${heightClass}`}>
				{segments.map((segment, index) =>
					segment.usd > 0 ? <i key={index} className={`seg c-${segment.kind}`} style={{ ['--u' as string]: segment.usd }} /> : null,
				)}
			</div>
		</div>
	);
}

/**
 * The bilateral account bar, drawn from deriveDelta fields only.
 *
 *   [own unused credit][collateral][their debt] ‖ [my debt][collateral][their unused line]
 *
 * Left half is what we can send, right half what we can receive, the notch is Δ.
 * Debts sit next to the notch, unused credit lines at the edges, so the bar reads
 * as the RCPAN number line: −L_left ≤ Δ ≤ C + L_right. A hold (HTLC in flight) is
 * striped over the inner end of the half it reduces.
 */
export function DeltaBar({ derived, tokenId }: { derived: DerivedDelta; tokenId: number }) {
	const u = (value: bigint): number => usdOf(tokenId, value);
	const outHold = derived.outTotalHold ?? 0n;
	const inHold = derived.inTotalHold ?? 0n;
	return (
		<div className="dbar" aria-hidden>
			<div className="half out">
				<div className="bar">
					<Seg usd={u(derived.outOwnCredit)} kind="credit" />
					<Seg usd={u(derived.outCollateral)} kind="coll" />
					<Seg usd={u(derived.outPeerCredit)} kind="debt" />
				</div>
				{outHold > 0n ? <i className="hold" style={{ ['--u' as string]: u(outHold) }} /> : null}
			</div>
			<i className="notch" />
			<div className="half in">
				<div className="bar">
					<Seg usd={u(derived.inOwnCredit)} kind="debt" />
					<Seg usd={u(derived.inCollateral)} kind="coll" />
					<Seg usd={u(derived.inPeerCredit)} kind="credit" />
				</div>
				{inHold > 0n ? <i className="hold" style={{ ['--u' as string]: u(inHold) }} /> : null}
			</div>
		</div>
	);
}

function Seg({ usd, kind }: { usd: number; kind: SegmentKind }) {
	if (usd <= 0) return null;
	return <i className={`seg c-${kind}`} style={{ ['--u' as string]: usd }} />;
}

export function DeltaCaption({ derived, format }: { derived: DerivedDelta; format: (value: bigint) => string }) {
	return (
		<div className="dcap">
			<span>send up to {format(derived.outCapacity)}</span>
			<span>receive up to {format(derived.inCapacity)}</span>
		</div>
	);
}

export function Legend() {
	return (
		<div className="legend">
			<span>
				<i className="c-slate" /> on-chain
			</span>
			<span>
				<i className="c-coll" /> collateral
			</span>
			<span>
				<i className="c-credit" /> credit line
			</span>
			<span>
				<i className="c-debt" /> owed
			</span>
			<span>
				<i className="c-hold" /> in flight
			</span>
		</div>
	);
}

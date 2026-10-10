import { useState } from 'react';
import { DeltaBar, DeltaCaption } from '../Bars';
import { Icon } from '../Icons';
import { TokenIcon } from '../TokenPicker';
import { formatMoney, formatSigned, getTokenMeta } from '../../runtime/format';
import type { AccountTokenView } from '../../runtime/views';
export function TokenSection({ token, disputed = false, closed = false }: { token: AccountTokenView; disputed?: boolean; closed?: boolean }) {
	const meta = getTokenMeta(token.tokenId);
	const d = token.derived;
	const money = (value: bigint): string => formatMoney(value, meta.decimals);
	const [details, setDetails] = useState(false);
	return (
		<section className="card" style={{ marginBottom: 14 }}>
			<div className="rt" style={{ marginBottom: 14 }}>
				<TokenIcon tokenId={token.tokenId} />
				<span className="tx">
					<span className="t">{meta.symbol}</span>
					<span className="s">{token.signed > 0n ? 'they owe you' : token.signed < 0n ? 'you owe them' : 'even'}</span>
				</span>
				<span className="r">
					<span className="v num display" style={{ fontSize: 22 }}>
						{formatSigned(token.signed, meta.decimals)}
					</span>
				</span>
			</div>
			<DeltaBar derived={d} tokenId={token.tokenId} />
			{disputed
				? <p role="status">{closed ? 'Account permanently closed after dispute. The settlement returned funds to your reserve.' : 'Account frozen by dispute. Sending and receiving are unavailable.'}</p>
				: <DeltaCaption derived={d} format={money} />}
			<div style={{ marginTop: 14 }}>
				<div className="kv">
					<span className="k">Their credit line to you</span>
					<span className="v num">{money(d.ownCreditLimit)}</span>
				</div>
				<div className="kv">
					<span className="k">Your credit line to them</span>
					<span className="v num">{money(d.peerCreditLimit)}</span>
				</div>
				<div className="kv">
					<span className="k">Collateral</span>
					<span className={`v num${d.collateral > 0n ? ' st-settled' : ''}`}>{money(d.collateral)}</span>
				</div>
				{(d.outTotalHold ?? 0n) > 0n || (d.inTotalHold ?? 0n) > 0n ? (
					<div className="kv">
						<span className="k">In flight</span>
						<span className="v num st-inflight">
							{money(d.outTotalHold ?? 0n)} out · {money(d.inTotalHold ?? 0n)} in
						</span>
					</div>
				) : null}
			</div>
			<button type="button" className="btn quiet" style={{ marginTop: 10 }} onClick={() => setDetails(value => !value)}>
				Ledger detail <Icon name={details ? 'chevronDown' : 'chevronRight'} size={13} />
			</button>
			{details && (
				<div className="fade-in" style={{ marginTop: 6 }}>
					<div className="kv">
						<span className="k">Δ</span>
						<span className="v num mono" style={{ color: 'var(--ink-2)' }}>
							{formatMoney(d.delta, meta.decimals, 6)}
						</span>
					</div>
					<div className="kv">
						<span className="k">offdelta</span>
						<span className="v num mono" style={{ color: 'var(--ink-2)' }}>
							{formatMoney(token.delta.offdelta, meta.decimals, 6)}
						</span>
					</div>
					<div className="kv">
						<span className="k">ondelta</span>
						<span className="v num mono" style={{ color: 'var(--ink-2)' }}>
							{formatMoney(token.delta.ondelta, meta.decimals, 6)}
						</span>
					</div>
					<div className="kv">
						<span className="k">Total capacity</span>
						<span className="v num mono" style={{ color: 'var(--ink-2)' }}>
							{formatMoney(d.totalCapacity, meta.decimals, 6)}
						</span>
					</div>
				</div>
			)}
		</section>
	);
}

import { useMemo, useState } from 'react';
import type { RuntimeAdapterSwapHistoryPage } from '@xln/core/api/runtime-adapter/types';
import { useAdapterRead } from '../../runtime/hooks';
import { formatMoney } from '../../runtime/format';
import { getTokenMeta } from '../../runtime/token-meta';
import { displayEntityName } from '../../runtime/views';
import { CopyId } from '../CopyId';

type HistoryPage = Omit<RuntimeAdapterSwapHistoryPage, 'nextCursor'> & { nextCursor: string | null };
type Order = HistoryPage['items'][number];
const amount = (value: bigint | null, tokenId: number): string => {
  if (value === null) return 'Not recorded';
  const token = getTokenMeta(tokenId);
  return `${formatMoney(value, token.decimals, token.decimals)} ${token.symbol}`;
};

function OrderRecord({ order }: { order: Order }) {
  return <details className="card" data-testid="swap-history-order">
    <summary>
      <strong>{getTokenMeta(order.giveTokenId).symbol} → {getTokenMeta(order.wantTokenId).symbol}</strong>
      <span className="note"> · {order.closed ? 'Closed' : order.cancelRequested ? 'Cancellation requested' : 'Open'} · {order.resolves.length} executions</span>
    </summary>
    <div className="kv"><span className="k">Requested</span><span className="v num">{amount(order.originalGiveAmount, order.giveTokenId)} → {amount(order.originalWantAmount, order.wantTokenId)}</span></div>
    {order.liveGiveAmount !== null && <div className="kv"><span className="k">Remaining</span><span className="v num">{amount(order.liveGiveAmount, order.giveTokenId)}</span></div>}
    {order.resolves.map((fill, index) => <div key={`${fill.height}:${index}`} className="card">
      <div className="caps">Account frame #{fill.height} · {fill.cancelRemainder ? 'Remainder cancelled' : 'Execution'}</div>
      <div className="kv"><span className="k">Gave</span><span className="v num" data-field="gave" data-amount={fill.executionGiveAmount?.toString()}>{amount(fill.executionGiveAmount, order.giveTokenId)}</span></div>
      <div className="kv"><span className="k">Received</span><span className="v num" data-field="received" data-amount={fill.executionWantAmount?.toString()}>{amount(fill.executionWantAmount, order.wantTokenId)}</span></div>
      {fill.feeTokenId !== null && <div className="kv"><span className="k">Fee</span><span className="v num" data-field="fee" data-amount={fill.feeAmount?.toString()}>{amount(fill.feeAmount, fill.feeTokenId)}</span></div>}
      {fill.comment && <p className="note">{fill.comment}</p>}
    </div>)}
    {order.resolves.length === 0 && <p className="note">No execution recorded.</p>}
    <div className="kv"><span className="k">Order</span><CopyId value={order.offerId} label="Order ID" /></div>
    <p className="note">Account frames #{order.createdHeight}–{order.lastUpdatedHeight}. Executed amounts come from stored records; requested amounts are not fills.</p>
  </details>;
}

function AccountOrders({ entityId, accountId }: { entityId: string; accountId: string }) {
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const cursor = cursors.at(-1)!;
  const query = useMemo(() => ({ limit: 25, ...(cursor ? { cursor } : {}) }), [cursor]);
  const read = useAdapterRead<HistoryPage>(`entity/${entityId}/account/${accountId}/swap-history`, query);
  return <div>
    {read.error && <p role="alert">Order history unavailable: {read.error}</p>}
    {read.loading && <p role="status" className="note">Reading account history…</p>}
    {!read.loading && !read.error && read.data?.items.length === 0 && <p className="note">No orders on this account.</p>}
    {!read.error && read.data?.items.map(order => <OrderRecord key={order.offerId} order={order} />)}
    <div className="actions">
      {cursors.length > 1 && <button className="btn quiet" disabled={read.loading} onClick={() => setCursors(values => values.slice(0, -1))}>Newer orders</button>}
      {read.data?.nextCursor && <button className="btn quiet" disabled={read.loading || Boolean(read.error)} onClick={() => {
        const next = read.data?.nextCursor;
        if (next && !cursors.includes(next)) setCursors(values => [...values, next]);
      }}>Earlier orders</button>}
    </div>
  </div>;
}

export function SwapHistory({ entityId, accountIds, names }: { entityId: string; accountIds: readonly string[]; names: Map<string, string> }) {
  const [chosen, setChosen] = useState('');
  const accountId = accountIds.includes(chosen) ? chosen : accountIds[0];
  return <section aria-label="Swap history">
    <h2>Swaps</h2>
    <p className="note">Executed amounts, fees and cancellations.</p>
    {accountId ? <>
      <label className="field">Account<select className="input" value={accountId} onChange={event => setChosen(event.target.value)}>
        {accountIds.map(id => <option key={id} value={id}>{displayEntityName(names, id)}</option>)}
      </select></label>
      <AccountOrders key={`${entityId}:${accountId}`} entityId={entityId} accountId={accountId} />
    </> : <p className="note">Open an account to trade.</p>}
  </section>;
}

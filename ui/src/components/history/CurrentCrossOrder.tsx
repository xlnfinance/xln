import type { RuntimeAdapterCrossOrder } from '@xln/core/api/runtime-adapter/read/cross-order';
import { useAdapterRead } from '../../runtime/hooks';
import { formatClock } from '../../runtime/format';

const labels: Record<RuntimeAdapterCrossOrder['status'], string> = {
  intent: 'Preparing',
  target_prepared: 'Destination prepared',
  resting: 'Open',
  partially_filled: 'Partially filled',
  clear_requested: 'Settlement requested',
  clearing: 'Settling',
  settled: 'Settled locally',
  cancelled: 'Cancelled locally',
  expired: 'Expired locally',
};

export function CurrentCrossOrder({ entityId, orderId }: { entityId: string; orderId: string }) {
  const read = useAdapterRead<RuntimeAdapterCrossOrder>(
    `entity/${entityId}/cross-order/${encodeURIComponent(orderId)}`,
  );
  return (
    <section
      aria-label="Current cross-network order"
      data-testid="cross-order-current"
      data-order-id={orderId}
      data-entity-id={entityId}
      data-status={read.data?.status}
      data-runtime-height={read.data?.runtimeHeight}
    >
      <h3>Current order status</h3>
      {read.error && <p role="alert">Order status unavailable: {read.error}</p>}
      {read.loading && (
        <p role="status" className="note">
          Reading committed order state…
        </p>
      )}
      {!read.error && read.data && (
        <>
          <strong data-testid="cross-order-status">{labels[read.data.status]}</strong>
          <p className="note">Updated {formatClock(read.data.updatedAt)}.</p>
          <p className="note">This Entity’s recorded order status. Check the destination account for delivery.</p>
        </>
      )}
    </section>
  );
}

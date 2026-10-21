import type { RuntimeAdapterEntitySummary } from '@xln/core/api/public/runtime-module';
import { useEffect } from 'react';
import { useOrderbook, type BookView } from '../../../runtime/financial/orderbook';
import { gossipProfile } from '../../../runtime/financial/roles';
import { getTokenMeta } from '../../../runtime/token-meta';

/** The existing authenticated market reader owns freshness, hub identity and pair selection. */
export function LoadMarket({
  hubId,
  entityId,
  summaries,
  baseTokenId,
  quoteTokenId,
  onBook,
}: {
  hubId: string;
  entityId: string;
  summaries: readonly RuntimeAdapterEntitySummary[];
  baseTokenId: number;
  quoteTokenId: number;
  onBook: (pairId: string, book: BookView | null) => void;
}) {
  const book = useOrderbook({
    hubId,
    tokenA: baseTokenId,
    tokenB: quoteTokenId,
    ownEntityId: entityId,
    summaries,
    depth: 1,
    baseDecimals: getTokenMeta(baseTokenId).decimals,
    relayUrl: gossipProfile(hubId)?.relays[0] ?? '',
  });
  useEffect(() => {
    onBook(book.pairId, book);
    return () => onBook(book.pairId, null);
  }, [book, onBook]);
  return null;
}

import { createHash } from 'node:crypto';
import { compareStableText, safeStringify } from '../../../protocol/serialization';

export type MarketMakerRuntimeBacklogSnapshot = Readonly<{
  processing: boolean;
  runtimeTxs: number;
  entityInputs: number;
  inFlightEntityInputs: number;
  jInputs: number;
}>;

export type MarketMakerCanonicalEntityHash = Readonly<{
  entityId: string;
  hash: string;
  cellCount: number;
}>;

export const buildMarketMakerBootstrapEntityStateHashFromCanonicalHashes = (
  canonicalEntityHashes: readonly MarketMakerCanonicalEntityHash[],
): string => createHash('sha256').update(safeStringify({
  schema: 'market-maker-bootstrap-entity-state-v1',
  entities: canonicalEntityHashes
    .map(({ entityId, hash, cellCount }) => ({ entityId, hash, cellCount }))
    .sort((left, right) => compareStableText(left.entityId, right.entityId)),
})).digest('hex');

/**
 * Runtime-only bookkeeping may overlap quote production. Entity work may not:
 * once a runtime frame detaches its batch, the live mempool is empty even
 * though those quote inputs are not committed yet. Ignoring the detached
 * count lets the producer enqueue the same missing offer twice.
 */
export const runtimeBacklogBlocksMarketMakerQuotes = (
  backlog: MarketMakerRuntimeBacklogSnapshot,
): boolean => backlog.entityInputs > 0 || backlog.inFlightEntityInputs > 0;

// Health reads may alternate between planned summaries and full route detail.
// Only the canonical causal checkpoint can renew the bootstrap idle deadline.
export const marketMakerBootstrapProgressSignature = (causalCheckpoint: unknown): string =>
  safeStringify(causalCheckpoint);

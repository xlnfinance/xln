import type { EntityState } from '../types';
import type { CompletedBatch } from '../j-batch';

export function emptyOpBreakdown() {
  return {
    flashloans: 0,
    reserveToReserve: 0,
    reserveToCollateral: 0,
    collateralToReserve: 0,
    settlements: 0,
    disputeStarts: 0,
    disputeFinalizations: 0,
    externalTokenToReserve: 0,
    reserveToExternalToken: 0,
    revealSecrets: 0,
  };
}

export function appendBatchHistory(state: EntityState, entry: CompletedBatch): void {
  if (!state.batchHistory) state.batchHistory = [];
  const last = state.batchHistory[state.batchHistory.length - 1];
  const sameAsLast =
    !!last &&
    String(last.txHash || '') === String(entry['txHash'] || '') &&
    String(last.eventType || '') === String(entry['eventType'] || '') &&
    Number(last.jBlockNumber || 0) === Number(entry['jBlockNumber'] || 0) &&
    Number(last.entityNonce || 0) === Number(entry['entityNonce'] || 0);
  if (sameAsLast) return;
  state.batchHistory.push(entry);
  if (state.batchHistory.length > 40) {
    state.batchHistory = state.batchHistory.slice(-40);
  }
}

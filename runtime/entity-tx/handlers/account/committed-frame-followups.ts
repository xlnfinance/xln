import type { AccountFrame, EntityState } from '../../../types';
import { HEAVY_LOGS } from '../../../utils';
import { swapKey } from '../../../swap-execution';
import { cancelHook as cancelScheduledHook } from '../../../entity-crontab';
import { terminateHtlcRoute } from '../../htlc-route-lifecycle';

export function applyCommittedAccountFrameFollowups(
  newState: EntityState,
  counterpartyId: string,
  committedFrame: AccountFrame,
): void {
  if (HEAVY_LOGS) {
    console.log(
      `FRAME-COMMIT-FOLLOWUPS: height=${committedFrame.height}, txs=${committedFrame.accountTxs.length}`,
    );
  }

  for (const accountTx of committedFrame.accountTxs) {
    if (HEAVY_LOGS) console.log(`FRAME-COMMIT-FOLLOWUPS: tx type=${accountTx.type}`);

    // Account frames are canonical once committed; keep entity-local indexes in
    // sync here instead of mutating them while the account proposal is still tentative.
    if (accountTx.type === 'htlc_resolve') {
      newState.lockBook.delete(accountTx.data.lockId);
      if (newState.crontabState) {
        cancelScheduledHook(newState.crontabState, `htlc-timeout:${accountTx.data.lockId}`);
      }
      if (accountTx.data.outcome === 'secret') {
        for (const [hashlock, route] of newState.htlcRoutes.entries()) {
          if (route.inboundLockId !== accountTx.data.lockId) continue;
          terminateHtlcRoute(newState, hashlock, newState.timestamp);
        }
      }
    }

    if (accountTx.type === 'j_event_claim') continue;

    if (accountTx.type === 'swap_resolve') {
      const key = swapKey(counterpartyId, accountTx.data.offerId);
      newState.pendingSwapFillRatios?.delete(key);
    }
  }
}

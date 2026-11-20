import { deriveDelta, isLeftEntity } from '../../../../../core/account/utils';
import { getCrossJurisdictionRouteRemainingAmounts } from '../../../../../core/extensions/cross-j/orderbook';
import type { EntityState } from '../../../../../core/entity/types';
import type { ChainAuthority } from '../authority';

export const observeEntityPosition = (state: EntityState, chain: ChainAuthority, orderId: string) => {
  const account = state.accounts.get(chain.hubEntity);
  const delta = account?.state.deltas.get(1);
  const perspective = delta && deriveDelta(delta, isLeftEntity(chain.userEntity, chain.hubEntity));
  const route = state.crossJurisdictionSwaps?.get(orderId);
  const batch = state.jBatchState;
  const settlement = state.settlementContinuations?.get(chain.hubEntity);
  return {
    chainId: chain.chainId,
    lastFinalizedJHeight: state.lastFinalizedJHeight,
    lastFinalizedJHash: state.jHistoryFinality?.tipBlockHash ?? null,
    reserve: state.reserves.get(1) ?? 0n,
    collateral: perspective?.outCollateral ?? null,
    claim: perspective?.outPeerCredit ?? null,
    coverRequested: account?.state.requestedRebalanceFeeState.get(1)?.requestedAmount ?? null,
    // An in-flight settlement is visible separately from the collateral at the committed Account frame.
    settlementPending: Boolean(account?.state.settlementWorkspace || settlement),
    withdrawalPending: Boolean(
      settlement?.actions.some(action => action.type === 'r2e' && action.tokenId === 1) ||
      [batch?.batch, batch?.sentBatch?.batch].some(candidate =>
        candidate?.reserveToExternalToken.some(action => action.tokenId === 1),
      ),
    ),
    batchStatus: batch?.status ?? null,
    route: route
      ? {
          status: route.status,
          routeHash: route.routeHash ?? null,
          ...getCrossJurisdictionRouteRemainingAmounts(route),
        }
      : null,
  };
};

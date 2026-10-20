import { useMemo } from 'react';
import {
  getDefaultSwapTradingPairs,
  getSwapPairOrientation,
  getTokenIdsForJurisdiction,
  getTokenInfo,
  isLiquidSwapToken,
} from '@xln/core/account/utils';
import { buildRoutedRoutePaths } from '@xln/frontend/lib/components/Entity/routed-swap-planner';

export function ManualSwapRoutes(props: {
  sourceHubId: string;
  targetHubId: string;
  sourceStack: string;
  targetStack: string;
  sourceNetwork: string;
  targetNetwork: string;
  sourceToken: number;
  targetToken: number;
}) {
  const routes = useMemo(() => {
    const targetTokens = new Set(getTokenIdsForJurisdiction(props.targetNetwork));
    return buildRoutedRoutePaths({
      mode: 'cross',
      target: {
        targetHubEntityId: props.targetHubId,
        targetJurisdiction: props.targetNetwork,
        targetJurisdictionRef: props.targetStack,
      },
      sourceHubId: props.sourceHubId,
      sourceJurisdictionRef: props.sourceStack,
      sourceJurisdiction: props.sourceNetwork,
      sourceToken: props.sourceToken,
      targetToken: props.targetToken,
      allowedSwapTokenIds: getTokenIdsForJurisdiction(props.sourceNetwork).filter(id => targetTokens.has(id)),
      resolvePairOrientation: getSwapPairOrientation,
      // The canonical pair catalog describes possible steps, never available liquidity.
      tradingPairsForHub: getDefaultSwapTradingPairs,
      isLiquidToken: isLiquidSwapToken,
      tokenSymbol: id => getTokenInfo(id).symbol,
      compareStableText: (a, b) => (a < b ? -1 : a > b ? 1 : 0),
    })
      .filter(route => route.hops.length > 1 && route.id !== 'direct-cross')
      .slice(0, 3);
  }, [
    props.sourceHubId,
    props.targetHubId,
    props.sourceStack,
    props.targetStack,
    props.sourceNetwork,
    props.targetNetwork,
    props.sourceToken,
    props.targetToken,
  ]);
  if (routes.length === 0) return null;
  return (
    <section className="card" data-testid="swap-route-recommendation">
      <h3 className="caps">Possible manual routes</h3>
      <p className="note">
        No direct quote available. Quote and complete each step separately; liquidity is unverified.
      </p>
      {routes.map(route => (
        <p
          key={route.id}
          data-testid="swap-route-recommendation-row"
          data-route-id={route.id}
          data-hop-count={route.hops.length}
        >
          {route.label}
        </p>
      ))}
    </section>
  );
}

/** Market-maker node facade and executable entry point. */
export {
  buildMarketMakerCrossOfferSpecs,
  buildMarketMakerOfferSpecs,
  fitCrossAmountsToOrderbook,
  hasFinalizedMarketMakerCrossOffer,
  readVisibleHubProfiles,
  waitForJurisdictionAdapter,
  type HubProfile,
  type MarketMakerEntityContext,
  type MarketMakerHealth,
  type MarketMakerOfferSpec,
  type MarketMakerTokenIdsByContext,
} from './mm-node-core';
export {
  buildMarketMakerBootstrapEntityStateHash,
  buildMarketMakerBootstrapFingerprint,
  buildMarketMakerCrossHealth,
  getMarketMakerHealth,
} from './mm-node-health';
import { resetMeshJurisdictionsCache } from './mesh-jurisdictions';
import { runMarketMakerNode } from './mm-node-run';

if (import.meta.main) {
  resetMeshJurisdictionsCache();
  runMarketMakerNode().catch(error => {
    console.error('[MESH-MM] FAILED:', (error as Error).stack || (error as Error).message);
    process.exit(1);
  });
}

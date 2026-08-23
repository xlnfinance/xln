/** Market-maker node facade and executable entry point. */
export {
  buildMarketMakerCrossOfferSpecs,
  buildMarketMakerOfferSpecs,
  deriveMarketMakerCrossExpiryAt,
  fitCrossAmountsToOrderbook,
  hasFinalizedMarketMakerCrossOffer,
  readVisibleHubProfiles,
  waitForJurisdictionAdapter,
  type HubProfile,
  type MarketMakerEntityContext,
  type MarketMakerHealth,
  type MarketMakerTokenIdsByContext,
} from './market-maker/node/mm-node-core';
export {
  buildMarketMakerBootstrapFingerprint,
  buildMarketMakerCrossHealth,
  getMarketMakerHealth,
} from './market-maker/node/mm-node-health';
import { resetMeshJurisdictionsCache } from './mesh/mesh-jurisdictions';
import { runMarketMakerNode } from './market-maker/node/mm-node-run';
import { configureCryptoPoolEntry } from '../protocol/crypto/crypto-pool';

// Bun host: the crypto worker pool needs this module URL (shared core cannot spell import.meta).
configureCryptoPoolEntry(new URL('../protocol/crypto/crypto-pool.ts', import.meta.url));

if (import.meta.main) {
  resetMeshJurisdictionsCache();
  runMarketMakerNode().catch(error => {
    console.error('[MESH-MM] FAILED:', (error as Error).stack || (error as Error).message);
    process.exit(1);
  });
}

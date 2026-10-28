import { haltRuntimeFailure } from '../../protocol/errors/failure-taxonomy';
import { BLOCKCHAIN, TIMING } from '../../config/constants';
import type { CrossJurisdictionSwapRoute } from '../../types/cross-jurisdiction';

// Configured testnet delivery bounds, seconds. Admission assumes these bounds;
// cross-chain safety requires these bounds; they never authorize extending signed D.
const CROSS_J_DELIVERY_BOUNDS = {
  finality: BLOCKCHAIN.CONFIRMATION_BLOCKS * 12,
  observation: BLOCKCHAIN.J_WATCHER_POLL_INTERVAL_MS / 1000,
  inclusion: 2 * 12,
  clockSkew: (2 * TIMING.TIMESTAMP_DRIFT_MS) / 1000,
} as const;
// Hub holds the ladder and can start either dispute. D_source + 233 <= D_target
// leaves 144s finality + 5s observation + 24s Target inclusion + 60s relative
// clock skew after the last valid Source reveal. Target publication is standalone,
// independent of dispute starts and every pending processBatch nonce/ACK.
export const CROSS_J_LEG_MARGIN = Object.values(CROSS_J_DELIVERY_BOUNDS).reduce((sum, seconds) => sum + seconds, 0);

export const crossJDeadlines = (route: Pick<CrossJurisdictionSwapRoute, 'expiresAt'>) => {
  const expiry = route.expiresAt;
  if (typeof expiry !== 'number' || !Number.isSafeInteger(expiry) || expiry < 1000)
    throw haltRuntimeFailure('CROSS_J_DEADLINE_MISSING', 'CROSS_J_DEADLINE_MISSING');
  const source = Math.floor(expiry / 1000);
  return { source, target: source + CROSS_J_LEG_MARGIN };
};

export const assertCrossJDeadlines = (route: CrossJurisdictionSwapRoute): void => {
  const deadlines = crossJDeadlines(route);
  if (!route.sourcePull && !route.targetPull) return;
  const source = route.sourcePull?.deadline;
  const target = route.targetPull?.deadline;
  if (source !== deadlines.source || target !== deadlines.target || source + CROSS_J_LEG_MARGIN > target) {
    throw haltRuntimeFailure('CROSS_J_DEADLINE_ORDER', 'CROSS_J_DEADLINE_ORDER');
  }
};

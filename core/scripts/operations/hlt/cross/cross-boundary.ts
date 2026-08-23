/** Exact cross-j route projection from the committed Hub entity view. */

import { validateEntityTx } from '../../../../entity/tx-validation';
import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../../../../protocol/boundary-validation';
import type { CrossJurisdictionSwapRoute } from '../../../../types/cross-jurisdiction';
import { decodeHubCoreRecord, type LoadFrame } from '../boundary/worker-boundary';
import { decodeHltEnvironmentManifest, type HltEnvironmentManifest } from '../boundary/environment-manifest';

export type CrossLoadReport = Readonly<{
  schema: 'xln-production-cross-swap-load-v1';
  mode: 'cross';
  configuredBurstSize: number;
  configuredRounds: number;
  settledRoutes: number;
  /** settled routes / wall time from burst submission to the last committed full fill. */
  economicTps: number;
  completionAuthority: 'committed_cross_route_full_fill';
  marketMakerOrderId: string;
  loadOrderId: string;
  sourceAmount: string;
  targetAmount: string;
  routeStatus: 'settled';
  enqueueAckElapsedMs: number;
  commandObservedElapsedMs: number;
  economicCompletionElapsedMs: number;
  hubWalBytesBefore: number;
  hubWalBytesAfter: number;
  loadWalBytesBefore: number;
  loadWalBytesAfter: number;
  hubDurableBefore: LoadFrame;
  hubDurableAfter: LoadFrame;
  loadDurableBefore: LoadFrame;
  loadDurableAfter: LoadFrame;
  environment: HltEnvironmentManifest;
}>;

const requireText = (value: unknown, code: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(code);
  return value.trim();
};

const decodeReportFrame = (value: unknown): LoadFrame => {
  const frame = requireBoundaryRecord(value, 'PRODUCTION_SWAP_LOAD_CROSS_REPORT_FRAME_INVALID');
  requireExactBoundaryKeys(frame, ['height', 'canonicalStateHash'], [], 'PRODUCTION_SWAP_LOAD_CROSS_REPORT_FRAME_FIELDS_INVALID');
  const canonicalStateHash = requireText(frame['canonicalStateHash'], 'PRODUCTION_SWAP_LOAD_CROSS_REPORT_FRAME_ROOT_INVALID');
  if (!/^0x[0-9a-f]{64}$/.test(canonicalStateHash)) throw new Error('PRODUCTION_SWAP_LOAD_CROSS_REPORT_FRAME_ROOT_INVALID');
  return {
    height: requireBoundaryInteger(frame['height'], 'PRODUCTION_SWAP_LOAD_CROSS_REPORT_FRAME_HEIGHT_INVALID', 1),
    canonicalStateHash,
  };
};

export const decodeCrossLoadReport = (value: unknown): CrossLoadReport => {
  const report = requireBoundaryRecord(value, 'PRODUCTION_SWAP_LOAD_CROSS_REPORT_INVALID');
  requireExactBoundaryKeys(report, [
    'schema', 'mode', 'configuredBurstSize', 'configuredRounds', 'settledRoutes', 'economicTps', 'completionAuthority', 'marketMakerOrderId',
    'loadOrderId', 'sourceAmount', 'targetAmount', 'routeStatus', 'enqueueAckElapsedMs',
    'commandObservedElapsedMs', 'economicCompletionElapsedMs', 'hubWalBytesBefore',
    'hubWalBytesAfter', 'loadWalBytesBefore', 'loadWalBytesAfter', 'hubDurableBefore',
    'hubDurableAfter', 'loadDurableBefore', 'loadDurableAfter', 'environment',
  ], [], 'PRODUCTION_SWAP_LOAD_CROSS_REPORT_FIELDS_INVALID');
  if (
    report['schema'] !== 'xln-production-cross-swap-load-v1' ||
    report['mode'] !== 'cross' ||
    report['completionAuthority'] !== 'committed_cross_route_full_fill' ||
    report['routeStatus'] !== 'settled'
  ) throw new Error('PRODUCTION_SWAP_LOAD_CROSS_REPORT_SCHEMA_INVALID');
  const numeric = [
    'enqueueAckElapsedMs', 'commandObservedElapsedMs', 'economicCompletionElapsedMs',
    'hubWalBytesBefore', 'hubWalBytesAfter', 'loadWalBytesBefore', 'loadWalBytesAfter',
  ] as const;
  for (const field of numeric) requireBoundaryInteger(report[field], `PRODUCTION_SWAP_LOAD_CROSS_REPORT_${field}`);
  const configuredBurstSize = requireBoundaryInteger(report['configuredBurstSize'], 'PRODUCTION_SWAP_LOAD_CROSS_REPORT_BURST', 1);
  const configuredRounds = requireBoundaryInteger(report['configuredRounds'], 'PRODUCTION_SWAP_LOAD_CROSS_REPORT_ROUNDS', 1);
  const settledRoutes = requireBoundaryInteger(report['settledRoutes'], 'PRODUCTION_SWAP_LOAD_CROSS_REPORT_SETTLED', 0);
  // Every round settles between one route (partial maker replenishment) and
  // the full burst; anything outside that envelope means dropped settlements.
  if (settledRoutes < configuredRounds || settledRoutes > configuredBurstSize * configuredRounds) {
    throw new Error('PRODUCTION_SWAP_LOAD_CROSS_REPORT_BURST_INCOMPLETE');
  }
  const economicTps = report['economicTps'];
  if (typeof economicTps !== 'number' || !Number.isFinite(economicTps) || economicTps < 0) {
    throw new Error('PRODUCTION_SWAP_LOAD_CROSS_REPORT_TPS_INVALID');
  }
  const enqueueAckElapsedMs = Number(report['enqueueAckElapsedMs']);
  const commandObservedElapsedMs = Number(report['commandObservedElapsedMs']);
  const economicCompletionElapsedMs = Number(report['economicCompletionElapsedMs']);
  if (enqueueAckElapsedMs > commandObservedElapsedMs || commandObservedElapsedMs > economicCompletionElapsedMs) {
    throw new Error('PRODUCTION_SWAP_LOAD_CROSS_REPORT_TIMING_INVALID');
  }
  return {
    schema: report['schema'], mode: report['mode'], configuredBurstSize, configuredRounds, settledRoutes, economicTps,
    completionAuthority: report['completionAuthority'],
    marketMakerOrderId: requireText(report['marketMakerOrderId'], 'PRODUCTION_SWAP_LOAD_CROSS_REPORT_MM_ORDER_INVALID'),
    loadOrderId: requireText(report['loadOrderId'], 'PRODUCTION_SWAP_LOAD_CROSS_REPORT_LOAD_ORDER_INVALID'),
    sourceAmount: requireText(report['sourceAmount'], 'PRODUCTION_SWAP_LOAD_CROSS_REPORT_SOURCE_AMOUNT_INVALID'),
    targetAmount: requireText(report['targetAmount'], 'PRODUCTION_SWAP_LOAD_CROSS_REPORT_TARGET_AMOUNT_INVALID'),
    routeStatus: report['routeStatus'], enqueueAckElapsedMs, commandObservedElapsedMs,
    economicCompletionElapsedMs,
    hubWalBytesBefore: Number(report['hubWalBytesBefore']), hubWalBytesAfter: Number(report['hubWalBytesAfter']),
    loadWalBytesBefore: Number(report['loadWalBytesBefore']), loadWalBytesAfter: Number(report['loadWalBytesAfter']),
    hubDurableBefore: decodeReportFrame(report['hubDurableBefore']),
    hubDurableAfter: decodeReportFrame(report['hubDurableAfter']),
    loadDurableBefore: decodeReportFrame(report['loadDurableBefore']),
    loadDurableAfter: decodeReportFrame(report['loadDurableAfter']),
    environment: decodeHltEnvironmentManifest(report['environment'], 'PRODUCTION_SWAP_LOAD_CROSS_REPORT_ENVIRONMENT'),
  };
};

const isLiveRoute = (route: CrossJurisdictionSwapRoute): boolean =>
  route.status === 'resting' || route.status === 'partially_filled';

export const decodeCommittedCrossRoutes = (value: unknown): CrossJurisdictionSwapRoute[] => {
  const core = decodeHubCoreRecord(value);
  const rawRoutes = core['crossJurisdictionSwaps'];
  if (!(rawRoutes instanceof Map)) {
    throw new Error('PRODUCTION_SWAP_LOAD_CROSS_ROUTES_INVALID');
  }
  const routes: CrossJurisdictionSwapRoute[] = [];
  for (const [key, rawRoute] of rawRoutes) {
    if (typeof key !== 'string' || !key) {
      throw new Error('PRODUCTION_SWAP_LOAD_CROSS_ROUTE_KEY_INVALID');
    }
    const tx = validateEntityTx({
      type: 'prepareCrossJurisdictionSwap',
      data: { route: rawRoute },
    }, `PRODUCTION_SWAP_LOAD_CROSS_ROUTE_INVALID:${key}`);
    if (tx.type !== 'prepareCrossJurisdictionSwap' || tx.data.route.orderId !== key) {
      throw new Error(`PRODUCTION_SWAP_LOAD_CROSS_ROUTE_ID_MISMATCH:${key}`);
    }
    routes.push(tx.data.route);
  }
  return routes;
};

export const selectMarketMakerCrossRoutes = (
  routes: readonly CrossJurisdictionSwapRoute[],
  sourceHubEntityId: string,
  targetHubEntityId: string,
): CrossJurisdictionSwapRoute[] => {
  const sourceHub = sourceHubEntityId.toLowerCase();
  const targetHub = targetHubEntityId.toLowerCase();
  const matches = routes.filter(route =>
    isLiveRoute(route) &&
    route.orderId.startsWith('mmx-') &&
    route.source.counterpartyEntityId.toLowerCase() === sourceHub &&
    route.target.entityId.toLowerCase() === targetHub
  );
  if (matches.length === 0) throw new Error('PRODUCTION_SWAP_LOAD_CROSS_MM_ROUTE_MISSING');
  return matches.slice().sort((left, right) => {
    const leftPrice = left.priceTicks ?? 0n;
    const rightPrice = right.priceTicks ?? 0n;
    if (leftPrice !== rightPrice) return leftPrice < rightPrice ? -1 : 1;
    return left.orderId.localeCompare(right.orderId);
  });
};

export const selectMarketMakerCrossRoute = (
  routes: readonly CrossJurisdictionSwapRoute[],
  sourceHubEntityId: string,
  targetHubEntityId: string,
): CrossJurisdictionSwapRoute =>
  selectMarketMakerCrossRoutes(routes, sourceHubEntityId, targetHubEntityId)[0]!;

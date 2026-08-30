/** Native Rust H1 settlement authority for the real HLT. */

import { safeStringify } from "../../../../protocol/serialization";
import { parseProfile } from "../../../../entity/profile";
import { decodeMarketSnapshotPayload } from "../../../../network/relay/market/wire";
import type { LoadBookSnapshot } from "../boundary/worker-book-boundary";
import type { HubSettlementCounters } from "../boundary/worker-boundary";
import type { PaymentSettlementSample } from "../boundary/worker-payment-boundary";
import {
  configureLanePopulationP2P,
  readLaneQuiescence,
  waitForLaneHostReadiness,
  waitForLaneQuiescence,
  type LaneQuiescence,
  type LaneRuntime,
} from "../lanes/lane-runtimes";
import {
  attachRustH1,
  diffRustH1EconomicMetrics,
  fetchNativeJson,
  type RustH1Handle,
  type RustH1EconomicPhaseMetrics,
  type RustH1Metrics,
} from "./rust-h1";

/** Preserve every baseline production session while proving all load users fit inside it. */
export const rustH1SessionPopulationIntact = (
  current: number,
  baseline: number,
  loadUsers: number,
): boolean => current === baseline && current >= loadUsers;

/** Read the same bounded market projection used by TS clients, directly from native H1. */
export const readRustH1LoadBook = async (options: Readonly<{
  portBase: number;
  entityId: string;
  pairId: string;
}>): Promise<LoadBookSnapshot> => {
  const apiBase = `http://127.0.0.1:${String(options.portBase + 10)}`;
  const query = new URLSearchParams({
    hubEntityId: options.entityId,
    pair: options.pairId,
    depth: '100',
  });
  const raw = await fetchNativeJson(`${apiBase}/api/market/snapshots?${query.toString()}`);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('HLT_RUST_H1_MARKET_RESPONSE_INVALID');
  }
  const rows = (raw as Record<string, unknown>)['snapshots'];
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error(`HLT_RUST_H1_MARKET_SNAPSHOT_CARDINALITY:${Array.isArray(rows) ? rows.length : -1}`);
  }
  const snapshot = decodeMarketSnapshotPayload(rows[0]);
  if (snapshot.hubEntityId !== options.entityId || snapshot.pairId !== options.pairId) {
    throw new Error(`HLT_RUST_H1_MARKET_IDENTITY:${snapshot.hubEntityId}:${snapshot.pairId}`);
  }
  if (snapshot.asks.length === 0) throw new Error('PRODUCTION_SWAP_LOAD_MM_ASK_MISSING');
  const asks = snapshot.asks.map(level => ({
    priceTicks: BigInt(level.price),
    qtyLots: BigInt(level.size),
  }));
  const visibleOrders = (levels: typeof snapshot.asks): number => levels.reduce(
    (sum, level) => sum + (level.orderCount ?? level.orderIds?.length ?? 0),
    0,
  );
  return {
    tradeCount: snapshot.tradeCount,
    bestBidPriceTicks: snapshot.bids[0] ? BigInt(snapshot.bids[0].price) : null,
    bestAskPriceTicks: asks[0]!.priceTicks,
    executableAskPriceTicks: asks.map(level => level.priceTicks),
    executableAsks: asks,
    visibleBidOrders: visibleOrders(snapshot.bids),
    visibleAskOrders: visibleOrders(snapshot.asks),
  };
};

export const decodeNativeProfileResponse = (payload: unknown, entityId: string) => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("HLT_RUST_H1_PROFILE_RESPONSE_INVALID");
  }
  const bundle = payload as Record<string, unknown>;
  if (
    bundle["ok"] !== true || bundle["found"] !== true ||
    String(bundle["entityId"] || "").toLowerCase() !== entityId.toLowerCase() ||
    !Array.isArray(bundle["peers"])
  ) throw new Error(`HLT_RUST_H1_PROFILE_NOT_FOUND:${entityId}:${safeStringify(payload)}`);
  return parseProfile(bundle["profile"]);
};

const fetchNativeProfile = async (apiBase: string, entityId: string) => {
  const response = await fetch(
    `${apiBase}/api/gossip/profile?entityId=${encodeURIComponent(entityId)}`,
  );
  const payload: unknown = await response.json();
  if (!response.ok) {
    throw new Error(`HLT_RUST_H1_PROFILE_REJECTED:${response.status}:${safeStringify(payload)}`);
  }
  return decodeNativeProfileResponse(payload, entityId);
};

/** Connect load lanes to the already-running canonical native H1. */
export const connectRustH1 = async (options: Readonly<{
  portBase: number;
  lanes: readonly LaneRuntime[];
  expectedRuntimeId: string;
  expectedEntityId: string;
}>): Promise<RustH1Handle> => {
  const apiBase = `http://127.0.0.1:${String(options.portBase + 10)}`;
  const rust = await attachRustH1(apiBase);
  if (rust.ready.runtimeId !== options.expectedRuntimeId.toLowerCase()) {
    await rust.stop();
    throw new Error(
      `HLT_RUST_H1_RUNTIME_ID_DRIFT:${options.expectedRuntimeId}:${rust.ready.runtimeId}`,
    );
  }
  const profile = await fetchNativeProfile(apiBase, options.expectedEntityId);
  await configureLanePopulationP2P(options.lanes, { announceProfiles: true });
  const readyBudgetMs = Math.max(5_000, Math.ceil(options.lanes.length / 500) * 1_200);
  await waitForLaneHostReadiness(
    options.lanes,
    options.expectedEntityId,
    rust.ready.runtimeId,
    readyBudgetMs,
    profile,
  );
  return rust;
};

export type RustPaymentSettlement = Readonly<{
  counters: HubSettlementCounters;
  hubIngressElapsedMs: number;
  deliveredElapsedMs: number;
  settlementSamples: readonly PaymentSettlementSample[];
  metrics: RustH1Metrics;
  economicPhaseMetrics: RustH1EconomicPhaseMetrics;
  laneQuiescence: LaneQuiescence;
}>;

export type RustMixedSettlement = Readonly<{
  metrics: RustH1Metrics;
  economicPhaseMetrics: RustH1EconomicPhaseMetrics;
  laneQuiescence: LaneQuiescence;
  hubIngressElapsedMs: number;
  deliveredElapsedMs: number;
  matchedElapsedMs: number;
  fullySettledElapsedMs: number;
}>;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export const waitForRustPaymentSettlement = async (options: Readonly<{
  rust: RustH1Handle;
  lanes: readonly LaneRuntime[];
  expectedPayments: number;
  economicStartedAt: number;
  metricsBefore: RustH1Metrics;
}>): Promise<RustPaymentSettlement> => {
  const deadline = Date.now() + 20_000;
  const economicStartedAtUnixMicros = Math.floor(
    (performance.timeOrigin + options.economicStartedAt) * 1_000,
  );
  const nativeElapsedMs = (finishedAtUnixMicros: number, field: string): number => {
    if (finishedAtUnixMicros < economicStartedAtUnixMicros) {
      throw new Error(
        `HLT_RUST_PAYMENT_TIMESTAMP_INVALID:${field}:` +
        `started=${economicStartedAtUnixMicros}:finished=${finishedAtUnixMicros}`,
      );
    }
    return Math.max(1, Math.ceil((finishedAtUnixMicros - economicStartedAtUnixMicros) / 1_000));
  };
  const samples: PaymentSettlementSample[] = [];
  let previous = '';
  while (Date.now() <= deadline) {
    const metrics = options.rust.metrics();
    if (metrics) {
      if (metrics.acceptedPayments > options.expectedPayments || metrics.completedPayments > options.expectedPayments) {
        throw new Error(`HLT_RUST_PAYMENT_COUNT_OVERFLOW:${safeStringify(metrics)}`);
      }
      if (metrics.queueRejections > 0 || metrics.outboxFailures > 0) {
        throw new Error(`HLT_RUST_PAYMENT_TRANSPORT_REJECTED:${safeStringify(metrics)}`);
      }
      const fingerprint = `${metrics.height}:${metrics.acceptedPayments}:${metrics.completedPayments}:${metrics.paybookOpen}`;
      if (fingerprint !== previous && (metrics.acceptedPayments > 0 || metrics.completedPayments > 0)) {
        previous = fingerprint;
        const acceptedElapsedMs = metrics.acceptedPayments > 0
          ? nativeElapsedMs(metrics.lastAcceptedAtUnixMicros, 'lastAcceptedAtUnixMicros')
          : 1;
        const completedElapsedMs = metrics.completedPayments > 0
          ? nativeElapsedMs(metrics.lastCompletedAtUnixMicros, 'lastCompletedAtUnixMicros')
          : 1;
        // Rust metrics are emitted periodically, but the sample timeline is
        // economic time. Pin the two authority milestones to their native
        // commit timestamps; using poll time here made a valid 1000/1000 run
        // fail its own report after the zero-loss gate had already passed.
        const elapsedMs = metrics.completedPayments === options.expectedPayments
          ? completedElapsedMs
          : metrics.acceptedPayments === options.expectedPayments
            ? acceptedElapsedMs
            : Math.max(acceptedElapsedMs, completedElapsedMs);
        samples.push({
          elapsedMs,
          runtimeHeight: metrics.height,
          acceptedPayments: metrics.acceptedPayments,
          completedPayments: metrics.completedPayments,
          paybookOpen: metrics.paybookOpen,
        });
      }
      if (
        metrics.acceptedPayments === options.expectedPayments &&
        metrics.completedPayments === options.expectedPayments &&
        metrics.paybookOpen === 0 &&
        metrics.outboxTargetsPending === 0 &&
        metrics.outboxRowsPending === 0 &&
        metrics.outboxBytesPending === 0 &&
        // `openSessions` includes pre-existing production peers (the market
        // maker in mixed HLT), not only load users. The baseline is captured
        // after all 5,000 sovereign users connect, so preserving that exact
        // count proves H1 lost no authenticated session; lane quiescence below
        // independently proves all 5,000 user peers remain open.
        rustH1SessionPopulationIntact(
          metrics.openSessions,
          options.metricsBefore.openSessions,
          options.lanes.length,
        )
      ) {
        const finalSample = samples.at(-1);
        if (!finalSample) throw new Error('HLT_RUST_PAYMENT_SAMPLE_MISSING');
        const laneQuiescence = await waitForLaneQuiescence(options.lanes, options.rust.ready.runtimeId, 5_000);
        return {
          counters: {
            height: metrics.height,
            paybookOpen: metrics.paybookOpen,
            paybookFeesEarned: BigInt(metrics.paybookFeesEarned),
            acceptedPayments: metrics.acceptedPayments,
            completedPayments: metrics.completedPayments,
            matchedSwaps: 0,
            metricsRuntimeHeight: metrics.height,
          },
          // Metrics emission is periodic. Native timestamps are captured in
          // the exact committed frame, so a 100 ms telemetry window cannot
          // turn a 100 ms economic phase into a fake 200 ms result.
          hubIngressElapsedMs: nativeElapsedMs(
            metrics.lastAcceptedAtUnixMicros,
            'lastAcceptedAtUnixMicros',
          ),
          deliveredElapsedMs: nativeElapsedMs(
            metrics.lastCompletedAtUnixMicros,
            'lastCompletedAtUnixMicros',
          ),
          settlementSamples: samples,
          metrics,
          economicPhaseMetrics: diffRustH1EconomicMetrics(options.metricsBefore, metrics),
          laneQuiescence,
        };
      }
    }
    await sleep(20);
  }
  throw new Error(`HLT_RUST_PAYMENT_NOT_DELIVERED:${safeStringify(options.rust.metrics())}`);
};

/**
 * Rust-native mixed drain authority. Swap commands may terminate as matched,
 * rejected/cancelled, or resting; the caller proves that exact partition from
 * the per-offer RAM ledger after this function proves both sides are idle.
 */
export const waitForRustMixedSettlement = async (options: Readonly<{
  rust: RustH1Handle;
  lanes: readonly LaneRuntime[];
  expectedPayments: number;
  expectedMatchedSwaps: number;
  economicStartedAt: number;
  metricsBefore: RustH1Metrics;
}>): Promise<RustMixedSettlement> => {
  // The owner explicitly grants one additional 20-second drain window for
  // the 5,000-user mixed authority run. This changes only the fail deadline;
  // TPS still uses the exact native commit timestamps below.
  const deadline = Date.now() + 40_000;
  const startedUnixMicros = Math.floor((performance.timeOrigin + options.economicStartedAt) * 1_000);
  const elapsed = (finishedUnixMicros: number, field: string): number => {
    if (finishedUnixMicros < startedUnixMicros) {
      throw new Error(`HLT_RUST_MIXED_TIMESTAMP_INVALID:${field}:${startedUnixMicros}:${finishedUnixMicros}`);
    }
    return Math.max(1, Math.ceil((finishedUnixMicros - startedUnixMicros) / 1_000));
  };
  while (Date.now() <= deadline) {
    const metrics = options.rust.metrics();
    if (metrics) {
      const accepted = metrics.acceptedPayments - options.metricsBefore.acceptedPayments;
      const completed = metrics.completedPayments - options.metricsBefore.completedPayments;
      const matched = metrics.matchedSwaps - options.metricsBefore.matchedSwaps;
      const trades = metrics.orderbookTradeCount - options.metricsBefore.orderbookTradeCount;
      if (
        accepted < 0 || completed < 0 || matched < 0 || trades < 0 ||
        accepted > options.expectedPayments || completed > options.expectedPayments ||
        matched > options.expectedMatchedSwaps || trades > options.expectedMatchedSwaps
      ) throw new Error(`HLT_RUST_MIXED_COUNT_OVERFLOW:${safeStringify(metrics)}`);
      if (metrics.queueRejections > options.metricsBefore.queueRejections || metrics.outboxFailures > 0) {
        throw new Error(`HLT_RUST_MIXED_TRANSPORT_REJECTED:${safeStringify(metrics)}`);
      }
      if (
        accepted === options.expectedPayments &&
        completed === options.expectedPayments &&
        matched === trades &&
        metrics.paybookOpen === options.metricsBefore.paybookOpen &&
        metrics.openBookOrders === metrics.openSwapOffers &&
        metrics.resolvingSwapOffers === options.metricsBefore.resolvingSwapOffers &&
        metrics.pendingBatches === 0 &&
        metrics.activeShards === 0 &&
        metrics.entityTxsPending === 0 &&
        metrics.outboxTargetsPending === 0 &&
        metrics.outboxRowsPending === 0 &&
        metrics.outboxBytesPending === 0 &&
        rustH1SessionPopulationIntact(
          metrics.openSessions,
          options.metricsBefore.openSessions,
          options.lanes.length,
        )
      ) {
        const laneQuiescence = await waitForLaneQuiescence(
          options.lanes,
          options.rust.ready.runtimeId,
          5_000,
        );
        // A quiet lane can have just flushed its final socket bytes. Re-read
        // the economic counters and queues after that scan before partitioning
        // terminal offers. Do not require an identical Runtime height or
        // accepted-batch count: committed crontab wakes legitimately advance
        // an otherwise economically idle H1 and made this drain gate
        // impossible to satisfy.
        await sleep(50);
        const stable = options.rust.metrics();
        if (
          !stable ||
          stable.matchedSwaps !== metrics.matchedSwaps ||
          stable.zeroFillSwapCancels !== metrics.zeroFillSwapCancels ||
          stable.openSwapOffers !== metrics.openSwapOffers ||
          stable.resolvingSwapOffers !== metrics.resolvingSwapOffers ||
          stable.pendingBatches !== 0 || stable.activeShards !== 0 ||
          stable.entityTxsPending !== 0 || stable.outboxRowsPending !== 0 ||
          stable.outboxBytesPending !== 0
        ) continue;
        const deliveredElapsedMs = elapsed(stable.lastCompletedAtUnixMicros, 'lastCompletedAtUnixMicros');
        const matchedElapsedMs = elapsed(stable.lastMatchedAtUnixMicros, 'lastMatchedAtUnixMicros');
        return {
          metrics: stable,
          economicPhaseMetrics: diffRustH1EconomicMetrics(options.metricsBefore, stable),
          laneQuiescence,
          hubIngressElapsedMs: elapsed(stable.lastAcceptedAtUnixMicros, 'lastAcceptedAtUnixMicros'),
          deliveredElapsedMs,
          matchedElapsedMs,
          fullySettledElapsedMs: Math.max(
            deliveredElapsedMs,
            matchedElapsedMs,
            Math.ceil(performance.now() - options.economicStartedAt),
          ),
        };
      }
    }
    await sleep(20);
  }
  const laneQuiescence = await readLaneQuiescence(options.lanes, options.rust.ready.runtimeId);
  throw new Error(`HLT_RUST_MIXED_NOT_SETTLED:${safeStringify({
    metrics: options.rust.metrics(),
    laneQuiescence,
  })}`);
};

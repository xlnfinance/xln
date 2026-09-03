/**
 * Routed payment workload: every user Runtime pays a different user every
 * round, through the Hub.
 *
 * Payments are the other half of the economy the swap workload measures, and
 * they stress a different part of the Hub: two bilateral Accounts move per
 * payment instead of one book match, and the secret returns along the same
 * route. Senders and receivers are separate processes with their own seeds,
 * key stores and relay sessions, so every hop crosses the real P2P path.
 */

import { collectHltEnvironmentManifest, isProductionEquivalentHltEnvironment } from '../boundary/environment-manifest';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { decodeSettlementEvidenceResponse } from '../../../../api/runtime-adapter/control/settlement-evidence';
import { safeStringify } from '../../../../protocol/serialization';
import type { RuntimeInput } from '../../../../runtime/types';
import type { EntityTx } from '../../../../types/entity-tx';
import {
  decodeEntitySummaries,
  decodeHubSettlementCounters,
  decodeLoadFrame,
  decodeRuntimeManifestEntries,
  selectLocalHubIdentity,
  type LoadIdentity,
  type HubSettlementCounters,
} from '../boundary/worker-boundary';
import {
  assertHltWalAdvanced,
  decodeLoadPaymentReport,
  type PaymentSettlementSample,
} from '../boundary/worker-payment-boundary';
import { publishHltDashboardPerfFromWorkDir, publishHltDashboardReport } from '../../../../qa/hlt/hlt-dashboard';
import {
  HLT_FAUCET_AMOUNT,
  provisionParallelLoadLaneAccounts,
  setupParallelLoadLanes,
  spawnParallelLoadLanes,
} from '../lanes/worker-lanes';
import {
  queueLaneRuntimeInputWave,
  assertLaneHostSocketCounterCoverage,
  readLaneHostPaymentOperationLedgers,
  readLaneRouteReadiness,
  resetLaneHostOpCounters,
  stopLaneRuntimes,
  waitForLaneQuiescence,
  type LaneRuntime,
} from '../lanes/lane-runtimes';
import {
  connectRuntime,
  directoryBytes,
  entryByLabel,
  exportReplayBaseSnapshotIfConfigured,
  persistReport,
  readWithRateLimitRetry,
  resetHltProcessOpCounters,
  assertHltHubProcessIsolation,
  stopHltHubBackgroundIo,
  resolveWalPath,
  type ConnectedRuntime,
  type WorkerArgs,
} from '../worker-runtime';
import { HLT_DEFAULT_PAYMENT_AMOUNT_RANGE, type HltAmountRange } from '../economy';
import {
  paymentAmountFor,
  paymentReceiverIndexSamePopulation,
  paymentTotalForSender,
} from './worker-payments-plan';
import { buildPacedOperationSchedule } from './operation-pacer';
import { hltWorkloadFingerprint } from './workload-fingerprint';
import {
  attachRustH1,
  classifyHltLivePaymentRun,
  hltLivePaymentRateEvidence,
  parseHltEngineSelection,
  summarizeRustH1WorkerExecution,
  type RustH1Handle,
  type RustH1Metrics,
} from '../rust/rust-h1';
import {
  connectRustH1,
  rustH1SessionPopulationReady,
  waitForRustPaymentSettlement,
} from '../rust/rust-h1-settlement';
import { runRustH1DisputeSmoke } from '../rust/rust-h1-dispute-smoke';
import {
  runRustH1AccountSettlementSmoke,
  shouldRunRustH1AccountSettlementSmoke,
} from '../rust/rust-h1-account-settlement-smoke';
import type {
  AccountDeliveryHop,
  HltPaymentOperationLedgerSnapshot,
} from '../../../../support/performance/account-delivery-trace';
import { assertHltW4ReleaseTpsFloor } from '../metrics';

/** Payments move the quote token; the swap workload owns the base token. */
export const PAYMENT_TOKEN_ID = 1;
/**
 * Routing fees are quoted from live gossip at admission time, so the sender
 * declares a ceiling rather than the exact debit. Two times the amount covers
 * any sane single-hop fee and is still bounded by the granted credit.
 */
const MAX_SENDER_DEBIT_MULTIPLE = 2n;
/** Credit headroom over the exact total, so a fee cannot starve the last round. */
export const CREDIT_HEADROOM_MULTIPLE = 4n;
const DELIVERY_POLL_MS = 250;
// Overridable: 20s covers the 5s smoke; the ≥110-frame authority-evidence
// recording pushes 10-20k payments through the same gate and needs minutes.
const DELIVERY_TIMEOUT_MS = Number(process.env['XLN_HLT_DELIVERY_TIMEOUT_MS'] || 0) || 20_000;

export const shouldRunRustH1DisputeSmoke = (options: Readonly<{
  requested: string | undefined;
  engine: 'ts' | 'rust';
  evidence: 'functional-smoke' | 'tps-authority' | null;
  users: number;
  payments: number;
  offeredPerSecond: number;
  durationSeconds: number;
}>): boolean => {
  if (options.requested === undefined || options.requested === '' || options.requested === '0') {
    return false;
  }
  if (options.requested !== '1') {
    throw new Error(`HLT_RUST_DISPUTE_SMOKE_FLAG_INVALID:${options.requested}`);
  }
  if (
    options.engine !== 'rust' || options.evidence !== 'functional-smoke' ||
    options.users !== 1_000 || options.payments !== 5_000 ||
    options.offeredPerSecond !== 1_000 || options.durationSeconds !== 5
  ) {
    throw new Error('HLT_RUST_DISPUTE_SMOKE_REQUIRES_EXACT_FUNCTIONAL_SMOKE');
  }
  return true;
};

type MergedPaymentLedgerStage = Readonly<{
  firstAtUnixMs: number;
  lastAtUnixMs: number;
  frameAppearances: number;
  repeatedFrames: number;
  operationAppearances: number;
  repeatedOperationEvents: number;
  outcomes: Readonly<Record<string, number>>;
  lockIds: ReadonlySet<string>;
  lockLegs: ReadonlySet<string>;
  resolveIds: ReadonlySet<string>;
  resolveLegs: ReadonlySet<string>;
  hashlocks: ReadonlySet<string>;
}>;

const mergePaymentLedgerStage = (
  snapshots: readonly HltPaymentOperationLedgerSnapshot[],
  hop: AccountDeliveryHop,
): MergedPaymentLedgerStage => {
  const stages = snapshots.flatMap(snapshot => snapshot.stages[hop] ? [snapshot.stages[hop]] : []);
  const union = (field: 'lockIds' | 'lockLegs' | 'resolveIds' | 'resolveLegs' | 'hashlocks') =>
    new Set(stages.flatMap(stage => [...stage[field]]));
  const outcomes = stages.reduce((merged, stage) => {
    for (const [outcome, count] of Object.entries(stage.outcomes)) {
      merged[outcome] = (merged[outcome] ?? 0) + count;
    }
    return merged;
  }, {} as Record<string, number>);
  return {
    firstAtUnixMs: stages.length > 0 ? Math.min(...stages.map(stage => stage.firstAtUnixMs)) : 0,
    lastAtUnixMs: stages.length > 0 ? Math.max(...stages.map(stage => stage.lastAtUnixMs)) : 0,
    frameAppearances: stages.reduce((sum, stage) => sum + stage.frameAppearances, 0),
    repeatedFrames: stages.reduce((sum, stage) => sum + stage.repeatedFrames, 0),
    operationAppearances: stages.reduce((sum, stage) => sum + stage.operationAppearances, 0),
    repeatedOperationEvents: stages.reduce((sum, stage) => sum + stage.repeatedOperationEvents, 0),
    outcomes,
    lockIds: union('lockIds'),
    lockLegs: union('lockLegs'),
    resolveIds: union('resolveIds'),
    resolveLegs: union('resolveLegs'),
    hashlocks: union('hashlocks'),
  };
};

const sameSet = (left: ReadonlySet<string>, right: ReadonlySet<string>): boolean =>
  left.size === right.size && [...left].every(value => right.has(value));

export const assertCompleteUserPaymentLedger = (
  ledgers: Readonly<Record<string, HltPaymentOperationLedgerSnapshot>>,
  expectedPayments: number,
  economicStartedAtUnixMs: number,
): Readonly<Record<string, Readonly<Record<string, number>>>> => {
  const snapshots = Object.values(ledgers);
  const hops = ['committed-output', 'direct-admitted', 'account-apply-done'] as const;
  const stages = Object.fromEntries(hops.map(hop => [hop, mergePaymentLedgerStage(snapshots, hop)])) as
    Record<typeof hops[number], MergedPaymentLedgerStage>;
  const source = stages['committed-output'];
  for (const hop of hops) {
    const stage = stages[hop];
    if (
      stage.lockIds.size !== expectedPayments || stage.resolveIds.size !== expectedPayments ||
      stage.hashlocks.size !== expectedPayments
    ) throw new Error(`HLT_PAYMENT_OPERATION_LEDGER_INCOMPLETE:${hop}:${safeStringify({
      expectedPayments, locks: stage.lockIds.size, resolves: stage.resolveIds.size,
      hashlocks: stage.hashlocks.size,
      outcomes: snapshots.map(snapshot => snapshot.stages[hop]?.outcomes ?? {}),
    })}`);
  }
  const admitted = stages['direct-admitted'];
  const applied = stages['account-apply-done'];
  if (
    !sameSet(source.lockIds, admitted.lockIds) ||
    !sameSet(source.resolveIds, admitted.resolveIds) ||
    !sameSet(admitted.lockIds, applied.lockIds) ||
    !sameSet(admitted.resolveIds, applied.resolveIds) ||
    !sameSet(source.hashlocks, admitted.hashlocks) ||
    !sameSet(admitted.hashlocks, applied.hashlocks)
  ) throw new Error('HLT_PAYMENT_OPERATION_LEDGER_CROSS_STAGE_MISMATCH');
  return Object.fromEntries(hops.map(hop => [hop, {
    firstOffsetMs: stages[hop].firstAtUnixMs - economicStartedAtUnixMs,
    lastOffsetMs: stages[hop].lastAtUnixMs - economicStartedAtUnixMs,
    frameAppearances: stages[hop].frameAppearances,
    repeatedFrames: stages[hop].repeatedFrames,
    operationAppearances: stages[hop].operationAppearances,
    repeatedOperationEvents: stages[hop].repeatedOperationEvents,
    inputAcks: stages[hop].outcomes['input:ack'] ?? 0,
    inputAckFrames: stages[hop].outcomes['input:ack_frame'] ?? 0,
    inputAckFramesWithAck: stages[hop].outcomes['ack_frame:with-ack'] ?? 0,
    inputAckFramesWithoutAck: stages[hop].outcomes['ack_frame:without-ack'] ?? 0,
    inputDisputes: stages[hop].outcomes['input:dispute'] ?? 0,
    inputBoardHankoRefreshes: stages[hop].outcomes['input:board_hanko_refresh'] ?? 0,
    matchedAckFrames: stages[hop].outcomes['ack:matched-frame'] ?? 0,
    unmatchedAckFrames: stages[hop].outcomes['ack:unmatched-frame'] ?? 0,
    uniqueLockIds: stages[hop].lockIds.size,
    uniqueLockLegs: stages[hop].lockLegs.size,
    uniqueResolveIds: stages[hop].resolveIds.size,
    uniqueResolveLegs: stages[hop].resolveLegs.size,
    uniqueHashlocks: stages[hop].hashlocks.size,
  }]));
};
/**
 * Fail fast on a stuck delivery instead of burning the full 10-minute
 * deadline: unset by default (the release gate wants the long deadline so a
 * genuinely slow-but-live run isn't killed early), but a diagnostic run can
 * set this to abort in seconds once credited-amount progress has stopped.
 */
const DELIVERY_MAX_STALL_MS = Number(process.env['XLN_HLT_MAX_STALL_MS'] || 0) || Infinity;
/** How often the delivery curve is printed while a run is in flight. */
const DELIVERY_REPORT_MS = 2_000;
const ROUTE_BARRIER_POLL_MS = 500;
const ROUTE_BARRIER_TIMEOUT_MS = 20_000;
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Keep the real sovereign users, authenticated sockets and Rust H1 alive while
 * the benchmark launcher ends its setup command. The next short command opens
 * the economic window. This gate owns no protocol state and never changes an
 * input: it only chooses when the already prepared load starts.
 */
export const waitForHltEconomicStartGate = async (): Promise<void> => {
  const raw = String(process.env['XLN_HLT_ECONOMIC_GATE_DIR'] ?? '').trim();
  if (!raw) return;
  const gateDir = resolve(raw);
  const readyPath = join(gateDir, 'ready');
  const startPath = join(gateDir, 'start');
  const abortPath = join(gateDir, 'abort');
  const startedPath = join(gateDir, 'started');
  mkdirSync(gateDir, { recursive: true });
  if (existsSync(startPath) || existsSync(readyPath) || existsSync(startedPath)) {
    throw new Error(`HLT_ECONOMIC_GATE_STALE:${gateDir}`);
  }
  const temporary = `${readyPath}.tmp-${process.pid}`;
  writeFileSync(temporary, `${process.pid}\n`, { mode: 0o600 });
  renameSync(temporary, readyPath);
  console.log(`[load] economic gate ready path=${gateDir}`);
  while (!existsSync(startPath)) {
    if (existsSync(abortPath)) throw new Error('HLT_ECONOMIC_GATE_ABORTED');
    await sleep(20);
  }
  if (readFileSync(startPath, 'utf8').trim() !== 'start') {
    throw new Error('HLT_ECONOMIC_GATE_START_INVALID');
  }
  // The controller compares this with `ready`; a PID change would mean the
  // measured window ran on a restarted workload instead of the prepared one.
  writeFileSync(startedPath, `${process.pid}\n`, { mode: 0o600 });
};

/**
 * A single settlement-poll read against a CPU-starved Hub can itself hang for
 * the Hub's entire stall window: the read is an RPC awaiting that same
 * single-threaded event loop. Without its own timeout, DELIVERY_MAX_STALL_MS
 * never gets a chance to run — the loop is parked inside this await, not
 * between polls. Race it so a live diagnostic run surfaces the stall from the
 * read itself instead of only from the post-read stall counter.
 */
const withReadTimeout = <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
  if (!Number.isFinite(timeoutMs)) return promise;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`HLT_HUB_READ_TIMEOUT:${label}:timeoutMs=${timeoutMs}`)), timeoutMs);
    }),
  ]);
};

/**
 * A routed payment is admitted against the *sender's* gossip view of the hop it
 * traverses. Only pinned Accounts are advertised, and a user pins its Hub while
 * a Hub never pins its users, so the whole route is described by the two user
 * Profiles: the sender's row for the Hub and the receiver's row for the Hub.
 * Both propagate asynchronously, so a driver that starts paying as soon as
 * provisioning returns halts the sender Runtime on
 * HTLC_PAYMENT_PROFILE_ACCOUNT_MISSING instead of measuring anything. This
 * barrier waits for the exact view the payment will be judged against.
 */
export const waitForRoutableReceivers = async (
  senders: readonly LaneRuntime[],
  hubEntityId: string,
  receiverIdsBySender: readonly (readonly string[])[],
): Promise<void> => {
  if (senders.length !== receiverIdsBySender.length) {
    throw new Error('HLT_PAYMENT_ROUTE_PLAN_CARDINALITY_INVALID');
  }
  const startedAt = Date.now();
  const deadline = startedAt + ROUTE_BARRIER_TIMEOUT_MS;
  const hubId = hubEntityId.toLowerCase();
  // Gossip belongs to the sovereign Runtime, not its OS process. Each sender
  // resolves only the receivers it will actually pay; checking every user from
  // every user creates an artificial O(N²) directory workload.
  const required = receiverIdsBySender.map(ids => [...new Set(ids.map(id => id.toLowerCase()))]);
  let lastPending = -1;
  for (;;) {
    const missing = await readLaneRouteReadiness(senders, hubId, required);
    const pending = missing.length;
    if (pending === 0) {
      console.log(`[load] payment routes ready senders=${senders.length} elapsedMs=${Date.now() - startedAt}`);
      return;
    }
    if (pending !== lastPending) {
      console.log(`[load] payment routes pending=${pending} elapsedMs=${Date.now() - startedAt}`);
      lastPending = pending;
    }
    if (Date.now() >= deadline) {
      const total = required.reduce((sum, ids) => sum + ids.length, 0);
      throw new Error(`HLT_PAYMENT_ROUTES_NOT_VISIBLE:pending=${pending}:of=${total}`);
    }
    await sleep(ROUTE_BARRIER_POLL_MS);
  }
};

export const buildRoundPayment = (
  sender: LoadIdentity,
  hubEntityId: string,
  receiver: LoadIdentity,
  senderIndex: number,
  round: number,
  amountRange: HltAmountRange,
): RuntimeInput['entityInputs'][number] => {
  const amount = paymentAmountFor(senderIndex, round, amountRange);
  const payment: EntityTx = {
    type: 'htlcPayment',
    data: {
      targetEntityId: receiver.entityId,
      route: [sender.entityId, hubEntityId, receiver.entityId],
      tokenId: PAYMENT_TOKEN_ID,
      amount,
      maxSenderDebit: amount * MAX_SENDER_DEBIT_MULTIPLE,
      deliveryMode: 'async',
      description: `hlt-payment-s${senderIndex + 1}-r${round + 1}`,
    },
  };
  const input = { entityId: sender.entityId, signerId: sender.signerId, entityTxs: [payment] };
  const route = payment.data.route;
  if (
    route.length !== 3 ||
    route[0] !== sender.entityId ||
    route[1] !== hubEntityId ||
    route[2] !== receiver.entityId ||
    sender.entityId === receiver.entityId ||
    route.filter(entityId => entityId === hubEntityId).length !== 1
  ) {
    throw new Error('HLT_PAYMENT_SINGLE_HUB_ROUTE_INVALID');
  }
  return input;
};

/**
 * Delivery authority is an exact post-WAL Entity completion counter followed
 * by complete Runtime/Account drain. Net balances are invalid evidence when
 * every sovereign user both sends and receives in the same workload.
 */
export const waitForHubSettlement = async (
  hub: ConnectedRuntime,
  hubEntityId: string,
  completedPaymentsBefore: number,
  acceptedPaymentsBefore: number,
  expectedPayments: number,
  economicStartedAt: number,
): Promise<Readonly<{
  counters: HubSettlementCounters;
  hubIngressElapsedMs: number;
  deliveredElapsedMs: number;
  settlementSamples: readonly PaymentSettlementSample[];
}>> => {
  const startedAt = Date.now();
  const deadline = startedAt + DELIVERY_TIMEOUT_MS;
  let reportedAtMs = 0;
  let lastCompleted = -1;
  let lastPaybook = -1;
  let stalledSinceMs = startedAt;
  let deliveredElapsedMs: number | null = null;
  let hubIngressElapsedMs: number | null = null;
  const settlementSamples: PaymentSettlementSample[] = [];
  while (Date.now() < deadline) {
    const core = decodeHubSettlementCounters(await withReadTimeout(
      readWithRateLimitRetry<unknown>(hub, `entity/${hubEntityId}/settlement-counters`),
      DELIVERY_MAX_STALL_MS,
      'settlementCounters',
    ));
    const completed = core.completedPayments - completedPaymentsBefore;
    const accepted = core.acceptedPayments - acceptedPaymentsBefore;
    if (accepted < 0 || accepted > expectedPayments) {
      throw new Error(
        `HLT_PAYMENT_HUB_INGRESS_DELTA_INVALID:before=${acceptedPaymentsBefore}:` +
        `after=${core.acceptedPayments}:expected=${expectedPayments}`,
      );
    }
    if (completed < 0 || completed > expectedPayments) {
      throw new Error(
        `HLT_PAYMENT_METRIC_DELTA_INVALID:before=${completedPaymentsBefore}:` +
        `after=${core.completedPayments}:expected=${expectedPayments}`,
      );
    }
    const sampleElapsedMs = Math.max(1, Math.ceil(performance.now() - economicStartedAt));
    settlementSamples.push({
      elapsedMs: sampleElapsedMs,
      runtimeHeight: core.height,
      acceptedPayments: accepted,
      completedPayments: completed,
      paybookOpen: core.paybookOpen,
    });
    if (accepted === expectedPayments) {
      hubIngressElapsedMs ??= sampleElapsedMs;
    }
    if (core.paybookOpen === 0 && completed === expectedPayments) {
      if (accepted !== expectedPayments) {
        throw new Error(`HLT_PAYMENT_HUB_INGRESS_INCOMPLETE:${accepted}:${expectedPayments}`);
      }
      // Economic throughput ends when the committed Hub counter says every
      // payment completed. Continue polling to the stronger zero-queue gate,
      // but do not charge unrelated swap ACK drain to payment TPS.
      deliveredElapsedMs ??= sampleElapsedMs;
      const evidence = decodeSettlementEvidenceResponse(await withReadTimeout(
        hub.adapter.control<unknown>({ type: 'settlement-evidence', book: null, accounts: [] }),
        DELIVERY_MAX_STALL_MS,
        'bilateralQuiescence',
      ));
      const pending = Object.values(evidence.queues)
        .reduce((total, queue) => total + queue.count, 0);
      if (pending === 0) {
        if (hubIngressElapsedMs === null) throw new Error('HLT_PAYMENT_HUB_INGRESS_TIME_MISSING');
        return { counters: core, hubIngressElapsedMs, deliveredElapsedMs, settlementSamples };
      }
    }
    const elapsedMs = Date.now() - startedAt;
    if (completed !== lastCompleted) {
      lastCompleted = completed;
      stalledSinceMs = Date.now();
    } else if (core.paybookOpen !== lastPaybook) {
      lastPaybook = core.paybookOpen;
      stalledSinceMs = Date.now();
    }
    const stalledMs = Date.now() - stalledSinceMs;
    if (elapsedMs - reportedAtMs >= DELIVERY_REPORT_MS) {
      reportedAtMs = elapsedMs;
      console.log(
        `[load] hub elapsedMs=${elapsedMs} paybookOpen=${core.paybookOpen} ` +
        `accepted=${accepted}/${expectedPayments} completed=${completed}/${expectedPayments} ` +
        `fees=${core.paybookFeesEarned} height=${core.height} ` +
        `rate=${(completed / Math.max(1, elapsedMs) * 1_000).toFixed(1)}/s ` +
        `stalledMs=${stalledMs}`,
      );
    }
    if (stalledMs >= DELIVERY_MAX_STALL_MS) {
      throw new Error(`HLT_PAYMENT_STALLED_FAIL_FAST:stalledMs=${stalledMs}:height=${core.height}`);
    }
    await sleep(DELIVERY_POLL_MS);
  }
  throw new Error(
    `HLT_PAYMENT_NOT_DELIVERED:stalledMs=${Date.now() - stalledSinceMs}`,
  );
};

export const separatePaymentCompletionFromDrain = (
  deliveredElapsedMs: number,
  observedDrainElapsedMs: number,
): Readonly<{ deliveredElapsedMs: number; drainCompleteElapsedMs: number }> => ({
  deliveredElapsedMs,
  drainCompleteElapsedMs: Math.max(deliveredElapsedMs, observedDrainElapsedMs),
});

/**
 * One hub and the users that pay through it.
 *
 * Payments stay inside a shard: a sender and its receiver share a hub, so
 * adding a hub adds a whole independent path rather than more load on one.
 */
type PaymentShard = Readonly<{
  label: string;
  hub: ConnectedRuntime | null;
  hubIdentity: LoadIdentity;
  users: LaneRuntime[];
  walPath: string;
}>;

/** Lanes per shard, remainder to the first, every shard at least one. */
const shardLaneCounts = (lanes: number, shards: number): number[] => {
  if (shards < 1) throw new Error('HLT_PAYMENT_SHARD_COUNT_INVALID');
  if (lanes < shards) throw new Error(`HLT_PAYMENT_LANES_BELOW_SHARDS:${lanes}:${shards}`);
  const base = Math.floor(lanes / shards);
  const remainder = lanes - base * shards;
  return Array.from({ length: shards }, (_, index) => base + (index < remainder ? 1 : 0));
};

/**
 * One settlement series for the whole run, from one series per shard.
 *
 * Every shard samples its own hub on its own clock, so the sum is taken at
 * each observed instant using each shard's most recent sample. The result is
 * monotone because every input series is, and it reaches the run's totals at
 * the moment the slowest shard does.
 */
const mergeSettlementSamples = (
  perShard: readonly (readonly PaymentSettlementSample[])[],
): PaymentSettlementSample[] => {
  if (perShard.length === 1) return [...perShard[0]!];
  const instants = [...new Set(perShard.flatMap(series => series.map(sample => sample.elapsedMs)))]
    .sort((left, right) => left - right);
  const cursors = perShard.map(() => 0);
  const latest = perShard.map(() => null as PaymentSettlementSample | null);
  return instants.map(elapsedMs => {
    perShard.forEach((series, shardIndex) => {
      while (cursors[shardIndex]! < series.length && series[cursors[shardIndex]!]!.elapsedMs <= elapsedMs) {
        latest[shardIndex] = series[cursors[shardIndex]!]!;
        cursors[shardIndex] = cursors[shardIndex]! + 1;
      }
    });
    const sum = (read: (sample: PaymentSettlementSample) => number): number =>
      latest.reduce((total, sample) => total + (sample === null ? 0 : read(sample)), 0);
    return {
      elapsedMs,
      runtimeHeight: sum(sample => sample.runtimeHeight),
      acceptedPayments: sum(sample => sample.acceptedPayments),
      completedPayments: sum(sample => sample.completedPayments),
      paybookOpen: sum(sample => sample.paybookOpen),
    };
  });
};

export const runPaymentProductionLoad = async (args: WorkerArgs): Promise<void> => {
  const selection = parseHltEngineSelection(process.env);
  const manifestPath = join(args.workDir, 'prod-mesh', 'runtime-import-manifest.json');
  const entries = selection.engine === 'ts'
    ? decodeRuntimeManifestEntries(JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown)
    : [];
  const hubLabels = args.plan?.economy.hubLabels ?? ['H1'];
  const hubLabel = hubLabels[0] ?? 'H1';
  const hub = selection.engine === 'ts' ? await connectRuntime(entryByLabel(entries, hubLabel)) : null;
  const shards: PaymentShard[] = [];
  let users: LaneRuntime[] = [];
  let rustH1: RustH1Handle | null = null;
  const requireHub = (): ConnectedRuntime => {
    if (hub === null) throw new Error('HLT_TS_HUB_REQUIRED');
    return hub;
  };
  const requireShardHub = (shard: PaymentShard): ConnectedRuntime => {
    if (shard.hub === null) throw new Error(`HLT_TS_SHARD_HUB_REQUIRED:${shard.label}`);
    return shard.hub;
  };
  try {
    if (selection.engine === 'rust') {
      rustH1 = await attachRustH1(`http://127.0.0.1:${String(args.portBase + 10)}`);
    }
    const hubIdentity = rustH1
      ? { entityId: rustH1.ready.entityId, signerId: rustH1.ready.signerId }
      : selectLocalHubIdentity(
          decodeEntitySummaries(await readWithRateLimitRetry<unknown>(requireHub(), 'entities')),
          requireHub().adapter.runtimeId,
          31_337,
        );
    const lanes = args.lanes;
    const laneCounts = shardLaneCounts(lanes, hubLabels.length);
    const amountRange = args.plan?.economy.paymentAmountRange ?? HLT_DEFAULT_PAYMENT_AMOUNT_RANGE;
    const perSender = Array.from(
      { length: lanes },
      (_, senderIndex) => paymentTotalForSender(senderIndex, args.rounds, amountRange),
    );
    const requiredFaucet = perSender.reduce((largest, amount) => amount > largest ? amount : largest, 0n) *
      CREDIT_HEADROOM_MULTIPLE;
    if (requiredFaucet > HLT_FAUCET_AMOUNT) {
      throw new Error(
        `HLT_PAYMENT_FAUCET_INSUFFICIENT:required=${requiredFaucet}:available=${HLT_FAUCET_AMOUNT}`,
      );
    }
    const submittedPayments = lanes * args.rounds;
    const offeredPaymentRate = Math.round(lanes * 1_000 / args.cadenceMs);
    const paymentEvidence = classifyHltLivePaymentRun({
      users: lanes,
      payments: submittedPayments,
      offeredPerSecond: offeredPaymentRate,
      durationSeconds: args.plan?.economy.durationSeconds ?? 0,
    });
    if (selection.engine === 'rust') {
      if (hubLabels.length !== 1 || hubLabel !== 'H1') throw new Error('HLT_RUST_LIVE_REQUIRES_SINGLE_H1');
    }
    // One population per hub, offset so lane identities and ports never
    // overlap. Built together: a shard provisioned first would otherwise sit
    // idle for as long as the last one takes, and its host connections with it.
    const laneOffsets = laneCounts.reduce<number[]>(
      (offsets, count, index) => [...offsets, (offsets[index] ?? args.laneOffset) + count],
      [args.laneOffset],
    );
    const built = await Promise.all(hubLabels.map(async (label, shardIndex) => {
      const shardHub = selection.engine === 'rust'
        ? null
        : shardIndex === 0 ? requireHub() : await connectRuntime(entryByLabel(entries, label));
      const shardIdentity = selection.engine === 'rust' || shardIndex === 0
        ? hubIdentity
        : selectLocalHubIdentity(
          decodeEntitySummaries(await readWithRateLimitRetry<unknown>(shardHub!, 'entities')),
          shardHub!.adapter.runtimeId,
          31_337,
        );
      const laneOptions = {
        workDir: args.workDir,
        portBase: args.portBase,
        hubIdentity: shardIdentity,
        lanes: laneCounts[shardIndex]!,
        laneOffset: laneOffsets[shardIndex]!,
        role: 'taker',
      } as const;
      const setup = selection.engine === 'rust'
        ? await spawnParallelLoadLanes(laneOptions)
        : await setupParallelLoadLanes({ ...laneOptions, hub: shardHub! });
      return {
        label,
        hub: shardHub,
        hubIdentity: shardIdentity,
        users: setup.runtimes,
        walPath: selection.engine === 'rust'
          ? join(args.workDir, 'prod-mesh', label.toLowerCase(), 'rscore-native')
          : resolveWalPath(join(args.workDir, 'prod-mesh', label.toLowerCase())),
      } satisfies PaymentShard;
    }));
    shards.push(...built);
    users = built.flatMap(shard => shard.users);
    const workloadFingerprint = hltWorkloadFingerprint('payments', {
      users: users.map(lane => lane.identity.entityId),
      rounds: args.rounds,
      cadenceMs: args.cadenceMs,
      amountMin: amountRange.min.toString(),
      amountMax: amountRange.max.toString(),
    });

    if (selection.engine === 'ts') await stopHltHubBackgroundIo(args, hubLabels);
    const initialRustMetrics = rustH1?.metrics() ?? null;
    if (selection.engine === 'rust' && initialRustMetrics === null) {
      throw new Error('HLT_RUST_INITIAL_METRICS_MISSING');
    }
    const hubDurableBefore = initialRustMetrics
      ? { height: initialRustMetrics.height, canonicalStateHash: initialRustMetrics.postStateHash }
      : decodeLoadFrame(await readWithRateLimitRetry<unknown>(requireHub(), 'frame/latest'));
    let rustSetupHeight: number | null = null;
    const rustExistingOpenSessions = initialRustMetrics?.openSessions ?? null;
    if (selection.engine === 'rust') {
      const expectedRuntimeId = rustH1!.ready.runtimeId;
      await rustH1!.stop();
      rustH1 = await connectRustH1({
        portBase: args.portBase,
        lanes: users,
        expectedRuntimeId,
        expectedEntityId: hubIdentity.entityId,
      });
      let setupFingerprint = '';
      let setupTelemetryError: Error | null = null;
      const setupTelemetry = setInterval(() => {
        let metrics: RustH1Metrics | undefined;
        try {
          metrics = rustH1?.metrics() ?? undefined;
        } catch (cause) {
          setupTelemetryError = cause instanceof Error ? cause : new Error(String(cause));
          clearInterval(setupTelemetry);
          console.error(`[load] rust-setup-telemetry-failed ${setupTelemetryError.message}`);
          return;
        }
        if (!metrics) return;
        const fingerprint = `${metrics.height}:${metrics.totalFrames}:${metrics.outboxRowsPending}`;
        if (fingerprint === setupFingerprint) return;
        setupFingerprint = fingerprint;
        console.log(`[load] rust-setup ${safeStringify({
          height: metrics.height,
          frames: metrics.totalFrames,
          inputs: metrics.totalRuntimeEntityInputs,
          accountInputs: metrics.totalAccountInputs,
          applyMicros: metrics.totalApplyMicros,
          projectionMicros: metrics.totalProjectionMicros,
          storageMicros: metrics.totalStorageMicros,
          publicationMicros: metrics.totalPublicationMicros,
          outputs: metrics.totalOutputsPublished,
          outboxRows: metrics.outboxRowsPending,
          sessions: metrics.openSessions,
        })}`);
      }, 500);
      setupTelemetry.unref();
      try {
        await provisionParallelLoadLaneAccounts({
          hubIdentity,
          runtimes: users,
          commitHubInput: async (commandId, input) => {
            if (input.runtimeTxs.length !== 0 || input.entityInputs.length < 1) {
              throw new Error(`HLT_RUST_LOCAL_INPUT_INVALID:${commandId}`);
            }
            rustSetupHeight = await rustH1!.submitLocalEntityInputs(commandId, input.entityInputs);
          },
        });
      } finally {
        clearInterval(setupTelemetry);
      }
      if (setupTelemetryError !== null) throw setupTelemetryError;
    } else {
      await exportReplayBaseSnapshotIfConfigured(requireHub());
    }

    // One shard at a time so route discovery cannot multiply H1 lookup demand.
    for (const shard of shards) {
      await waitForRoutableReceivers(
        shard.users,
        shard.hubIdentity.entityId,
        shard.users.map((_lane, senderIndex) => Array.from(
          { length: args.rounds },
          (_, round) => shard.users[
            paymentReceiverIndexSamePopulation(senderIndex, round, shard.users.length)
          ]!.identity.entityId,
        )),
      );
    }
    await resetLaneHostOpCounters(users);
    if (selection.engine === 'ts') {
      await resetHltProcessOpCounters(args, shards.map(requireShardHub));
    }
    const tsCountersBefore = selection.engine === 'ts'
      ? await Promise.all(shards.map(async shard => decodeHubSettlementCounters(
          await readWithRateLimitRetry<unknown>(requireShardHub(shard), `entity/${shard.hubIdentity.entityId}/settlement-counters`),
        )))
      : [];
    let rustMetricsBefore: RustH1Metrics | null = rustH1?.metrics() ?? null;
    if (rustH1) {
      if (rustSetupHeight === null) throw new Error('HLT_RUST_FINANCIAL_SETUP_HEIGHT_MISSING');
      const baselineDeadline = Date.now() + 1_000;
      while (
        (
          rustMetricsBefore === null ||
          rustMetricsBefore.height < rustSetupHeight ||
          rustExistingOpenSessions === null ||
          !rustH1SessionPopulationReady(
            rustMetricsBefore.openSessions,
            rustExistingOpenSessions,
            users.length,
          )
        ) &&
        Date.now() < baselineDeadline
      ) {
        await sleep(20);
        rustMetricsBefore = rustH1.metrics();
      }
      if (
        rustMetricsBefore === null ||
        rustMetricsBefore.height < rustSetupHeight ||
        rustExistingOpenSessions === null ||
        !rustH1SessionPopulationReady(
          rustMetricsBefore.openSessions,
          rustExistingOpenSessions,
          users.length,
        )
      ) {
        throw new Error(`HLT_RUST_ECONOMIC_METRICS_BASELINE_MISSING:${String(rustSetupHeight)}`);
      }
    }
    // Native WAL authority is the synced StorageHead counter, not LevelDB's
    // directory size: compaction may shrink physical files after a valid append.
    const walBytesBefore = rustMetricsBefore
      ? rustMetricsBefore.retainedWalBytes
      : shards.reduce((total, shard) => total + directoryBytes(shard.walPath), 0);
    const countersBefore = selection.engine === 'rust'
      ? [{
          height: rustMetricsBefore!.height,
          paybookOpen: rustMetricsBefore!.paybookOpen,
          paybookFeesEarned: BigInt(rustMetricsBefore!.paybookFeesEarned),
          acceptedPayments: rustMetricsBefore!.acceptedPayments,
          completedPayments: rustMetricsBefore!.completedPayments,
          matchedSwaps: 0,
          metricsRuntimeHeight: rustMetricsBefore!.height,
        }]
      : tsCountersBefore;
    const hubCountersBefore = {
      completedPayments: countersBefore.reduce((sum, row) => sum + row.completedPayments, 0),
      acceptedPayments: countersBefore.reduce((sum, row) => sum + row.acceptedPayments, 0),
    };
    // Global lane index -> the shard that lane pays through.
    const laneShard = shards.flatMap((shard, shardIndex) =>
      shard.users.map((_lane, localIndex) => ({ shard, shardIndex, localIndex })));

    await waitForHltEconomicStartGate();
    const startedAt = performance.now();
    const economicStartedAtUnixMs = Date.now();
    let enqueueAckElapsedMs = 0;
    const roundSubmissionLagMs: number[] = [];
    const pendingSubmissions: Array<Promise<Readonly<{ ackMs: number; error: unknown | null }>>> = [];
    let submissionFailure: unknown | null = null;
    const schedule = buildPacedOperationSchedule({
      participants: users.length,
      rounds: args.rounds,
      cadenceMs: args.cadenceMs,
    });
    // Operations due within the same window travel in one wave. The pacer
    // gives every user its own instant, which at high offered rates means one
    // HTTP request per payment; the load host's accept queue, not the mesh,
    // was what gave out first. A Runtime may own several operations in one
    // window: they remain distinct ordered EntityTxs inside one canonical
    // RuntimeInput instead of manufacturing extra Runtime/Entity envelopes.
    const submitWindowMs = Number(process.env['XLN_HLT_SUBMIT_WINDOW_MS'] ?? String(args.cadenceMs));
    const batches: Array<typeof schedule> = [];
    for (const operation of schedule) {
      const open = batches.at(-1);
      const first = open?.[0];
      const fits = open !== undefined && first !== undefined
        && operation.dueOffsetMs - first.dueOffsetMs < submitWindowMs;
      if (fits && open) open.push(operation);
      else batches.push([operation]);
    }
    console.log(
      `[load] payment ingress payments=${submittedPayments} batches=${batches.length} ` +
      `windowMs=${submitWindowMs}`,
    );
    let economicFingerprint = '';
    const economicTelemetry = rustH1 ? setInterval(() => {
      const metrics = rustH1?.metrics();
      if (!metrics) return;
      const fingerprint = `${metrics.height}:${metrics.acceptedPayments}:${metrics.completedPayments}:` +
        `${metrics.paybookOpen}:${metrics.outboxRowsPending}`;
      if (fingerprint === economicFingerprint) return;
      economicFingerprint = fingerprint;
      console.log(`[load] rust-economic ${safeStringify({
        height: metrics.height,
        accepted: metrics.acceptedPayments,
        completed: metrics.completedPayments,
        locks: metrics.paybookOpen,
        accountInputs: metrics.totalAccountInputs - rustMetricsBefore!.totalAccountInputs,
        applyMicros: metrics.totalApplyMicros - rustMetricsBefore!.totalApplyMicros,
        projectionMicros: metrics.totalProjectionMicros - rustMetricsBefore!.totalProjectionMicros,
        storageMicros: metrics.totalStorageMicros - rustMetricsBefore!.totalStorageMicros,
        publicationMicros: metrics.totalPublicationMicros - rustMetricsBefore!.totalPublicationMicros,
        outboxRows: metrics.outboxRowsPending,
      })}`);
    }, 250) : null;
    economicTelemetry?.unref();
    for (const [batchIndex, batch] of batches.entries()) {
      const operation = batch[batch.length - 1]!;
      // A transport wave is released only when its last operation is due; no
      // payment is advanced merely because it shares an HTTP batch.
      const scheduledAt = startedAt + operation.dueOffsetMs;
      const waitMs = scheduledAt - performance.now();
      if (waitMs > 0) await sleep(waitMs);
      if (submissionFailure !== null) throw submissionFailure;
      const waveStartedAt = performance.now();
      const byParticipant = new Map<number, typeof batch>();
      for (const entry of batch) {
        const entries = byParticipant.get(entry.participantIndex) ?? [];
        entries.push(entry);
        byParticipant.set(entry.participantIndex, entries);
      }
      const submissions = [...byParticipant].map(([participantIndex, entries]) => {
        const placement = laneShard[participantIndex]!;
        const lane = placement.shard.users[placement.localIndex]!;
        const entityTxs = entries.map(entry => {
          const receiver = placement.shard.users[paymentReceiverIndexSamePopulation(
            placement.localIndex,
            entry.round,
            placement.shard.users.length,
          )]!;
          const entityInput = buildRoundPayment(
            lane.identity,
            placement.shard.hubIdentity.entityId,
            receiver.identity,
            participantIndex,
            entry.round,
            amountRange,
          );
          const entityTx = entityInput.entityTxs?.[0];
          if (!entityTx || entityInput.entityTxs?.length !== 1) throw new Error('HLT_PAYMENT_TX_MISSING');
          return entityTx;
        });
        return {
          lane,
          input: {
            runtimeTxs: [],
            entityInputs: [{
              entityId: lane.identity.entityId,
              signerId: lane.identity.signerId,
              entityTxs,
            }],
          },
        };
      });
      const pending = queueLaneRuntimeInputWave(batchIndex, submissions).then(
        () => ({ ackMs: Math.max(0, Math.ceil(performance.now() - waveStartedAt)), error: null }),
        error => {
          submissionFailure ??= error;
          return { ackMs: Math.max(0, Math.ceil(performance.now() - waveStartedAt)), error };
        },
      );
      pendingSubmissions.push(pending);
      // One lag per payment: the report counts payments, not waves.
      const lagMs = Math.max(0, Math.ceil(performance.now() - scheduledAt));
      for (let index = 0; index < batch.length; index += 1) roundSubmissionLagMs.push(lagMs);
    }
    const sourceDispatchFinishedElapsedMs = Math.max(1, Math.ceil(performance.now() - startedAt));
    const submissionResults = await Promise.all(pendingSubmissions);
    const failedSubmission = submissionResults.find(result => result.error !== null);
    if (failedSubmission) throw failedSubmission.error;
    enqueueAckElapsedMs = Math.max(0, ...submissionResults.map(result => result.ackMs));
    const hostAcceptedElapsedMs = Math.max(
      sourceDispatchFinishedElapsedMs,
      Math.ceil(performance.now() - startedAt),
    );
    // Each shard settles against its own hub; the run is done when the
    // slowest one is, and the rates below are the sum over shards.
    const rustSettlement = rustH1
      ? await waitForRustPaymentSettlement({
          rust: rustH1,
          lanes: users,
          expectedPayments: submittedPayments,
          economicStartedAt: startedAt,
          metricsBefore: rustMetricsBefore!,
        })
      : null;
    if (economicTelemetry) clearInterval(economicTelemetry);
    const settlements = rustSettlement
      ? [rustSettlement]
      : await Promise.all(shards.map((shard, shardIndex) => waitForHubSettlement(
          requireShardHub(shard),
          shard.hubIdentity.entityId,
          countersBefore[shardIndex]!.completedPayments,
          countersBefore[shardIndex]!.acceptedPayments,
          shard.users.length * args.rounds,
          startedAt,
        )));
    const laneQuiescence = rustSettlement?.laneQuiescence ?? (
      paymentEvidence === 'tps-authority'
        ? await waitForLaneQuiescence(users, requireHub().adapter.runtimeId, 5_000)
        : null
    );
    const hubCountersAfter = {
      completedPayments: settlements.reduce((sum, row) => sum + row.counters.completedPayments, 0),
      acceptedPayments: settlements.reduce((sum, row) => sum + row.counters.acceptedPayments, 0),
    };
    const hubIngressElapsedMs = Math.max(...settlements.map(row => row.hubIngressElapsedMs));
    const deliveredElapsedMs = Math.max(...settlements.map(row => row.deliveredElapsedMs));
    const paymentSettlement = {
      settlementSamples: mergeSettlementSamples(settlements.map(row => row.settlementSamples)),
    };
    const [tsHubIo, laneIo, lanePaymentLedgers] = await Promise.all([
      assertHltHubProcessIsolation(args, hubLabels, selection.engine === 'rust' ? hubLabels : []),
      assertLaneHostSocketCounterCoverage(users),
      readLaneHostPaymentOperationLedgers(users),
    ]);
    const paymentOperationLedger = assertCompleteUserPaymentLedger(
      lanePaymentLedgers,
      submittedPayments,
      economicStartedAtUnixMs,
    );
    const deliveredPayments = paymentOperationLedger['account-apply-done']?.['uniqueHashlocks'];
    if (deliveredPayments !== submittedPayments) {
      throw new Error(`HLT_PAYMENT_DELIVERED_LEDGER_MISMATCH:${String(deliveredPayments)}:${submittedPayments}`);
    }
    // Payment TPS ends at the committed H1 completion counter. The later
    // ledger/ACK audit remains mandatory, but is a drain gate, not execution.
    const { drainCompleteElapsedMs } = separatePaymentCompletionFromDrain(
      deliveredElapsedMs,
      Math.ceil(performance.now() - startedAt),
    );
    const terminalSettlementSample = paymentSettlement.settlementSamples.at(-1);
    if (!terminalSettlementSample) throw new Error('HLT_PAYMENT_SETTLEMENT_SAMPLE_MISSING');
    const phaseTimeline = rustSettlement ? {
      hostAcceptedElapsedMs,
      hubLastAcceptedOffsetMs: Math.max(
        0,
        Math.round(rustSettlement.metrics.lastAcceptedAtUnixMicros / 1_000 - economicStartedAtUnixMs),
      ),
      hubLastCompletedOffsetMs: Math.max(
        0,
        Math.round(rustSettlement.metrics.lastCompletedAtUnixMicros / 1_000 - economicStartedAtUnixMs),
      ),
      userStages: paymentOperationLedger,
      drainCompleteOffsetMs: drainCompleteElapsedMs,
    } : { hostAcceptedElapsedMs, userStages: paymentOperationLedger, drainCompleteOffsetMs: drainCompleteElapsedMs };
    const hubIo = rustSettlement
      ? { ...tsHubIo, H1: { native: rustSettlement.metrics } }
      : tsHubIo;
    console.log(`[load] economic-io ${safeStringify({ hubIo, laneIo, phaseTimeline })}`);
    const environment = collectHltEnvironmentManifest({
      engine: selection.engine,
      ...(rustH1 ? { rustAccountWorkers: rustH1.ready.workers } : {}),
      requireAccountWorkers: paymentEvidence === 'tps-authority',
    });
    const walBytesAfter = rustSettlement
      ? rustSettlement.metrics.retainedWalBytes
      : shards.reduce((total, shard) => total + directoryBytes(shard.walPath), 0);
    assertHltWalAdvanced(walBytesBefore, walBytesAfter, environment.hubWalSync);
    const reportInput = {
      schema: 'xln-hlt-payment-load-v1',
      engine: selection.engine,
      mode: 'payments',
      runId: basename(args.workDir),
      completionAuthority: 'committed_entity_metrics_and_bilateral_runtime_quiescence',
      configuredUsers: lanes,
      configuredRounds: args.rounds,
      cadenceMs: args.cadenceMs,
      senders: lanes,
      receivers: lanes,
      tokenId: PAYMENT_TOKEN_ID,
      // Amounts vary per (sender, round) within [min,max]; the report's single
      // `amount` field predates randomization and is kept as the floor so it
      // stays a valid, meaningful decimal without widening the report schema.
      amount: amountRange.min.toString(),
      offeredPaymentRate,
      submittedPayments,
      deliveredPayments,
      enqueueAckElapsedMs,
      sourceDispatchFinishedElapsedMs,
      sourceAllAckedElapsedMs: hostAcceptedElapsedMs,
      commandObservedElapsedMs: hostAcceptedElapsedMs,
      deliveredElapsedMs,
      drainCompleteElapsedMs,
      deliveredTps: deliveredPayments * 1_000 / deliveredElapsedMs,
      hubCompletedPaymentsBefore: hubCountersBefore.completedPayments,
      hubCompletedPaymentsAfter: hubCountersAfter.completedPayments,
      hubAcceptedPaymentsBefore: hubCountersBefore.acceptedPayments,
      hubAcceptedPaymentsAfter: hubCountersAfter.acceptedPayments,
      hubIngressElapsedMs,
      settlementSamples: paymentSettlement.settlementSamples,
      roundSubmissionLagMs,
      laneQuiescence,
      walBytesBefore,
      walBytesAfter,
      hubDurableBefore,
      hubDurableAfter: rustSettlement
        ? {
            height: rustSettlement.metrics.height,
            canonicalStateHash: rustSettlement.metrics.postStateHash,
          }
        : decodeLoadFrame(await readWithRateLimitRetry<unknown>(requireHub(), 'frame/latest')),
      environment,
    } as const;
    // Diagnostics run the exact production path, but only the authority
    // cardinality may create the rate-bearing dashboard report.
    const report = paymentEvidence === 'tps-authority'
      ? decodeLoadPaymentReport(reportInput)
      : null;
    if (report) {
      persistReport(join(args.workDir, 'hlt-payment-load-report.json'), report, decodeLoadPaymentReport);
    }
    if (rustH1 && rustSettlement) {
      const workerExecution = summarizeRustH1WorkerExecution(
        rustSettlement.economicPhaseMetrics,
        rustH1.ready.workers,
        deliveredPayments,
      );
      const rateEvidence = hltLivePaymentRateEvidence(paymentEvidence, {
        offeredPerSecond: offeredPaymentRate,
        deliveredPayments,
        deliveredElapsedMs,
      });
      writeFileSync(join(args.workDir, 'hlt-rust-h1-live.json'), `${safeStringify({
        engine: 'rust',
        evidence: paymentEvidence,
        users: lanes,
        submittedPayments,
        deliveredPayments,
        offeredWindowMs: args.rounds * args.cadenceMs,
        deliveredElapsedMs,
        hostAcceptedElapsedMs,
        workers: rustH1.ready.workers,
        minFrameDelayMs: rustH1.ready.minFrameDelayMs,
        metrics: rustSettlement.metrics,
        economicPhaseMetrics: rustSettlement.economicPhaseMetrics,
        workerExecution,
        workloadFingerprint,
        laneQuiescence: rustSettlement.laneQuiescence,
        paymentOperationLedger,
        phaseTimeline,
        environment,
        ...rateEvidence,
      }, 2)}\n`);
      if (process.env['XLN_RSCORE_PROFILE_ENTITY'] === '1') {
        writeFileSync(join(args.workDir, 'rscore-entity-profile.log'), rustH1.errorTail());
      }
    }
    const disputeSmoke = shouldRunRustH1DisputeSmoke({
      requested: process.env['XLN_HLT_DISPUTE_SMOKE'],
      engine: selection.engine,
      evidence: paymentEvidence,
      users: lanes,
      payments: submittedPayments,
      offeredPerSecond: offeredPaymentRate,
      durationSeconds: args.plan?.economy.durationSeconds ?? 0,
    });
    if (disputeSmoke) {
      if (!rustH1) throw new Error('HLT_RUST_DISPUTE_SMOKE_H1_MISSING');
      const lane = users[0];
      const receiver = users[1];
      if (!lane || !receiver) throw new Error('HLT_RUST_DISPUTE_SMOKE_LANES_MISSING');
      const entityInput = buildRoundPayment(
        lane.identity,
        rustH1.ready.entityId,
        receiver.identity,
        0,
        args.rounds,
        amountRange,
      );
      const result = await runRustH1DisputeSmoke({
        apiBaseUrl: `http://127.0.0.1:${String(args.portBase + 10)}`,
        rust: rustH1,
        lane,
        businessInput: { runtimeTxs: [], entityInputs: [entityInput] },
        tokenId: PAYMENT_TOKEN_ID,
      });
      writeFileSync(
        join(args.workDir, 'hlt-rust-h1-dispute-smoke.json'),
        `${safeStringify(result, 2)}\n`,
      );
    }
    if (shouldRunRustH1AccountSettlementSmoke({
      requested: process.env['XLN_HLT_ACCOUNT_SETTLEMENT_SMOKE'],
      engine: selection.engine,
      evidence: paymentEvidence,
      users: lanes,
      payments: submittedPayments,
      offeredPerSecond: offeredPaymentRate,
      durationSeconds: args.plan?.economy.durationSeconds ?? 0,
    })) {
      if (!rustH1) throw new Error('HLT_RUST_ACCOUNT_SETTLEMENT_SMOKE_H1_MISSING');
      // Dispute smoke owns user 0. Keep settlement on an independent Account
      // so both production lifecycle gates can run in one H1 process.
      const counterparty = users[1];
      if (!counterparty) throw new Error('HLT_RUST_ACCOUNT_SETTLEMENT_SMOKE_LANE_MISSING');
      const result = await runRustH1AccountSettlementSmoke({
        apiBaseUrl: `http://127.0.0.1:${String(args.portBase + 10)}`,
        rust: rustH1,
        counterpartyLane: counterparty,
        tokenId: PAYMENT_TOKEN_ID,
      });
      writeFileSync(
        join(args.workDir, 'hlt-rust-h1-account-settlement-smoke.json'),
        `${safeStringify(result, 2)}\n`,
      );
    }
    const authoritativeCardinality = paymentEvidence === 'tps-authority';
    if (authoritativeCardinality && report) {
      assertHltW4ReleaseTpsFloor({
        engine: selection.engine,
        accountWorkers: report.environment.accountWorkers,
        productionEquivalent: isProductionEquivalentHltEnvironment(report.environment),
        deliveredTps: report.deliveredTps,
      });
      publishHltDashboardReport('payment', report);
      publishHltDashboardPerfFromWorkDir(args.workDir);
    }
    if (report) console.log(safeStringify(report));
    if (authoritativeCardinality && report) {
      console.log(
        `[load] verdict deliveredTps=${report.deliveredTps.toFixed(1)} ` +
        `${isProductionEquivalentHltEnvironment(report.environment) ? 'production-equivalent' : 'DIAGNOSTIC (isolated/fast environment)'} ` +
        `lanePersistence=${report.environment.lanePersistence} laneNice=${report.environment.laneNice} ` +
        `hubWalSync=${report.environment.hubWalSync}`,
      );
    } else if (selection.engine === 'rust' && paymentEvidence === 'functional-smoke') {
      console.log(
        `[load] RUST_H1_FUNCTIONAL_SMOKE_COMPLETE users=${lanes} ` +
        `submitted=${submittedPayments} delivered=${deliveredPayments} ` +
        `windowMs=${args.rounds * args.cadenceMs} elapsedMs=${deliveredElapsedMs}`,
      );
    } else {
      console.log(
        `[load] SMOKE_ONLY_NOT_TPS_EVIDENCE users=${lanes} ` +
        `submitted=${submittedPayments} delivered=${deliveredPayments} ` +
        `windowMs=${args.rounds * args.cadenceMs}`,
      );
    }
  } catch (error) {
    if (rustH1) {
      let metrics: RustH1Metrics | null = null;
      let metricsError: string | null = null;
      try {
        metrics = rustH1.metrics();
      } catch (cause) {
        metricsError = cause instanceof Error ? cause.message : String(cause);
      }
      console.error(`[load] rust-failure ${safeStringify({
        error: error instanceof Error ? error.message : String(error),
        metrics,
        metricsError,
        stderr: rustH1.errorTail(),
      })}`);
    }
    throw error;
  } finally {
    await rustH1?.stop();
    await stopLaneRuntimes(users);
    for (const shard of shards) shard.hub?.adapter.disconnect();
    if (shards.length === 0) hub?.adapter.disconnect();
  }
};

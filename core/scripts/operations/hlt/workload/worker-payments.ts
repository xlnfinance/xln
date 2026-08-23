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
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
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
import { decodeLoadPaymentReport, type PaymentSettlementSample } from '../boundary/worker-payment-boundary';
import { publishHltDashboardPerfFromWorkDir, publishHltDashboardReport } from '../../../../qa/hlt/hlt-dashboard';
import { HLT_FAUCET_AMOUNT, setupParallelLoadLanes } from '../lanes/worker-lanes';
import {
  queueLaneRuntimeInputWave,
  assertLaneHostSocketCounterCoverage,
  resetLaneHostOpCounters,
  stopLaneRuntimes,
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
const DELIVERY_TIMEOUT_MS = 600_000;
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
const ROUTE_BARRIER_TIMEOUT_MS = 300_000;
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

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
// Bounded fan-out for the polling readers: 250 concurrent reads at three
// daemons overflow a daemon's accept queue while it is inside a long frame.
// Cap is process-global, not per daemon: 1000 users at 2/runtime is 500
// daemons × 16 = 8000 sockets and FailedToOpenSocket on localhost.
const READ_CONCURRENCY = 16;
const forEachLimited = async <T>(items: readonly T[], fn: (item: T) => Promise<void>): Promise<void> => {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const item = items[cursor]!;
      cursor += 1;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, items.length) }, worker));
};

const isTransientGossipSocketError = (error: unknown): boolean => {
  const text = error instanceof Error ? error.message : String(error);
  return text.includes('FailedToOpenSocket')
    || text.includes('typo in the url')
    || text.includes('ECONNRESET')
    || text.includes('ECONNREFUSED')
    || text.includes('GOSSIP_PROFILE_LOOKUP_RATE_LIMITED');
};

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
  const confirmed = senders.map(() => new Set<string>());
  let lastPending = -1;
  for (;;) {
    const pendingReads = confirmed.flatMap((settled, daemonIndex) =>
      settled.size === required[daemonIndex]!.length ? [] : [daemonIndex]);
    let socketErrors = 0;
    await forEachLimited(pendingReads, async daemonIndex => {
      try {
        const unsettled = required[daemonIndex]!.filter(receiverId => !confirmed[daemonIndex]!.has(receiverId));
        const profiles = await senders[daemonIndex]!.runtime.control.gossipProfilesCounterparties(unsettled);
        for (const receiverId of unsettled) {
          if (profiles.get(receiverId.toLowerCase())?.includes(hubId)) {
            confirmed[daemonIndex]!.add(receiverId);
          }
        }
      } catch (error) {
        if (!isTransientGossipSocketError(error)) throw error;
        socketErrors += 1;
      }
    });
    const pending = confirmed.reduce(
      (total, settled, index) => total + (required[index]!.length - settled.size),
      0,
    );
    if (pending === 0) {
      console.log(`[load] payment routes ready senders=${senders.length} elapsedMs=${Date.now() - startedAt}`);
      return;
    }
    if (pending !== lastPending || socketErrors > 0) {
      console.log(`[load] payment routes pending=${pending} sockets=${socketErrors} elapsedMs=${Date.now() - startedAt}`);
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
  let lastLockBook = -1;
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
      lockBookOpen: core.lockBookOpen,
    });
    if (accepted === expectedPayments) {
      hubIngressElapsedMs ??= sampleElapsedMs;
    }
    if (core.lockBookOpen === 0 && completed === expectedPayments) {
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
    } else if (core.lockBookOpen !== lastLockBook) {
      lastLockBook = core.lockBookOpen;
      stalledSinceMs = Date.now();
    }
    const stalledMs = Date.now() - stalledSinceMs;
    if (elapsedMs - reportedAtMs >= DELIVERY_REPORT_MS) {
      reportedAtMs = elapsedMs;
      console.log(
        `[load] hub elapsedMs=${elapsedMs} lockBookOpen=${core.lockBookOpen} ` +
        `accepted=${accepted}/${expectedPayments} completed=${completed}/${expectedPayments} ` +
        `fees=${core.htlcFeesEarned} height=${core.height} ` +
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

export const runPaymentProductionLoad = async (args: WorkerArgs): Promise<void> => {
  const manifestPath = join(args.workDir, 'prod-mesh', 'runtime-import-manifest.json');
  const entries = decodeRuntimeManifestEntries(JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown);
  const hubLabel = args.plan?.economy.hubLabels[0] ?? 'H1';
  const hub = await connectRuntime(entryByLabel(entries, hubLabel));
  let users: LaneRuntime[] = [];
  try {
    const hubIdentity = selectLocalHubIdentity(
      decodeEntitySummaries(await readWithRateLimitRetry<unknown>(hub, 'entities')),
      hub.adapter.runtimeId,
      31_337,
    );
    const lanes = args.lanes;
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
    const setup = await setupParallelLoadLanes({
      workDir: args.workDir,
      portBase: args.portBase,
      hub,
      hubIdentity,
      lanes,
      laneOffset: args.laneOffset,
      role: 'taker',
    });
    users = setup.runtimes;

    await waitForRoutableReceivers(
      users,
      hubIdentity.entityId,
      users.map((_lane, senderIndex) => Array.from(
        { length: args.rounds },
        (_, round) => users[paymentReceiverIndexSamePopulation(senderIndex, round, users.length)]!.identity.entityId,
      )),
    );

    await stopHltHubBackgroundIo(args);
    await Promise.all([
      resetLaneHostOpCounters(users),
      resetHltProcessOpCounters(args, [hub]),
    ]);

    await exportReplayBaseSnapshotIfConfigured(hub);
    const walPath = resolveWalPath(join(args.workDir, 'prod-mesh', hubLabel.toLowerCase()));
    const walBytesBefore = directoryBytes(walPath);
    const hubDurableBefore = decodeLoadFrame(await readWithRateLimitRetry<unknown>(hub, 'frame/latest'));
    const hubCountersBefore = decodeHubSettlementCounters(
      await readWithRateLimitRetry<unknown>(hub, `entity/${hubIdentity.entityId}/settlement-counters`),
    );

    const startedAt = performance.now();
    let enqueueAckElapsedMs = 0;
    const roundSubmissionLagMs: number[] = [];
    const pendingSubmissions: Array<Promise<Readonly<{ ackMs: number; error: unknown | null }>>> = [];
    let submissionFailure: unknown | null = null;
    const schedule = buildPacedOperationSchedule({
      participants: users.length,
      rounds: args.rounds,
      cadenceMs: args.cadenceMs,
    });
    for (const operation of schedule) {
      const scheduledAt = startedAt + operation.dueOffsetMs;
      const waitMs = scheduledAt - performance.now();
      if (waitMs > 0) await sleep(waitMs);
      if (submissionFailure !== null) throw submissionFailure;
      const waveStartedAt = performance.now();
      const lane = users[operation.participantIndex]!;
      const receiver = users[paymentReceiverIndexSamePopulation(
        operation.participantIndex,
        operation.round,
        users.length,
      )]!;
      const entityInput = buildRoundPayment(
        lane.identity,
        hubIdentity.entityId,
        receiver.identity,
        operation.participantIndex,
        operation.round,
        amountRange,
      );
      if (entityInput.entityTxs?.length !== 1) throw new Error('HLT_PAYMENT_TX_MISSING');
      const pending = queueLaneRuntimeInputWave(operation.ordinal, [{
        lane,
        input: {
          runtimeTxs: [],
          entityInputs: [entityInput],
        },
      }]).then(
        () => ({ ackMs: Math.max(0, Math.ceil(performance.now() - waveStartedAt)), error: null }),
        error => {
          submissionFailure ??= error;
          return { ackMs: Math.max(0, Math.ceil(performance.now() - waveStartedAt)), error };
        },
      );
      pendingSubmissions.push(pending);
      roundSubmissionLagMs.push(Math.max(0, Math.ceil(performance.now() - scheduledAt)));
    }
    const sourceDispatchFinishedElapsedMs = Math.max(1, Math.ceil(performance.now() - startedAt));
    const submissionResults = await Promise.all(pendingSubmissions);
    const failedSubmission = submissionResults.find(result => result.error !== null);
    if (failedSubmission) throw failedSubmission.error;
    enqueueAckElapsedMs = Math.max(0, ...submissionResults.map(result => result.ackMs));
    const sourceAllAckedElapsedMs = Math.max(
      sourceDispatchFinishedElapsedMs,
      Math.ceil(performance.now() - startedAt),
    );
    const submittedPayments = lanes * args.rounds;
    const paymentSettlement = await waitForHubSettlement(
      hub,
      hubIdentity.entityId,
      hubCountersBefore.completedPayments,
      hubCountersBefore.acceptedPayments,
      submittedPayments,
      startedAt,
    );
    const hubCountersAfter = paymentSettlement.counters;
    const hubIngressElapsedMs = paymentSettlement.hubIngressElapsedMs;
    const deliveredElapsedMs = paymentSettlement.deliveredElapsedMs;
    const [hubIo, laneIo] = await Promise.all([
      assertHltHubProcessIsolation(args),
      assertLaneHostSocketCounterCoverage(users),
    ]);
    console.log(`[load] economic-io ${safeStringify({ hubIo, laneIo })}`);
    const report = decodeLoadPaymentReport({
      schema: 'xln-hlt-payment-load-v1',
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
      offeredPaymentRate: Math.round(lanes * 1_000 / args.cadenceMs),
      submittedPayments,
      deliveredPayments: submittedPayments,
      enqueueAckElapsedMs,
      sourceDispatchFinishedElapsedMs,
      sourceAllAckedElapsedMs,
      commandObservedElapsedMs: sourceAllAckedElapsedMs,
      deliveredElapsedMs,
      deliveredTps: submittedPayments * 1_000 / deliveredElapsedMs,
      hubCompletedPaymentsBefore: hubCountersBefore.completedPayments,
      hubCompletedPaymentsAfter: hubCountersAfter.completedPayments,
      hubAcceptedPaymentsBefore: hubCountersBefore.acceptedPayments,
      hubAcceptedPaymentsAfter: hubCountersAfter.acceptedPayments,
      hubIngressElapsedMs,
      settlementSamples: paymentSettlement.settlementSamples,
      roundSubmissionLagMs,
      walBytesBefore,
      walBytesAfter: directoryBytes(walPath),
      hubDurableBefore,
      hubDurableAfter: decodeLoadFrame(await readWithRateLimitRetry<unknown>(hub, 'frame/latest')),
      environment: collectHltEnvironmentManifest(),
    });
    persistReport(join(args.workDir, 'hlt-payment-load-report.json'), report, decodeLoadPaymentReport);
    publishHltDashboardReport('payment', report);
    publishHltDashboardPerfFromWorkDir(args.workDir);
    console.log(safeStringify(report));
    console.log(
      `[load] verdict deliveredTps=${report.deliveredTps.toFixed(1)} ` +
      `${isProductionEquivalentHltEnvironment(report.environment) ? 'production-equivalent' : 'DIAGNOSTIC (isolated/fast environment)'} ` +
      `laneNice=${report.environment.laneNice} certifiedHistory=${report.environment.certifiedHistory} hubWalSync=${report.environment.hubWalSync}`,
    );
  } finally {
    await stopLaneRuntimes(users);
    hub.adapter.disconnect();
  }
};

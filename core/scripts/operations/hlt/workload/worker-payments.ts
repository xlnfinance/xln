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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deriveDelta, isLeftEntity } from '../../../../account/utils';
import { safeStringify } from '../../../../protocol/serialization';
import type { RuntimeInput } from '../../../../runtime/types';
import type { EntityTx } from '../../../../types/entity-tx';
import {
  decodeEntitySummaries,
  decodeHubSettlementCounters,
  decodeAccountPageCursor,
  decodeLoadFrame,
  decodeRuntimeManifestEntries,
  selectLocalHubIdentity,
  type LoadAccountProjection,
  type LoadIdentity,
} from '../boundary/worker-boundary';
import { decodeLoadPaymentReport } from '../boundary/worker-payment-boundary';
import { publishHltDashboardPerfFromWorkDir, publishHltDashboardReport } from '../../../../qa/hlt/hlt-dashboard';
import { setupParallelLoadLanes } from '../lanes/worker-lanes';
import { laneDaemons, stopLaneRuntimes, type LaneRuntime } from '../lanes/lane-runtimes';
import {
  connectRuntime,
  directoryBytes,
  entryByLabel,
  persistReport,
  readWithRateLimitRetry,
  resolveWalPath,
  sendEnqueued,
  type WorkerArgs,
} from '../worker-runtime';
import { HLT_DEFAULT_PAYMENT_AMOUNT_RANGE, type HltAmountRange } from '../economy';
import {
  paymentAmountFor,
  paymentReceiverIndex,
  paymentTotalForSender,
  paymentTotalsByReceiver,
} from './worker-payments-plan';

/** Payments move the quote token; the swap workload owns the base token. */
const PAYMENT_TOKEN_ID = 1;
/**
 * Routing fees are quoted from live gossip at admission time, so the sender
 * declares a ceiling rather than the exact debit. Two times the amount covers
 * any sane single-hop fee and is still bounded by the granted credit.
 */
const MAX_SENDER_DEBIT_MULTIPLE = 2n;
/** Credit headroom over the exact total, so a fee cannot starve the last round. */
const CREDIT_HEADROOM_MULTIPLE = 4n;
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

const waitForRoutableReceivers = async (
  senders: readonly LaneRuntime[],
  hubEntityId: string,
  receiverIds: readonly string[],
): Promise<void> => {
  const startedAt = Date.now();
  const deadline = startedAt + ROUTE_BARRIER_TIMEOUT_MS;
  // Gossip is per daemon, not per hosted user: asking every sender about every
  // receiver was senders x receivers requests (62 500 at 500 users) fired
  // concurrently at three daemons, which overflowed their accept queues
  // (FailedToOpenSocket) while a daemon sat in a long frame. One sequential
  // chain per daemon asks each receiver once.
  const daemons = laneDaemons(senders);
  const confirmed = daemons.map(() => new Set<string>());
  let lastPending = -1;
  for (;;) {
    await Promise.all(daemons.map(async (lane, index) => {
      const settled = confirmed[index]!;
      const pendingIds = receiverIds.filter(id => !settled.has(id));
      await forEachLimited(pendingIds, async receiverId => {
        const receiverAccounts = await lane.control.gossipProfileCounterparties(receiverId);
        if (receiverAccounts?.includes(hubEntityId)) settled.add(receiverId);
      });
    }));
    const pending = confirmed.reduce(
      (total, settled) => total + (receiverIds.length - settled.size),
      0,
    );
    if (pending === 0) {
      console.log(`[load] payment routes ready senders=${senders.length} daemons=${daemons.length} elapsedMs=${Date.now() - startedAt}`);
      return;
    }
    if (pending !== lastPending) {
      console.log(`[load] payment routes pending=${pending} elapsedMs=${Date.now() - startedAt}`);
      lastPending = pending;
    }
    if (Date.now() >= deadline) {
      throw new Error(`HLT_PAYMENT_ROUTES_NOT_VISIBLE:pending=${pending}:of=${daemons.length * receiverIds.length}`);
    }
    await sleep(ROUTE_BARRIER_POLL_MS);
  }
};

const buildRoundPayment = (
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
      description: `hlt-payment-r${round + 1}`,
    },
  };
  return { entityId: sender.entityId, signerId: sender.signerId, entityTxs: [payment] };
};

const hubCounterparty = (account: LoadAccountProjection, hubEntityId: string): string | null => {
  const { leftEntity, rightEntity } = account.state;
  if (leftEntity === hubEntityId) return rightEntity;
  if (rightEntity === hubEntityId) return leftEntity;
  return null;
};

const hubInCapacity = (account: LoadAccountProjection, hubEntityId: string): bigint => {
  const delta = account.state.deltas.get(PAYMENT_TOKEN_ID);
  if (!delta) return 0n;
  const counterparty = hubCounterparty(account, hubEntityId);
  if (!counterparty) return 0n;
  return deriveDelta(delta, isLeftEntity(hubEntityId, counterparty)).inCapacity;
};

// The API page cap (see entity-view-page.ts's pageLimit) is 500, but the
// radapter transport itself caps one message at 1MB (codec.ts). A full
// 500-account page measured ~3.7MB (~7.4KB/account) in one run, but a page of
// 80 measured over 1MB (~13.4KB/account) in another under real load — account
// size varies with HTLC/delta history, so no fixed page size is safe across
// runs. This settlement check reruns every poll (DELIVERY_POLL_MS) for the
// life of the run, so paging at the old default of 10 meant ~50 sequential WS
// round-trips per poll at a 500-account Hub — the dominant cost of the whole
// poll, compounding under any write-side contention. Start at 80 (cuts
// round-trips ~6x over the old default) and halve on overflow, same idiom as
// wire-budget.ts's materializeOrHalve, instead of guessing a single constant.
const HUB_ACCOUNTS_PAGE_LIMIT_START = 80;
const HUB_ACCOUNTS_PAGE_LIMIT_FLOOR = 4;

const isMessageTooLarge = (error: unknown): boolean =>
  error instanceof Error && error.message.includes('RADAPTER_MESSAGE_TOO_LARGE');

const readHubAccounts = async (
  hub: { adapter: { read: <T>(path: string, query?: Record<string, unknown>) => Promise<T> } },
  hubEntityId: string,
): Promise<LoadAccountProjection[]> => {
  const items: LoadAccountProjection[] = [];
  let cursor: string | undefined;
  let pageLimit = HUB_ACCOUNTS_PAGE_LIMIT_START;
  for (;;) {
    let page;
    for (;;) {
      try {
        page = decodeAccountPageCursor(await readWithRateLimitRetry<unknown>(
          hub,
          `entity/${hubEntityId}/accounts`,
          { accountsLimit: pageLimit, ...(cursor ? { accountsCursor: cursor } : {}) },
        ));
        break;
      } catch (error) {
        if (!isMessageTooLarge(error) || pageLimit <= HUB_ACCOUNTS_PAGE_LIMIT_FLOOR) throw error;
        pageLimit = Math.max(HUB_ACCOUNTS_PAGE_LIMIT_FLOOR, Math.floor(pageLimit / 2));
      }
    }
    items.push(...page.items);
    if (!page.nextCursor) return items;
    cursor = page.nextCursor;
  }
};

const readHubReceiverCredits = async (
  hub: { adapter: { read: <T>(path: string, query?: Record<string, unknown>) => Promise<T> } },
  hubEntityId: string,
  receiverIds: ReadonlySet<string>,
): Promise<Map<string, bigint>> => {
  const credits = new Map<string, bigint>();
  for (const account of await readHubAccounts(hub, hubEntityId)) {
    const counterparty = hubCounterparty(account, hubEntityId);
    if (!counterparty || !receiverIds.has(counterparty)) continue;
    credits.set(counterparty, hubInCapacity(account, hubEntityId));
  }
  return credits;
};

/**
 * Delivery is authorized by the Hub entity: lockBook empty and receiver-side
 * inCapacity (Hub view = receiver outCapacity) reached the owed totals.
 */
const waitForHubSettlement = async (
  hub: { adapter: { read: <T>(path: string, query?: Record<string, unknown>) => Promise<T> } },
  hubEntityId: string,
  receiverIds: readonly string[],
  baselines: ReadonlyMap<string, bigint>,
  expected: ReadonlyMap<string, bigint>,
): Promise<void> => {
  const startedAt = Date.now();
  const deadline = startedAt + DELIVERY_TIMEOUT_MS;
  const receivers = new Set(receiverIds);
  const owed = [...expected.values()].reduce((total, amount) => total + amount, 0n);
  let reportedAtMs = 0;
  let lastCredited = -1n;
  let stalledSinceMs = startedAt;
  while (Date.now() < deadline) {
    const core = decodeHubSettlementCounters(
      await withReadTimeout(readWithRateLimitRetry<unknown>(hub, `entity/${hubEntityId}`), DELIVERY_MAX_STALL_MS, 'entity'),
    );
    const credits = await withReadTimeout(
      readHubReceiverCredits(hub, hubEntityId, receivers),
      DELIVERY_MAX_STALL_MS,
      'receiverCredits',
    );
    let credited = 0n;
    let pendingReceivers = 0;
    for (const [receiverId, amount] of expected) {
      const received = (credits.get(receiverId) ?? 0n) - (baselines.get(receiverId) ?? 0n);
      credited += received > 0n ? received : 0n;
      if (received < amount) pendingReceivers += 1;
    }
    if (pendingReceivers === 0 && core.lockBookOpen === 0) return;
    const elapsedMs = Date.now() - startedAt;
    if (credited !== lastCredited) {
      lastCredited = credited;
      stalledSinceMs = Date.now();
    }
    const stalledMs = Date.now() - stalledSinceMs;
    if (elapsedMs - reportedAtMs >= DELIVERY_REPORT_MS) {
      reportedAtMs = elapsedMs;
      console.log(
        `[load] hub elapsedMs=${elapsedMs} lockBookOpen=${core.lockBookOpen} ` +
        `receiversPending=${pendingReceivers}/${receiverIds.length} ` +
        `credited=${credited}/${owed} fees=${core.htlcFeesEarned} height=${core.height} ` +
        `rate=${(Number(credited) / Math.max(1, elapsedMs) * 1_000).toFixed(1)}/s ` +
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
  let senders: LaneRuntime[] = [];
  let receivers: LaneRuntime[] = [];
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
    const perReceiver = paymentTotalsByReceiver(lanes, lanes, args.rounds, amountRange);
    // Senders spend toward the Hub, so the Hub grants them capacity; receivers
    // are paid by the Hub, so they grant the Hub capacity. Both directions are
    // funded with headroom because routing fees ride on top of the amount.
    const senderSetup = await setupParallelLoadLanes({
      workDir: args.workDir,
      portBase: args.portBase,
      hub,
      hubIdentity,
      lanes,
      laneOffset: args.laneOffset,
      role: 'maker',
      laneGrantedCreditTokenId: PAYMENT_TOKEN_ID,
      laneGrantedCreditAmounts: perSender.map(total => total * CREDIT_HEADROOM_MULTIPLE),
      hubGrantedCreditTokenId: PAYMENT_TOKEN_ID,
      hubGrantedCreditAmounts: perSender.map(total => total * CREDIT_HEADROOM_MULTIPLE),
    });
    senders = senderSetup.runtimes;
    const receiverSetup = await setupParallelLoadLanes({
      workDir: args.workDir,
      portBase: args.portBase,
      hub,
      hubIdentity,
      lanes,
      laneOffset: args.laneOffset,
      role: 'taker',
      laneGrantedCreditTokenId: PAYMENT_TOKEN_ID,
      laneGrantedCreditAmounts: perReceiver.map(total => total * CREDIT_HEADROOM_MULTIPLE),
      hubGrantedCreditTokenId: PAYMENT_TOKEN_ID,
      hubGrantedCreditAmounts: perReceiver.map(total => total * CREDIT_HEADROOM_MULTIPLE),
    });
    receivers = receiverSetup.runtimes;

    await waitForRoutableReceivers(
      senders,
      hubIdentity.entityId,
      receivers.map(lane => lane.identity.entityId.toLowerCase()),
    );

    const walPath = resolveWalPath(join(args.workDir, 'prod-mesh', hubLabel.toLowerCase()));
    const walBytesBefore = directoryBytes(walPath);
    const hubDurableBefore = decodeLoadFrame(await readWithRateLimitRetry<unknown>(hub, 'frame/latest'));
    const receiverIds = receivers.map(lane => lane.identity.entityId.toLowerCase());
    const expected = new Map(receiverIds.map((id, index) => [id, perReceiver[index]!]));
    const baselines = await readHubReceiverCredits(hub, hubIdentity.entityId, new Set(receiverIds));

    const startedAt = performance.now();
    const enqueued = await Promise.all(senders.map((lane, index) => sendEnqueued(
      lane.runtime,
      `hlt-payment-batch-${hubDurableBefore.height}-${index}`,
      {
        runtimeTxs: [],
        entityInputs: [{
          entityId: lane.identity.entityId,
          signerId: lane.identity.signerId,
          entityTxs: Array.from({ length: args.rounds }, (_, round) => {
            const receiver = receivers[paymentReceiverIndex(index, round, receivers.length)]!;
            const built = buildRoundPayment(
              lane.identity,
              hubIdentity.entityId,
              receiver.identity,
              index,
              round,
              amountRange,
            );
            const tx = built.entityTxs?.[0];
            if (!tx) throw new Error('HLT_PAYMENT_TX_MISSING');
            return tx;
          }),
        }],
      },
    )));
    const enqueueAckElapsedMs = Math.max(0, ...enqueued.map(entry => entry.enqueueAckElapsedMs));
    const roundSubmissionLagMs = [Math.max(0, Math.ceil(performance.now() - startedAt))];
    await waitForHubSettlement(hub, hubIdentity.entityId, receiverIds, baselines, expected);
    const deliveredElapsedMs = Math.max(1, Math.ceil(performance.now() - startedAt));
    const submittedPayments = lanes * args.rounds;
    const report = decodeLoadPaymentReport({
      schema: 'xln-hlt-payment-load-v1',
      mode: 'payments',
      completionAuthority: 'committed_receiver_balances_and_bilateral_quiescence',
      configuredUsers: lanes * 2,
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
      commandObservedElapsedMs: enqueueAckElapsedMs,
      deliveredElapsedMs,
      deliveredTps: submittedPayments * 1_000 / deliveredElapsedMs,
      roundSubmissionLagMs,
      walBytesBefore,
      walBytesAfter: directoryBytes(walPath),
      hubDurableBefore,
      hubDurableAfter: decodeLoadFrame(await readWithRateLimitRetry<unknown>(hub, 'frame/latest')),
    });
    persistReport(join(args.workDir, 'hlt-payment-load-report.json'), report, decodeLoadPaymentReport);
    publishHltDashboardReport('payment', report);
    publishHltDashboardPerfFromWorkDir(args.workDir);
    console.log(safeStringify(report));
  } finally {
    await stopLaneRuntimes([...senders, ...receivers]);
    hub.adapter.disconnect();
  }
};

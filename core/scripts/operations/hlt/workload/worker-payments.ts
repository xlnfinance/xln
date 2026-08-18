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
import type { EntityTx } from '../../../../types/entity-tx';
import type { RuntimeInput } from '../../../../runtime/types';
import {
  decodeEntitySummaries,
  decodeLoadFrame,
  decodeRuntimeManifestEntries,
  selectLocalHubIdentity,
  type LoadIdentity,
} from '../boundary/worker-boundary';
import { decodeLoadPaymentReport } from '../boundary/worker-payment-boundary';
import { setupParallelLoadLanes } from '../lanes/worker-lanes';
import { laneDaemons, stopLaneRuntimes, type LaneRuntime } from '../lanes/lane-runtimes';
import {
  connectRuntime,
  directoryBytes,
  entryByLabel,
  persistReport,
  readLoadAccount,
  resolveWalPath,
  sendObserved,
  type WorkerArgs,
} from '../worker-runtime';
import {
  paymentReceiverIndex,
  paymentTotalPerSender,
  paymentTotalsByReceiver,
} from './worker-payments-plan';

/** Payments move the quote token; the swap workload owns the base token. */
const PAYMENT_TOKEN_ID = 1;
const PAYMENT_AMOUNT = 1_000n;
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
/** How often the delivery curve is printed while a run is in flight. */
const DELIVERY_REPORT_MS = 2_000;
const ROUTE_BARRIER_POLL_MS = 500;
const ROUTE_BARRIER_TIMEOUT_MS = 300_000;
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

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
  round: number,
): RuntimeInput['entityInputs'][number] => {
  const payment: EntityTx = {
    type: 'htlcPayment',
    data: {
      targetEntityId: receiver.entityId,
      route: [sender.entityId, hubEntityId, receiver.entityId],
      tokenId: PAYMENT_TOKEN_ID,
      amount: PAYMENT_AMOUNT,
      maxSenderDebit: PAYMENT_AMOUNT * MAX_SENDER_DEBIT_MULTIPLE,
      deliveryMode: 'async',
      description: `hlt-payment-r${round + 1}`,
    },
  };
  return { entityId: sender.entityId, signerId: sender.signerId, entityTxs: [payment] };
};

/**
 * Delivery is authorized by the receivers' own committed Account balances, not
 * by the sender's acknowledgement: a locked-but-unresolved HTLC acknowledges
 * fine and never pays anyone.
 */
const waitForDeliveredBalances = async (
  receivers: readonly LaneRuntime[],
  hubEntityId: string,
  baselines: readonly bigint[],
  expected: readonly bigint[],
): Promise<void> => {
  const startedAt = Date.now();
  const deadline = startedAt + DELIVERY_TIMEOUT_MS;
  const pending = new Set(receivers.map((_, index) => index));
  // Counting whole receivers only says "someone is still owed something". The
  // amount actually credited is the delivery curve: it separates a Hub that is
  // slow from a Hub that has stopped, and a timeout then reports which it was.
  const credited = receivers.map(() => 0n);
  const owed = expected.reduce((total, amount) => total + amount, 0n);
  let reportedAtMs = 0;
  let lastCredited = -1n;
  let stalledSinceMs = startedAt;
  while (Date.now() < deadline) {
    await forEachLimited([...pending], async index => {
      const lane = receivers[index]!;
      const account = await readLoadAccount(lane.runtime, lane.identity.entityId, hubEntityId);
      const delta = account?.state.deltas.get(PAYMENT_TOKEN_ID);
      if (!delta) return;
      const capacity = deriveDelta(delta, isLeftEntity(lane.identity.entityId, hubEntityId)).outCapacity;
      const received = capacity - baselines[index]!;
      credited[index] = received > 0n ? received : 0n;
      if (received >= expected[index]!) pending.delete(index);
    });
    if (pending.size === 0) return;
    const total = credited.reduce((sum, amount) => sum + amount, 0n);
    const elapsedMs = Date.now() - startedAt;
    if (total !== lastCredited) {
      lastCredited = total;
      stalledSinceMs = Date.now();
    }
    if (elapsedMs - reportedAtMs >= DELIVERY_REPORT_MS) {
      reportedAtMs = elapsedMs;
      console.log(
        `[load] delivery elapsedMs=${elapsedMs} receiversPending=${pending.size}/${receivers.length} ` +
        `credited=${total}/${owed} rate=${(Number(total) / Math.max(1, elapsedMs) * 1_000).toFixed(1)}/s ` +
        `stalledMs=${Date.now() - stalledSinceMs}`,
      );
    }
    await sleep(DELIVERY_POLL_MS);
  }
  const total = credited.reduce((sum, amount) => sum + amount, 0n);
  throw new Error(
    `HLT_PAYMENT_NOT_DELIVERED:pendingReceivers=${pending.size}:credited=${total}:owed=${owed}:` +
    `stalledMs=${Date.now() - stalledSinceMs}`,
  );
};

const readReceiverBalances = async (
  receivers: readonly LaneRuntime[],
  hubEntityId: string,
): Promise<bigint[]> => {
  const balances = receivers.map(() => 0n);
  await forEachLimited(receivers.map((_, index) => index), async index => {
    const lane = receivers[index]!;
    const account = await readLoadAccount(lane.runtime, lane.identity.entityId, hubEntityId);
    const delta = account?.state.deltas.get(PAYMENT_TOKEN_ID);
    if (!delta) return;
    balances[index] = deriveDelta(delta, isLeftEntity(lane.identity.entityId, hubEntityId)).outCapacity;
  });
  return balances;
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
      decodeEntitySummaries(await hub.adapter.read<unknown>('entities')),
      hub.adapter.runtimeId,
      31_337,
    );
    const lanes = args.lanes;
    const perSender = paymentTotalPerSender(args.rounds, PAYMENT_AMOUNT);
    const perReceiver = paymentTotalsByReceiver(lanes, lanes, args.rounds, PAYMENT_AMOUNT);
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
      laneGrantedCreditAmounts: Array.from({ length: lanes }, () => perSender * CREDIT_HEADROOM_MULTIPLE),
      hubGrantedCreditTokenId: PAYMENT_TOKEN_ID,
      hubGrantedCreditAmounts: Array.from({ length: lanes }, () => perSender * CREDIT_HEADROOM_MULTIPLE),
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
    const hubDurableBefore = decodeLoadFrame(await hub.adapter.read<unknown>('frame/latest'));
    const baselines = await readReceiverBalances(receivers, hubIdentity.entityId);

    const startedAt = performance.now();
    const roundSubmissionLagMs: number[] = [];
    let enqueueAckElapsedMs = 0;
    let commandObservedElapsedMs = 0;
    for (let round = 0; round < args.rounds; round += 1) {
      const dueAt = startedAt + round * args.cadenceMs;
      const remainingMs = dueAt - performance.now();
      if (remainingMs > 0) await sleep(remainingMs);
      roundSubmissionLagMs.push(Math.max(0, Math.ceil(performance.now() - dueAt)));
      const observed = await Promise.all(senders.map((lane, index) => sendObserved(
        lane.runtime,
        `hlt-payment-${hubDurableBefore.height}-${round + 1}-${index}`,
        {
          runtimeTxs: [],
          entityInputs: [buildRoundPayment(
            { entityId: lane.identity.entityId, signerId: lane.identity.signerId },
            hubIdentity.entityId,
            {
              entityId: receivers[paymentReceiverIndex(index, round, receivers.length)]!.identity.entityId,
              signerId: receivers[paymentReceiverIndex(index, round, receivers.length)]!.identity.signerId,
            },
            round,
          )],
        },
      )));
      enqueueAckElapsedMs += Math.max(...observed.map(entry => entry.enqueueAckElapsedMs));
      commandObservedElapsedMs += Math.max(...observed.map(entry => entry.commandObservedElapsedMs));
    }
    await waitForDeliveredBalances(receivers, hubIdentity.entityId, baselines, perReceiver);
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
      amount: PAYMENT_AMOUNT.toString(),
      offeredPaymentRate: Math.round(lanes * 1_000 / args.cadenceMs),
      submittedPayments,
      deliveredPayments: submittedPayments,
      enqueueAckElapsedMs,
      commandObservedElapsedMs: Math.max(enqueueAckElapsedMs, commandObservedElapsedMs),
      deliveredElapsedMs: Math.max(commandObservedElapsedMs, deliveredElapsedMs),
      deliveredTps: submittedPayments * 1_000 / deliveredElapsedMs,
      roundSubmissionLagMs,
      walBytesBefore,
      walBytesAfter: directoryBytes(walPath),
      hubDurableBefore,
      hubDurableAfter: decodeLoadFrame(await hub.adapter.read<unknown>('frame/latest')),
    });
    persistReport(join(args.workDir, 'hlt-payment-load-report.json'), report, decodeLoadPaymentReport);
    console.log(safeStringify(report));
  } finally {
    await stopLaneRuntimes([...senders, ...receivers]);
    hub.adapter.disconnect();
  }
};

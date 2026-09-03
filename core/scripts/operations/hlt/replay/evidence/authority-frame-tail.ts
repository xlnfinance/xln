import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { HltAmountRange } from '../../economy';
import type { LoadIdentity } from '../../boundary/worker-boundary';
import {
  decodeHubSettlementCounters,
  decodeLoadFrame,
} from '../../boundary/worker-boundary';
import {
  queueLaneRuntimeInputWave,
  waitForLaneQuiescence,
  type LaneRuntime,
} from '../../lanes/lane-runtimes';
import type { ConnectedRuntime } from '../../worker-runtime';
import { requireBoundaryInteger, requireBoundaryRecord } from '../../../../../protocol/boundary-validation';
import { HLT_AUTHORITY_MIN_RUNTIME_FRAMES } from '../../authority-evidence-policy';
import { buildRoundPayment, waitForHubSettlement } from '../../workload/worker-payments';
import { paymentReceiverIndexSamePopulation } from '../../workload/worker-payments-plan';

type AuthorityFrameTail = Readonly<{
  baseHeight: number;
  finalHeight: number;
  recordedFrames: number;
  payments: number;
}>;

const readBaseHeight = (workDir: string): number => {
  const value: unknown = JSON.parse(readFileSync(join(workDir, 'hlt-h1-base-snapshot.json'), 'utf8'));
  const snapshot = requireBoundaryRecord(value, 'HLT_AUTHORITY_BASE_SNAPSHOT_INVALID');
  return requireBoundaryInteger(snapshot['runtimeHeight'], 'HLT_AUTHORITY_BASE_HEIGHT_INVALID');
};

const readHubFrame = async (hub: ConnectedRuntime) =>
  decodeLoadFrame(await hub.adapter.read<unknown>('frame/latest'));

const readHubCounters = async (hub: ConnectedRuntime, entityId: string) =>
  decodeHubSettlementCounters(
    await hub.adapter.read<unknown>(`entity/${entityId}/settlement-counters`),
  );

const submitTailPayment = async (options: Readonly<{
  hub: ConnectedRuntime;
  hubIdentity: LoadIdentity;
  users: readonly LaneRuntime[];
  amountRange: HltAmountRange;
  index: number;
  workloadRounds: number;
}>): Promise<void> => {
  const senderIndex = 5 + (options.index % (options.users.length - 5));
  const routeRound = options.index % options.workloadRounds;
  const receiverIndex = paymentReceiverIndexSamePopulation(
    senderIndex,
    routeRound,
    options.users.length,
  );
  const sender = options.users[senderIndex]!;
  const receiver = options.users[receiverIndex]!;
  const counters = await readHubCounters(options.hub, options.hubIdentity.entityId);
  const entityInput = buildRoundPayment(
    sender.identity,
    options.hubIdentity.entityId,
    receiver.identity,
    options.users.length + options.index,
    options.workloadRounds + options.index,
    options.amountRange,
  );
  await queueLaneRuntimeInputWave(options.index, [{
    lane: sender,
    input: { runtimeTxs: [], entityInputs: [entityInput] },
  }], { waitForCommit: true });
  await waitForHubSettlement(
    options.hub,
    options.hubIdentity.entityId,
    counters.completedPayments,
    counters.acceptedPayments,
    1,
    performance.now(),
  );
};

/** Add real, fully settled payments after the measured window until the WAL
 * contains the owner-approved frame tail. Each iteration waits for Hub
 * settlement, so batching cannot collapse multiple operations into one frame. */
export const extendAuthorityFrameTail = async (options: Readonly<{
  workDir: string;
  hub: ConnectedRuntime;
  hubIdentity: LoadIdentity;
  users: readonly LaneRuntime[];
  amountRange: HltAmountRange;
  workloadRounds: number;
}>): Promise<AuthorityFrameTail> => {
  if (options.users.length < 7) throw new Error('HLT_AUTHORITY_FRAME_TAIL_USERS_INSUFFICIENT');
  const baseHeight = readBaseHeight(options.workDir);
  let latest = await readHubFrame(options.hub);
  let payments = 0;
  while (latest.height - baseHeight < HLT_AUTHORITY_MIN_RUNTIME_FRAMES) {
    const beforeHeight = latest.height;
    await submitTailPayment({ ...options, index: payments });
    latest = await readHubFrame(options.hub);
    if (latest.height <= beforeHeight) {
      throw new Error(`HLT_AUTHORITY_FRAME_TAIL_STALLED:${beforeHeight}:${latest.height}`);
    }
    payments += 1;
  }
  await waitForLaneQuiescence(options.users, options.hub.adapter.runtimeId, 5_000);
  return {
    baseHeight,
    finalHeight: latest.height,
    recordedFrames: latest.height - baseHeight,
    payments,
  };
};

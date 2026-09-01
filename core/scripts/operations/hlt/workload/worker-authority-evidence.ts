import type { LoadIdentity } from '../boundary/worker-boundary';
import type { LaneRuntime } from '../lanes/lane-runtimes';
import {
  queueLaneRuntimeInputWave,
  readLaneAccountDetails,
  startLaneJurisdictionWatcher,
} from '../lanes/lane-runtimes';
import { requireBoundaryRecord } from '../../../../protocol/boundary-validation';
import { safeStringify } from '../../../../protocol/serialization';
import {
  sendObserved,
  type ConnectedRuntime,
} from '../worker-runtime';
import { hltAuthorityEvidenceRecording } from '../authority-evidence-policy';

const DISPUTE_EVIDENCE_TIMEOUT_MS = 10_000;

export const hltAuthorityEvidenceEnabled = (): boolean =>
  hltAuthorityEvidenceRecording(process.env);

const readCounterpartyDispute = async (
  lane: LaneRuntime,
  hubRuntimeId: string,
  hubEntityId: string,
): Promise<Readonly<{ status: string; observedOnChain: boolean }> | null> => {
  const rows = await readLaneAccountDetails(lane, hubRuntimeId);
  for (const value of rows) {
    const row = requireBoundaryRecord(value, 'HLT_AUTHORITY_DISPUTE_ACCOUNT_INVALID');
    if (String(row['counterpartyId'] || '').toLowerCase() !== hubEntityId.toLowerCase()) continue;
    return {
      status: String(row['status'] || ''),
      observedOnChain: row['activeDisputeObservedOnChain'] === true,
    };
  }
  return null;
};

const waitForCounterpartyDisputeState = async (options: Readonly<{
  lane: LaneRuntime;
  hubRuntimeId: string;
  hubEntityId: string;
  finalized: boolean;
}>): Promise<void> => {
  const deadline = Date.now() + DISPUTE_EVIDENCE_TIMEOUT_MS;
  let latest: Awaited<ReturnType<typeof readCounterpartyDispute>> = null;
  while (Date.now() <= deadline) {
    latest = await readCounterpartyDispute(options.lane, options.hubRuntimeId, options.hubEntityId);
    if (!options.finalized && latest?.status === 'disputed' && latest.observedOnChain) return;
    // Quiescence omits Accounts after their active dispute is cleared. If a
    // pending diagnostic row remains, require the same terminal status.
    if (options.finalized && (latest === null || (
      latest.status === 'disputed' && !latest.observedOnChain
    ))) return;
    await Bun.sleep(25);
  }
  throw new Error(
    `HLT_AUTHORITY_DISPUTE_STATE_TIMEOUT:finalized=${String(options.finalized)}:` +
    safeStringify(latest),
  );
};

/** Produce one real mutual-consent dispute lifecycle on the same production
 * H1/lane pair used by the mixed workload; no synthetic event is injected. */
export const materializeCompleteDisputeEvidence = async (options: Readonly<{
  hub: ConnectedRuntime;
  hubIdentity: LoadIdentity;
  lane: LaneRuntime;
}>): Promise<void> => {
  const { hub, hubIdentity, lane } = options;
  await startLaneJurisdictionWatcher(lane);
  await sendObserved(hub, 'hlt-authority-dispute-prepare', {
    runtimeTxs: [],
    entityInputs: [{
      entityId: hubIdentity.entityId,
      signerId: hubIdentity.signerId,
      entityTxs: [{
        type: 'prepareDispute',
        data: {
          counterpartyEntityId: lane.identity.entityId,
          description: 'hlt-authority-production-dispute',
          minCooldownMs: 0,
        },
      }],
    }],
  });
  await sendObserved(hub, 'hlt-authority-dispute-start-broadcast', {
    runtimeTxs: [],
    entityInputs: [{
      entityId: hubIdentity.entityId,
      signerId: hubIdentity.signerId,
      entityTxs: [{ type: 'j_broadcast', data: {} }],
    }],
  });
  await waitForCounterpartyDisputeState({
    lane,
    hubRuntimeId: hub.adapter.runtimeId,
    hubEntityId: hubIdentity.entityId,
    finalized: false,
  });
  await queueLaneRuntimeInputWave(0, [{
    lane,
    input: {
      runtimeTxs: [],
      entityInputs: [{
        entityId: lane.identity.entityId,
        signerId: lane.identity.signerId,
        entityTxs: [{
          type: 'disputeFinalize',
          data: {
            counterpartyEntityId: hubIdentity.entityId,
            description: 'hlt-authority-mutual-consent',
          },
        }],
      }],
    },
  }], { waitForCommit: true });
  await queueLaneRuntimeInputWave(0, [{
    lane,
    input: {
      runtimeTxs: [],
      entityInputs: [{
        entityId: lane.identity.entityId,
        signerId: lane.identity.signerId,
        entityTxs: [{ type: 'j_broadcast', data: {} }],
      }],
    },
  }], { waitForCommit: true });
  await waitForCounterpartyDisputeState({
    lane,
    hubRuntimeId: hub.adapter.runtimeId,
    hubEntityId: hubIdentity.entityId,
    finalized: true,
  });
  console.log(
    `HLT_AUTHORITY_DISPUTE_EVIDENCE_OK hub=${hubIdentity.entityId} ` +
    `counterparty=${lane.identity.entityId}`,
  );
};

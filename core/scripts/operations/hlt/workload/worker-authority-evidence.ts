import type { LoadIdentity } from '../boundary/worker-boundary';
import type { LaneRuntime } from '../lanes/lane-runtimes';
import {
  queueLaneRuntimeInputWave,
  readLaneAccountDetails,
  startLaneJurisdictionWatcher,
} from '../lanes/lane-runtimes';
import {
  requireBoundaryInteger,
  requireBoundaryRecord,
} from '../../../../protocol/boundary-validation';
import { safeStringify } from '../../../../protocol/serialization';
import {
  sendObserved,
  type ConnectedRuntime,
} from '../worker-runtime';
import { decodeHubCoreRecord } from '../boundary/worker-boundary';
import { hltAuthorityEvidenceRecording } from '../authority-evidence-policy';

const DISPUTE_EVIDENCE_TIMEOUT_MS = 10_000;
const SETTLEMENT_EVIDENCE_TIMEOUT_MS = 20_000;
const SETTLEMENT_QUIESCENCE_MS = 500;

type CounterpartyDisputeState = Readonly<{
  status: string;
  observedOnChain: boolean;
  finalizedJHeight: number;
}>;

export const hltAuthorityEvidenceEnabled = (): boolean =>
  hltAuthorityEvidenceRecording(process.env);

const readCounterpartyDispute = async (
  lane: LaneRuntime,
  hubRuntimeId: string,
  hubEntityId: string,
): Promise<CounterpartyDisputeState | null> => {
  const rows = await readLaneAccountDetails(lane, hubRuntimeId);
  for (const value of rows) {
    const row = requireBoundaryRecord(value, 'HLT_AUTHORITY_DISPUTE_ACCOUNT_INVALID');
    if (String(row['counterpartyId'] || '').toLowerCase() !== hubEntityId.toLowerCase()) continue;
    return {
      status: String(row['status'] || ''),
      observedOnChain: row['activeDisputeObservedOnChain'] === true,
      finalizedJHeight: requireBoundaryInteger(
        row['entityLastFinalizedJHeight'],
        'HLT_AUTHORITY_DISPUTE_J_HEIGHT_INVALID',
      ),
    };
  }
  return null;
};

const waitForHubFinalizedJHeight = async (
  hub: ConnectedRuntime,
  hubEntityId: string,
  targetJHeight: number,
): Promise<void> => {
  const deadline = Date.now() + DISPUTE_EVIDENCE_TIMEOUT_MS;
  let latest = -1;
  while (Date.now() <= deadline) {
    const core = decodeHubCoreRecord(
      await hub.adapter.read<unknown>(`entity/${hubEntityId}`),
    );
    latest = requireBoundaryInteger(
      core['lastFinalizedJHeight'],
      'HLT_AUTHORITY_HUB_J_HEIGHT_INVALID',
    );
    if (latest >= targetJHeight) return;
    await Bun.sleep(25);
  }
  throw new Error(
    `HLT_AUTHORITY_HUB_J_HEIGHT_TIMEOUT:target=${targetJHeight}:latest=${latest}`,
  );
};

const waitForCounterpartyDisputeState = async (options: Readonly<{
  lane: LaneRuntime;
  hubRuntimeId: string;
  hubEntityId: string;
  finalized: boolean;
}>): Promise<CounterpartyDisputeState | null> => {
  const deadline = Date.now() + DISPUTE_EVIDENCE_TIMEOUT_MS;
  let latest: Awaited<ReturnType<typeof readCounterpartyDispute>> = null;
  while (Date.now() <= deadline) {
    latest = await readCounterpartyDispute(
      options.lane,
      options.hubRuntimeId,
      options.hubEntityId,
    );
    if (!options.finalized && latest?.status === 'disputed' && latest.observedOnChain) return latest;
    // Quiescence omits Accounts after their active dispute is cleared. If a
    // pending diagnostic row remains, require the same terminal status.
    if (options.finalized && (latest === null || (
      latest.status === 'disputed' && !latest.observedOnChain
    ))) return latest;
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
  /**
   * Second lane for the reverse lifecycle. Immediate mutual-consent finalize
   * is a non-starter right, so the hub-recorded `disputeFinalize` command the
   * canonical coverage demands requires a dispute the LANE started.
   */
  reverseLane: LaneRuntime;
}>): Promise<void> => {
  const { hub, hubIdentity, lane, reverseLane } = options;
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

  // Reverse lifecycle: the lane starts, the hub (non-starter) finalizes
  // immediately — this is the only flow that records a `disputeFinalize`
  // command in the hub's own runtime input.
  await startLaneJurisdictionWatcher(reverseLane);
  await queueLaneRuntimeInputWave(0, [{
    lane: reverseLane,
    input: {
      runtimeTxs: [],
      entityInputs: [{
        entityId: reverseLane.identity.entityId,
        signerId: reverseLane.identity.signerId,
        entityTxs: [{
          type: 'prepareDispute',
          data: {
            counterpartyEntityId: hubIdentity.entityId,
            description: 'hlt-authority-reverse-dispute',
            minCooldownMs: 0,
          },
        }],
      }],
    },
  }], { waitForCommit: true });
  await queueLaneRuntimeInputWave(0, [{
    lane: reverseLane,
    input: {
      runtimeTxs: [],
      entityInputs: [{
        entityId: reverseLane.identity.entityId,
        signerId: reverseLane.identity.signerId,
        entityTxs: [{ type: 'j_broadcast', data: {} }],
      }],
    },
  }], { waitForCommit: true });
  const reverseStarted = await waitForCounterpartyDisputeState({
    lane: reverseLane,
    hubRuntimeId: hub.adapter.runtimeId,
    hubEntityId: hubIdentity.entityId,
    finalized: false,
  });
  if (!reverseStarted) throw new Error('HLT_AUTHORITY_REVERSE_DISPUTE_START_MISSING');
  // The starter's watcher becoming current does not prove the finalizer has
  // applied the same J prefix. The Entity J-height advances atomically with
  // event application, so wait for the actor's own certified prefix before
  // sending a command that is intentionally rejected pre-observation.
  await waitForHubFinalizedJHeight(
    hub,
    hubIdentity.entityId,
    reverseStarted.finalizedJHeight,
  );
  await sendObserved(hub, 'hlt-authority-dispute-finalize', {
    runtimeTxs: [],
    entityInputs: [{
      entityId: hubIdentity.entityId,
      signerId: hubIdentity.signerId,
      entityTxs: [{
        type: 'disputeFinalize',
        data: {
          counterpartyEntityId: reverseLane.identity.entityId,
          description: 'hlt-authority-reverse-mutual-consent',
        },
      }],
    }],
  });
  await sendObserved(hub, 'hlt-authority-dispute-finalize-broadcast', {
    runtimeTxs: [],
    entityInputs: [{
      entityId: hubIdentity.entityId,
      signerId: hubIdentity.signerId,
      entityTxs: [{ type: 'j_broadcast', data: {} }],
    }],
  });
  await waitForCounterpartyDisputeState({
    lane: reverseLane,
    hubRuntimeId: hub.adapter.runtimeId,
    hubEntityId: hubIdentity.entityId,
    finalized: true,
  });
  console.log(
    `HLT_AUTHORITY_REVERSE_DISPUTE_EVIDENCE_OK hub=${hubIdentity.entityId} ` +
    `starter=${reverseLane.identity.entityId}`,
  );
};

type HubAccountSettlementView = Readonly<{
  currentHeight: number;
  jNonce: number;
}>;

const readHubAccountSettlementView = async (
  hub: ConnectedRuntime,
  hubEntityId: string,
  counterpartyEntityId: string,
): Promise<HubAccountSettlementView> => {
  const doc = requireBoundaryRecord(
    await hub.adapter.read<unknown>(`entity/${hubEntityId}/account/${counterpartyEntityId}`),
    'HLT_AUTHORITY_SETTLEMENT_ACCOUNT_INVALID',
  );
  const state = requireBoundaryRecord(doc['state'], 'HLT_AUTHORITY_SETTLEMENT_ACCOUNT_STATE_INVALID');
  return {
    currentHeight: requireBoundaryInteger(
      doc['currentHeight'],
      'HLT_AUTHORITY_SETTLEMENT_ACCOUNT_HEIGHT_INVALID',
    ),
    jNonce: requireBoundaryInteger(state['jNonce'], 'HLT_AUTHORITY_SETTLEMENT_J_NONCE_INVALID'),
  };
};

const waitForHubAccountSettlement = async (options: Readonly<{
  hub: ConnectedRuntime;
  hubEntityId: string;
  counterpartyEntityId: string;
  code: string;
  predicate: (view: HubAccountSettlementView) => boolean;
}>): Promise<HubAccountSettlementView> => {
  const deadline = Date.now() + SETTLEMENT_EVIDENCE_TIMEOUT_MS;
  let latest: HubAccountSettlementView | null = null;
  while (Date.now() <= deadline) {
    latest = await readHubAccountSettlementView(
      options.hub,
      options.hubEntityId,
      options.counterpartyEntityId,
    );
    if (options.predicate(latest)) return latest;
    await Bun.sleep(25);
  }
  throw new Error(`${options.code}:${safeStringify(latest)}`);
};

/** Wait until the bilateral Account stops committing frames for one short
 * window. Settlement readiness is not exposed by the compact Account view, so
 * the observable proxy is Account height quiescence after the proposal. */
const waitForHubAccountQuiescence = async (
  hub: ConnectedRuntime,
  hubEntityId: string,
  counterpartyEntityId: string,
  minHeight: number,
  code: string,
): Promise<HubAccountSettlementView> => {
  const deadline = Date.now() + SETTLEMENT_EVIDENCE_TIMEOUT_MS;
  let stableSince = Date.now();
  let latest = await readHubAccountSettlementView(hub, hubEntityId, counterpartyEntityId);
  while (Date.now() <= deadline) {
    const next = await readHubAccountSettlementView(hub, hubEntityId, counterpartyEntityId);
    if (next.currentHeight !== latest.currentHeight) {
      latest = next;
      stableSince = Date.now();
    } else if (
      latest.currentHeight >= minHeight
      && Date.now() - stableSince >= SETTLEMENT_QUIESCENCE_MS
    ) return latest;
    await Bun.sleep(25);
  }
  throw new Error(`${code}:${safeStringify(latest)}`);
};

/** Produce one real bilateral settlement lifecycle on the production H1/lane
 * pair: settle_propose (reserve-to-reserve), counterparty hanko, settle_execute,
 * J batch broadcast, AccountSettled observation and its Account claim. Uses the
 * same commands as the Rust H1 Account settlement smoke; no synthetic event. */
export const materializeCompleteSettlementEvidence = async (options: Readonly<{
  hub: ConnectedRuntime;
  hubIdentity: LoadIdentity;
  lane: LaneRuntime;
  tokenId: number;
}>): Promise<void> => {
  const { hub, hubIdentity, lane, tokenId } = options;
  const hubEntityId = hubIdentity.entityId;
  const counterpartyEntityId = lane.identity.entityId;
  const account = { hub, hubEntityId, counterpartyEntityId } as const;
  await startLaneJurisdictionWatcher(lane);
  const before = await readHubAccountSettlementView(hub, hubEntityId, counterpartyEntityId);
  await sendObserved(hub, 'hlt-authority-settle-propose', {
    runtimeTxs: [],
    entityInputs: [{
      entityId: hubEntityId,
      signerId: hubIdentity.signerId,
      entityTxs: [{
        type: 'settle_propose',
        data: {
          counterpartyEntityId,
          ops: [{ type: 'r2r', tokenId, amount: 1n }],
          memo: 'hlt-authority-production-settlement',
        },
      }],
    }],
  });
  // The lane auto-approves a reserve-to-reserve move it does not pay for. The
  // hub Account advances by its proposal frame and the counterparty hanko.
  const ready = await waitForHubAccountQuiescence(
    hub, hubEntityId, counterpartyEntityId,
    before.currentHeight + 2,
    'HLT_AUTHORITY_SETTLEMENT_READY_TIMEOUT',
  );
  await sendObserved(hub, 'hlt-authority-settle-execute', {
    runtimeTxs: [],
    entityInputs: [{
      entityId: hubEntityId,
      signerId: hubIdentity.signerId,
      entityTxs: [{ type: 'settle_execute', data: { counterpartyEntityId } }],
    }],
  });
  const submitted = await waitForHubAccountSettlement({
    ...account,
    code: 'HLT_AUTHORITY_SETTLEMENT_SUBMITTED_TIMEOUT',
    predicate: view => view.currentHeight > ready.currentHeight,
  });
  await sendObserved(hub, 'hlt-authority-settle-broadcast', {
    runtimeTxs: [],
    entityInputs: [{
      entityId: hubEntityId,
      signerId: hubIdentity.signerId,
      entityTxs: [{ type: 'j_broadcast', data: {} }],
    }],
  });
  const finalized = await waitForHubAccountSettlement({
    ...account,
    code: 'HLT_AUTHORITY_SETTLEMENT_FINALITY_TIMEOUT',
    predicate: view => view.jNonce > before.jNonce && view.currentHeight > submitted.currentHeight,
  });
  console.log(
    `HLT_AUTHORITY_SETTLEMENT_EVIDENCE_OK hub=${hubEntityId} counterparty=${counterpartyEntityId} ` +
    `accountHeights=${before.currentHeight}->${ready.currentHeight}->${submitted.currentHeight}->${finalized.currentHeight} ` +
    `jNonce=${before.jNonce}->${finalized.jNonce}`,
  );
};

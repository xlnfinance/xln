/** Verify persisted cross-j economic state after the production processes restart. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { safeStringify } from '../../../../protocol/serialization';
import { decodeCrossLoadReport } from './cross-boundary';
import { decodeCrossRecoveryReport } from './cross-recovery-boundary';
import {
  decodeEntitySummaries,
  decodeLoadFrame,
  decodeRuntimeManifestEntries,
  selectLocalHubIdentity,
} from '../boundary/worker-boundary';
import { waitForSettledCrossRoute } from './worker-cross-state';
import {
  connectRuntime,
  entryByLabel,
  persistReport,
  type WorkerArgs,
} from '../worker-runtime';

const SOURCE_CHAIN_ID = 31_337;
const TARGET_CHAIN_ID = 31_338;

export const runCrossProductionRecovery = async (args: WorkerArgs): Promise<void> => {
  if (args.swaps !== 1) throw new Error('PRODUCTION_SWAP_LOAD_CROSS_RECOVERY_ONLY_N1');
  if (args.serverPidBeforeRestart === undefined || args.serverPidAfterRestart === undefined) {
    throw new Error('PRODUCTION_SWAP_LOAD_CROSS_RECOVERY_RESTART_PIDS_REQUIRED');
  }
  const previous = decodeCrossLoadReport(JSON.parse(readFileSync(
    join(args.workDir, 'production-cross-swap-load-report.json'),
    'utf8',
  )) as unknown);
  const entries = decodeRuntimeManifestEntries(JSON.parse(readFileSync(
    join(args.workDir, 'prod-mesh', 'runtime-import-manifest.json'),
    'utf8',
  )) as unknown);
  const hub = await connectRuntime(entryByLabel(entries, 'H1'));
  const load = await connectRuntime(
    entryByLabel(entries, 'Custody'),
    `ws://127.0.0.1:${args.portBase + 8}/rpc`,
  );
  try {
    const entities = decodeEntitySummaries(await hub.adapter.read<unknown>('entities'));
    const sourceHub = selectLocalHubIdentity(entities, hub.adapter.runtimeId, SOURCE_CHAIN_ID);
    const targetHub = selectLocalHubIdentity(entities, hub.adapter.runtimeId, TARGET_CHAIN_ID);
    await waitForSettledCrossRoute(
      hub,
      sourceHub.entityId,
      targetHub.entityId,
      previous.loadOrderId,
      BigInt(previous.sourceAmount),
      BigInt(previous.targetAmount),
    );
    const report = decodeCrossRecoveryReport({
      schema: 'xln-production-cross-swap-recovery-v1',
      completionAuthority: 'committed_route_descendant_heads_and_process_replacement',
      serverPidBeforeRestart: args.serverPidBeforeRestart,
      serverPidAfterRestart: args.serverPidAfterRestart,
      loadOrderId: previous.loadOrderId,
      sourceAmount: previous.sourceAmount,
      targetAmount: previous.targetAmount,
      routeStatus: 'settled',
      hubBeforeRestart: previous.hubDurableAfter,
      hubAfterRecovery: decodeLoadFrame(await hub.adapter.read<unknown>('frame/latest')),
      loadBeforeRestart: previous.loadDurableAfter,
      loadAfterRecovery: decodeLoadFrame(await load.adapter.read<unknown>('frame/latest')),
    });
    persistReport(
      join(args.workDir, 'production-cross-swap-recovery-report.json'),
      report,
      decodeCrossRecoveryReport,
    );
    console.log(safeStringify(report));
  } finally {
    hub.adapter.disconnect();
    load.adapter.disconnect();
  }
};

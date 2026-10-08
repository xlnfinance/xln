/** Cross-j harness reads the live transport's committed state, never an import file. */
import { join } from 'node:path';
import type { RuntimeInput } from '../../../../runtime/types';
import type { CrossJurisdictionSwapRoute } from '../../../../types/cross-jurisdiction';
import { safeParse } from '../../../../protocol/serialization';
import { requireBoundaryRecord, requireBoundaryInteger } from '../../../../protocol/boundary-validation';
import { validateEntityTx } from '../../../../entity/tx-validation';
import {
  decodeEntitySummaries,
  decodeLoadFrame,
  decodeRuntimeManifestEntries,
  selectLocalHubIdentity,
  type LoadFrame,
  type LoadIdentity,
  type LoadRuntimeEntry,
} from '../boundary/worker-boundary';
import {
  connectRuntime,
  directoryBytes,
  entryByLabel,
  exportReplayBaseSnapshotIfConfigured,
  readWithRateLimitRetry,
  resolveWalPath,
  sendObserved,
  type ConnectedRuntime,
  type WorkerArgs,
} from '../worker-runtime';
import { attachRustH1, fetchNativeJson, parseHltEngineSelection } from '../rust/rust-h1';
import { decodeCommittedCrossRoutes } from './cross-boundary';
import { collectHltEnvironmentManifest, type HltEnvironmentManifest } from '../boundary/environment-manifest';

export type CrossHub = Readonly<{
  environment: HltEnvironmentManifest;
  identity(chainId: number): LoadIdentity;
  routes(entityId: string): Promise<CrossJurisdictionSwapRoute[]>;
  frame(): Promise<LoadFrame>;
  walBytes(): Promise<number>;
  send(commandId: string, input: RuntimeInput): Promise<void>;
  exportReplayBase(): Promise<void>;
  close(): Promise<void>;
}>;

export const decodeNativeCrossState = (value: unknown, entityId: string) => {
  const state = requireBoundaryRecord(value, 'HLT_NATIVE_CROSS_STATE_INVALID');
  if (state['entityId'] !== entityId || typeof state['signerId'] !== 'string' || !state['signerId'])
    throw new Error('HLT_NATIVE_CROSS_STATE_IDENTITY');
  const frame = requireBoundaryRecord(state['frame'], 'HLT_NATIVE_CROSS_FRAME_INVALID');
  const height = requireBoundaryInteger(frame['height'], 'HLT_NATIVE_CROSS_FRAME_HEIGHT', 1);
  const canonicalStateHash = frame['canonicalStateHash'];
  if (typeof canonicalStateHash !== 'string' || !/^0x[0-9a-f]{64}$/.test(canonicalStateHash))
    throw new Error('HLT_NATIVE_CROSS_FRAME_ROOT');
  if (!Array.isArray(state['routes'])) throw new Error('HLT_NATIVE_CROSS_ROUTES_INVALID');
  const routes = state['routes'].map(route => {
    const tx = validateEntityTx(
      { type: 'prepareCrossJurisdictionSwap', data: { route } },
      'HLT_NATIVE_CROSS_ROUTE_INVALID',
    );
    if (tx.type !== 'prepareCrossJurisdictionSwap') throw new Error('HLT_NATIVE_CROSS_ROUTE_TYPE');
    return tx.data.route;
  });
  const jurisdiction = requireBoundaryRecord(state['jurisdiction'], 'HLT_NATIVE_CROSS_JURISDICTION');
  const chainId = Number(jurisdiction['chainId']);
  if (!Number.isSafeInteger(chainId) || chainId < 1) throw new Error('HLT_NATIVE_CROSS_CHAIN_ID');
  return {
    identity: { entityId, signerId: state['signerId'] },
    chainId,
    frame: { height, canonicalStateHash },
    routes,
  };
};

export const readNativeCrossState = async (api: string, entity: string) => {
  const response = await fetch(`${api}/api/cross-j/state?entityId=${encodeURIComponent(entity)}`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`HLT_NATIVE_CROSS_READ:${response.status}:${await response.text()}`);
  return decodeNativeCrossState(safeParse(await response.text()), entity);
};

/** Keep live capability authority while binding transport to this leased stack. */
export const bindCrossRuntimeEntry = (
  entries: readonly LoadRuntimeEntry[],
  label: 'H1' | 'Custody',
  portBase: number,
): LoadRuntimeEntry => ({
  ...entryByLabel(entries, label),
  wsUrl: `ws://127.0.0.1:${portBase + (label === 'Custody' ? 8 : 10)}/rpc`,
});

export const connectCrossRuntimes = async (args: WorkerArgs): Promise<{ hub: CrossHub; load: ConnectedRuntime }> => {
  const base = `http://127.0.0.1:${args.portBase + 4}`;
  // The orchestrator authorizes the actual loopback socket peer. This local
  // harness needs no bearer credential or persisted operator-token file.
  const response = await fetch(`${base}/api/runtime-import?access=admin`, {
    signal: AbortSignal.timeout(20_000),
  });
  const body = requireBoundaryRecord(await response.json(), 'HLT_CROSS_LIVE_IMPORT_INVALID');
  if (!response.ok || body['ok'] !== true || body['ready'] !== true)
    throw new Error(`HLT_CROSS_LIVE_IMPORT_NOT_READY:${response.status}`);
  const entries = decodeRuntimeManifestEntries({ importUrl: body['importUrl'], manifest: body['manifest'] });
  const load = await connectRuntime(bindCrossRuntimeEntry(entries, 'Custody', args.portBase));
  let closeHub: (() => Promise<void>) | undefined;
  try {
    if (parseHltEngineSelection(process.env).engine === 'ts') {
      const runtime = await connectRuntime(bindCrossRuntimeEntry(entries, 'H1', args.portBase));
      closeHub = async () => runtime.adapter.disconnect();
      const entities = decodeEntitySummaries(await readWithRateLimitRetry<unknown>(runtime, 'entities'));
      const hub: CrossHub = {
        environment: collectHltEnvironmentManifest({ engine: 'ts', requireAccountWorkers: true }),
        identity: chain => selectLocalHubIdentity(entities, runtime.adapter.runtimeId, chain),
        routes: async entity =>
          decodeCommittedCrossRoutes(await readWithRateLimitRetry<unknown>(runtime, `entity/${entity}`)),
        frame: async () => decodeLoadFrame(await readWithRateLimitRetry<unknown>(runtime, 'frame/latest')),
        walBytes: async () => directoryBytes(resolveWalPath(join(args.workDir, 'prod-mesh', 'h1'))),
        send: async (id, input) => {
          await sendObserved(runtime, id, input);
        },
        exportReplayBase: () => exportReplayBaseSnapshotIfConfigured(runtime),
        close: closeHub,
      };
      return { hub, load };
    }
    const api = `http://127.0.0.1:${args.portBase + 10}`;
    const native = await attachRustH1(api);
    closeHub = () => native.stop();
    const info = requireBoundaryRecord(await fetchNativeJson(`${api}/api/info`), 'HLT_NATIVE_CROSS_INFO');
    if (!Array.isArray(info['hubEntities'])) throw new Error('HLT_NATIVE_CROSS_ENTITIES');
    const read = (entity: string) => readNativeCrossState(api, entity);
    const states = await Promise.all(
      info['hubEntities'].map(row => {
        const entity = requireBoundaryRecord(row, 'HLT_NATIVE_CROSS_ENTITY')['entityId'];
        if (typeof entity !== 'string' || !/^0x[0-9a-f]{64}$/.test(entity))
          throw new Error('HLT_NATIVE_CROSS_ENTITY_ID');
        return read(entity);
      }),
    );
    const hub: CrossHub = {
      // The attached process owns its worker count; the driver environment may not contain it.
      environment: collectHltEnvironmentManifest({
        engine: 'rust', rustAccountWorkers: native.ready.workers, requireAccountWorkers: true,
      }),
      identity: chain => {
        const matches = states.filter(state => state.chainId === chain);
        if (matches.length !== 1) throw new Error(`HLT_NATIVE_CROSS_ENTITY_NOT_UNIQUE:${chain}`);
        return matches[0]!.identity;
      },
      routes: async entity => (await read(entity)).routes,
      frame: async () => (await read(native.ready.entityId)).frame,
      walBytes: async () =>
        requireBoundaryInteger(
          requireBoundaryRecord(await fetchNativeJson(`${api}/api/metrics`), 'HLT_NATIVE_METRICS')['retainedWalBytes'],
          'HLT_NATIVE_WAL_BYTES',
        ),
      send: async (id, input) => {
        if (input.runtimeTxs.length) throw new Error('HLT_NATIVE_CROSS_ENTITY_INPUTS_ONLY');
        await native.submitLocalEntityInputs(id, input.entityInputs);
      },
      exportReplayBase: async () => {
        if (process.env['XLN_RUNTIME_SNAPSHOT_EXPORT_PATH'])
          throw new Error('HLT_NATIVE_CROSS_REPLAY_USE_NATIVE_CHECKPOINT_WAL');
      },
      close: closeHub,
    };
    return { hub, load };
  } catch (error) {
    if (closeHub) await closeHub();
    load.adapter.disconnect();
    throw error;
  }
};

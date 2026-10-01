import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RemoteRuntimeAdapter } from '../../core/api/runtime-adapter/remote';
import { decodeRuntimeManifestEntries } from '../../core/scripts/operations/hlt/boundary/worker-boundary';
import { decodeCommittedCrossRoutes } from '../../core/scripts/operations/hlt/cross/cross-boundary';
import { readNativeCrossState } from '../../core/scripts/operations/hlt/cross/cross-hub';

/** Read the engine's existing committed projection; never submit a trade here. */
export async function readMarketRoutes(targetHubId: string, hubLabel: string) {
  if (process.env['XLN_HLT_ENGINE'] === 'rust' && hubLabel === 'H1') {
    const origin = new URL(process.env['UI_E2E_BASE_URL'] ?? '');
    if (origin.hostname !== '127.0.0.1' || !origin.port) throw new Error('NATIVE_MARKET_PRIVATE_ORIGIN_REQUIRED');
    const api = `http://127.0.0.1:${Number(origin.port) + 8}`;
    return (await readNativeCrossState(api, targetHubId)).routes;
  }
  const standRoot = process.env['XLN_RDB_ROOT'];
  if (!standRoot) throw new Error('Cross market observation requires XLN_RDB_ROOT');
  const manifest: unknown = JSON.parse(readFileSync(join(standRoot, 'prod-mesh', 'runtime-import-manifest.json'), 'utf8'));
  const entry = decodeRuntimeManifestEntries(manifest).find(candidate => candidate.label === hubLabel);
  if (!entry) throw new Error('Cross market hub runtime unavailable');
  const adapter = new RemoteRuntimeAdapter();
  try {
    await adapter.connect({ mode: 'remote', wsUrl: entry.wsUrl, authKey: entry.token, requestTimeoutMs: 5000 });
    return decodeCommittedCrossRoutes(await adapter.read<unknown>(`entity/${targetHubId}`));
  } finally {
    adapter.disconnect();
  }
}

import { readFileSync } from 'node:fs';
import { SigningKey, computeAddress, hexlify } from 'ethers';
import { deriveSignerKeySync } from '../../../core/account/crypto';
import { resolveMeshRuntimeSeed } from '../../../core/orchestrator/mesh/mesh-seeds';
import { RemoteRuntimeAdapter } from '../../../core/api/runtime-adapter/remote';
import { buildRuntimeAdapterOwnerBindingDigest } from '../../../core/api/runtime-adapter/security/owner-binding';
import type { RuntimeAdapterEntityCoreDoc } from '../../../core/api/runtime-adapter/read/context';

/** Local dev participants only. Keys stay inside this trusted test runner. */
export async function connectParticipant(name: 'H2' | 'H3') {
  const root = readFileSync('db/dev/secrets/mesh-root.seed', 'utf8').trim();
  const seed = resolveMeshRuntimeSeed(root, {}, name);
  const key = new SigningKey(hexlify(deriveSignerKeySync(seed, '1')));
  const runtimeId = computeAddress(key.publicKey).toLowerCase();
  const hubs = await fetch('http://127.0.0.1:8082/api/hubs').then(r => r.json());
  const hub = hubs.hubs.find((h: { name: string }) => h.name === name);
  if (!hub || hub.runtimeId !== runtimeId || hub.metadata.jurisdiction.chainId !== 31337) {
    throw new Error('AGENT_PROOF_LOCAL_TESTNET_REQUIRED');
  }
  const url = new URL(hub.wsUrl);
  url.pathname = '/rpc';
  if (url.hostname !== '127.0.0.1' || url.protocol !== 'ws:') throw new Error('AGENT_PROOF_LOOPBACK_REQUIRED');
  const adapter = new RemoteRuntimeAdapter();
  const manifest = JSON.parse(readFileSync('db/dev/rdb/mesh/runtime-import-manifest.json', 'utf8'));
  const access = manifest.manifest.entries.find((entry: { label: string }) => entry.label === name);
  if (!access) throw new Error('AGENT_PROOF_ACCESS_MISSING');
  await adapter.connect({
    mode: 'remote',
    runtimeId,
    wsUrl: url.toString(),
    authKey: access.token,
    ...(name === 'H2'
      ? {
          ownerBindingSigner: ({ runtimeId, challenge, capability }) =>
            key.sign(buildRuntimeAdapterOwnerBindingDigest(runtimeId, challenge, capability)).serialized,
        }
      : {}),
  });
  const core = await adapter.read<RuntimeAdapterEntityCoreDoc>(`entity/${hub.entityId}`);
  if (!core.signerId) throw new Error('AGENT_PROOF_SIGNER_MISSING');
  return {
    adapter,
    entityId: String(hub.entityId),
    signerId: core.signerId,
    currency: `xln:eip155:31337/depository:${hub.metadata.jurisdiction.depositoryAddress.toLowerCase()}/token:1`,
  };
}

if (import.meta.main) {
  for (const name of ['H2', 'H3'] as const) {
    const p = await connectParticipant(name);
    console.log(name, p.entityId, p.adapter.currentHeight, p.adapter.commandReady, p.adapter.commandLaneKind);
    p.adapter.disconnect();
  }
}

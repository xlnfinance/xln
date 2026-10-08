import type { EncryptedRuntimeRecoveryBundleV1, RuntimeReplica } from '@xln/core/api/public/runtime-module';
import {
  buildDelayedLastResortAppointments,
  type LastResortEntityContext,
  type LastResortTowerAppointmentUpload,
} from '@xln/core/watchtower/last-resort-appointment';
import { isMapLike } from '#lib/utils/runtime/liveRuntimeEnv.ts';
import { resolveRpcUrl } from './vault-helpers';
import {
  findEntityReplicaByEntityAndSigner,
  findJReplicaByName,
  getEntityReplicaJurisdictionName,
  getJReplicaContractAddress,
  getSignerDerivationIndex,
  normalizeEntityId,
  normalizeRuntimeId,
  type RecoveryTowerConfig,
  type Runtime,
} from './vault-recovery';

export type { LastResortTowerAppointmentUpload };

/**
 * Vault-side adapter for the canonical last-resort appointment builder.
 *
 * The proof, remedy, owner authorization and appointment envelope are built in
 * `core/watchtower/last-resort-appointment`, shared with every other wallet.
 * What is vault-specific is only the walk: this vault knows which signer owns
 * which Entity, and which browser-reachable RPC URL that Entity's jurisdiction
 * is behind.
 */
const collectWatchedEntities = (runtime: Runtime, env: RuntimeReplica): LastResortEntityContext[] => {
  const entities: LastResortEntityContext[] = [];
  for (const signer of runtime.signers || []) {
    const entityId = normalizeEntityId(signer.entityId);
    const signerAddress = normalizeRuntimeId(signer.address);
    if (!entityId || !signerAddress) continue;

    const replica = findEntityReplicaByEntityAndSigner(env, entityId, signerAddress);
    if (!replica || !isMapLike(replica.state?.accounts)) continue;

    const jurisdictionName =
      getEntityReplicaJurisdictionName(replica) ||
      String(signer.jurisdiction || '').trim() ||
      String(env.activeJurisdiction || '').trim();
    const jReplica = findJReplicaByName(env, jurisdictionName);
    if (!jReplica) continue;

    let depositoryAddress = '';
    try {
      depositoryAddress = getJReplicaContractAddress(jReplica, 'depository');
    } catch {
      continue;
    }
    const chainId = Number(jReplica.chainId ?? 0);
    if (!Number.isFinite(chainId) || chainId <= 0) continue;

    const rpcBase = String(jReplica.rpcs?.[0] || '').trim();
    if (!rpcBase) continue;

    entities.push({
      entityId,
      signerDerivationIndex: getSignerDerivationIndex(signer),
      chainId,
      depositoryAddress,
      rpcUrl: resolveRpcUrl(rpcBase),
      entityState: replica.state,
    });
  }
  return entities;
};

export async function buildDelayedLastResortAppointmentsForTower(
  runtime: Runtime,
  env: RuntimeReplica,
  tower: RecoveryTowerConfig,
  towerSignerAddress: string,
  encryptedBundle: EncryptedRuntimeRecoveryBundleV1,
): Promise<LastResortTowerAppointmentUpload[]> {
  const normalizedRuntimeId = normalizeRuntimeId(runtime.id);
  if (!normalizedRuntimeId || !runtime.seed) return [];
  return await buildDelayedLastResortAppointments(
    {
      runtimeId: normalizedRuntimeId,
      seed: runtime.seed,
      jReplicas: env.state.jReplicas,
      tower,
      towerSignerAddress,
      encryptedBundle,
    },
    collectWatchedEntities(runtime, env),
  );
}

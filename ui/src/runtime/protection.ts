import { isAddress } from 'ethers';
import type { RuntimeReplica, TowerReceiptV1, XLNModule } from '@xln/core/api/public/runtime-module';
import { withRuntimeCommittedRead } from '@xln/core/runtime/frame/lifecycle/writer-lock';
import type {
  LastResortEntityContext,
  LastResortTowerAppointmentUpload,
} from '@xln/core/watchtower/last-resort-appointment';
import { encryptTip, recoverySigners, towerHealth, towerRequestUrl } from './recovery';

export type ProtectionReceipt = {
  url: string;
  entityId: string;
  counterparty: string;
  proofHash: string;
  proofNonce: number;
  windowSeconds: number;
  receipt: TowerReceiptV1;
  automaticResponseEnabled: boolean;
};
export type ProtectionResult = { receipts: ProtectionReceipt[]; errors: string[] };

function watchedEntities(env: RuntimeReplica, seed: string): LastResortEntityContext[] {
  const signers = recoverySigners(env, seed);
  return [...env.state.eReplicas.values()].map(replica => {
    const signer = signers.find(value => value.address === String(replica.signerId).toLowerCase());
    if (!signer) throw new Error(`PROTECTION_SIGNER_MISSING:${replica.entityId}`);
    const name = replica.state.config.jurisdiction?.name;
    const jurisdiction = [...env.state.jReplicas.values()].find(value => value.name === name);
    if (!jurisdiction) throw new Error(`PROTECTION_JURISDICTION_MISSING:${name}`);
    const chainId = jurisdiction.chainId;
    const depositoryAddress = jurisdiction.contracts?.depository;
    const rpc = jurisdiction.rpcs?.[0];
    if (!chainId || !Number.isSafeInteger(chainId) || !depositoryAddress || !isAddress(depositoryAddress) || !rpc) {
      throw new Error(`PROTECTION_JURISDICTION_INVALID:${name}`);
    }
    return {
      entityId: String(replica.entityId).toLowerCase(),
      signerDerivationIndex: signer.derivationIndex ?? signer.index,
      chainId,
      depositoryAddress,
      rpcUrl: new URL(rpc, window.location.origin).toString(),
      entityState: replica.state,
    };
  });
}

/** Accept only a receipt for the exact submitted account proof. HTTP success alone is insufficient. */
export function acceptProtectionReceipt(
  value: unknown,
  appointment: LastResortTowerAppointmentUpload['appointment'],
): TowerReceiptV1 {
  if (!value || typeof value !== 'object') throw new Error('TOWER_RECEIPT_MISSING');
  const receipt = value as TowerReceiptV1;
  if (
    receipt.type !== 'tower_receipt' ||
    receipt.version !== 1 ||
    receipt.towerMode !== 'delayed_last_resort' ||
    receipt.lookupKey !== appointment.lookupKey ||
    receipt.runtimeId !== appointment.bundle.runtimeId ||
    receipt.bundleHash !== appointment.bundle.bundleHash ||
    receipt.height !== appointment.bundle.height ||
    receipt.appointmentSequence !== appointment.lastResortPayload?.appointmentSequence ||
    receipt.quotaOk !== true ||
    !Number.isSafeInteger(receipt.expiresAt) ||
    Number(receipt.expiresAt) <= Date.now()
  ) {
    throw new Error('TOWER_PROTECTION_RECEIPT_MISMATCH_OR_EXPIRED');
  }
  return receipt;
}

/** Core owns signing and the exact remedy. The wallet resolves owned entities and transports envelopes. */
export async function appointProtection(
  xln: XLNModule,
  env: RuntimeReplica,
  seed: string,
  towers: string[],
): Promise<ProtectionResult> {
  const encryptedBundle = await encryptTip(xln, env, seed);
  if (!encryptedBundle) throw new Error('No committed state to protect yet.');
  const result: ProtectionResult = { receipts: [], errors: [] };
  for (const url of towers) {
    try {
      const health = await towerHealth(url);
      if (!isAddress(health.signerAddress)) throw new Error('TOWER_SIGNER_ADDRESS_INVALID');
      const { uploads, failures } = await withRuntimeCommittedRead(env, () =>
        xln.buildDelayedLastResortAppointments(
          {
            runtimeId: String(env.runtimeId).toLowerCase(),
            seed,
            jReplicas: env.state.jReplicas,
            tower: { url },
            towerSignerAddress: health.signerAddress,
            encryptedBundle,
          },
          watchedEntities(env, seed),
        ),
      );
      // An account that cannot be appointed is reported; the others still upload.
      for (const failure of failures) {
        result.errors.push(`${url}: ${failure.entityId}:${failure.counterpartyId}:${failure.error}`);
      }
      if (uploads.length === 0 && failures.length === 0) {
        throw new Error('No eligible signed account proofs. Make a payment and try again.');
      }
      for (const { appointment } of uploads) {
        const response = await fetch(towerRequestUrl(url, '/api/tower/appointment'), {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(appointment),
        });
        const payload = (await response.json()) as { ok?: boolean; receipt?: unknown; error?: string };
        if (!response.ok || payload.ok !== true) throw new Error(payload.error || `HTTP_${response.status}`);
        const receipt = acceptProtectionReceipt(payload.receipt, appointment);
        const scope = appointment.lastResortPayload!;
        result.receipts.push({
          url,
          entityId: scope.watch.watchedEntityId,
          counterparty: scope.watch.counterentity,
          proofHash: scope.proofBodyHash,
          proofNonce: scope.proofNonce,
          windowSeconds: scope.lastResortWindowSeconds,
          receipt,
          automaticResponseEnabled: health.sweepEnabled,
        });
      }
    } catch (error) {
      result.errors.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}

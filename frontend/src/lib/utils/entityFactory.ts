/**
 * Entity Factory - Auto-create ephemeral entities for signers
 */

import { get } from 'svelte/store';
import { keccak256, toUtf8Bytes } from 'ethers';
import type { Env } from '@xln/runtime/xln-api';

/**
 * Generate deterministic ephemeral entity ID from signer address
 * Format: keccak256(signerId + timestamp)
 */
export function generateEphemeralEntityId(signerId: string): string {
  const data = signerId + Date.now().toString();
  return keccak256(toUtf8Bytes(data));
}

/**
 * Create ephemeral entity for a signer in a jurisdiction
 * Returns the entity ID
 */
export async function createEphemeralEntity(
  signerId: string,
  jurisdiction: string,
  env: Env
): Promise<string> {
  const { getXLN } = await import('$lib/stores/xlnStore');
  const xln = await getXLN();

  const entityId = generateEphemeralEntityId(signerId);

  // Create RuntimeInput to import entity replica
  const runtimeInput = {
    runtimeTxs: [{
      type: 'importReplica' as const,
      entityId,
      signerId,
      data: {
        isProposer: true,
        config: {
          mode: 'proposer-based' as const,
          threshold: 1n,
          validators: [signerId],
          shares: { [signerId]: 1n },
          jurisdiction: {
            name: jurisdiction,
            address: '0x0000000000000000000000000000000000000000', // Will be set by runtime
            entityProviderAddress: '0x0000000000000000000000000000000000000000',
            depositoryAddress: '0x0000000000000000000000000000000000000000'
          }
        }
      }
    }],
    entityInputs: []
  };

  // Apply runtime input
  await xln.applyRuntimeInput(env, runtimeInput);

  console.log(`[EntityFactory] Created ephemeral entity ${entityId.slice(0, 10)} for signer ${signerId.slice(0, 10)}`);

  return entityId;
}

/**
 * Auto-create entity when signer is added to vault
 * Hook this into vaultStore operations
 */
export async function autoCreateEntityForSigner(
  signerAddress: string,
  jurisdiction: string = 'default'
): Promise<string | null> {
  try {
    const { xlnEnvironment } = await import('$lib/stores/xlnStore');
    const env = get(xlnEnvironment);

    if (!env) {
      console.warn('[EntityFactory] No env available, skipping auto-create');
      return null;
    }

    const entityId = await createEphemeralEntity(signerAddress, jurisdiction, env);
    return entityId;
  } catch (error) {
    console.error('[EntityFactory] Failed to auto-create entity:', error);
    return null;
  }
}

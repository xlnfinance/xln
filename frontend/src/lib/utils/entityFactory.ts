/**
 * Entity Factory - Auto-create ephemeral entities for signers
 */

import { get } from 'svelte/store';
import { keccak256, toUtf8Bytes } from 'ethers';
import type { Env } from '@xln/runtime/xln-api';

type JurisdictionConfig = {
  name: string;
  address: string;
  entityProviderAddress: string;
  depositoryAddress: string;
  chainId?: number;
};

const inflightAutoCreates = new Map<string, Promise<string | null>>();
let warnedMissingEnv = false;
let isCreatingJMachine = false;

/**
 * Counter for deterministic ephemeral entity ID generation
 * Ensures same signer + counter always generates same entity ID
 */
let ephemeralEntityCounter = 0;

/**
 * Generate deterministic ephemeral entity ID from signer address
 * Format: keccak256(signerId + counter)
 * Uses counter instead of Date.now() to maintain RJEA determinism
 */
export function generateEphemeralEntityId(signerId: string): string {
  const data = signerId + (ephemeralEntityCounter++).toString();
  return keccak256(toUtf8Bytes(data));
}

/**
 * Create ephemeral entity for a signer in a jurisdiction
 * Uses lazy entity ID (deterministic from validators)
 * References deployed contracts (not null addresses)
 */
export async function createEphemeralEntity(
  signerId: string,
  jurisdictionName: string,
  env: Env
): Promise<string> {
  const jurisdiction = buildJurisdictionConfig(env, jurisdictionName);
  if (!jurisdiction) {
    throw new Error(`No jurisdiction config for ${jurisdictionName}`);
  }

  const { getXLN } = await import('$lib/stores/xlnStore');
  const xln = await getXLN();

  // Use LAZY entity ID (deterministic, no blockchain registration)
  // For lazy entities: entityId == boardHash (as per EntityProvider contract)
  //
  // TODO(provider-scoped-entities): See vaultStore.ts for full design notes
  // Current: entityId = boardHash (works for single EP per Depository)
  // Future: entityAddress = hash(providerAddress + entityId) for multi-EP support
  const entityId = xln.generateLazyEntityId([signerId], 1n);
  console.log(`[EntityFactory] Entity ID: ${entityId.slice(0, 18)}...`);
  console.log(`[EntityFactory]   signer: ${signerId}`);
  console.log(`[EntityFactory]   provider: ${jurisdiction.entityProviderAddress}`);

  // Use createLazyEntity from runtime for proper config structure
  const { config } = xln.createLazyEntity(
    `self-${signerId.slice(2, 8)}`,
    [signerId],
    1n,
    jurisdiction
  );

  // Create RuntimeInput to import entity replica
  const runtimeInput = {
    runtimeTxs: [{
      type: 'importReplica' as const,
      entityId,
      signerId,
      data: {
        isProposer: true,
        config
      }
    }],
    entityInputs: []
  };

  // Apply runtime input
  await xln.applyRuntimeInput(env, runtimeInput);

  return entityId;
}

function findReplicaBySigner(env: Env, signerId: string): any | null {
  const reps = (env as any)?.eReplicas;
  if (!reps) return null;
  const replicas = reps instanceof Map ? reps : new Map(Object.entries(reps || {}));
  for (const [, replica] of replicas) {
    const rep = replica as any;
    if (rep?.signerId?.toLowerCase?.() === signerId.toLowerCase()) {
      return rep;
    }
  }
  return null;
}

function listJMachineNames(env: Env): string[] {
  const jReplicas = (env as any)?.jReplicas;
  if (!jReplicas) return [];
  if (jReplicas instanceof Map) return Array.from(jReplicas.keys());
  if (Array.isArray(jReplicas)) return jReplicas.map((jr: any) => jr?.name).filter(Boolean);
  return Object.keys(jReplicas || {});
}

function getJReplica(env: Env, name?: string): any | null {
  const jReplicas = (env as any)?.jReplicas;
  if (!jReplicas) return null;
  if (jReplicas instanceof Map) {
    if (name && jReplicas.has(name)) return jReplicas.get(name);
    return jReplicas.values().next().value || null;
  }
  if (Array.isArray(jReplicas)) {
    if (name) return jReplicas.find((jr: any) => jr?.name === name) || null;
    return jReplicas[0] || null;
  }
  if (name && jReplicas[name]) return jReplicas[name];
  const record = jReplicas as Record<string, any>;
  const keys = Object.keys(record);
  const firstKey = keys[0];
  if (!firstKey) return null;
  return record[firstKey];
}

function buildJurisdictionConfig(env: Env, name?: string): JurisdictionConfig | null {
  const jReplica = getJReplica(env, name);
  if (!jReplica) {
    console.error(`[buildJurisdictionConfig] ❌ ASSERT FAILED: No J-replica found for "${name}"`);
    console.error(`   Available J-machines:`, listJMachineNames(env));
    throw new Error(`J-machine "${name}" not found in runtime`);
  }

  // Support both top-level (new) and nested (legacy) contract addresses
  const depositoryAddress = jReplica?.depositoryAddress || jReplica?.contracts?.depository || jReplica?.contracts?.depositoryAddress;
  const entityProviderAddress = jReplica?.entityProviderAddress || jReplica?.contracts?.entityProvider || jReplica?.contracts?.entityProviderAddress;

  if (!depositoryAddress || !entityProviderAddress) {
    console.error(`[buildJurisdictionConfig] ❌ Contracts not deployed for J-machine "${name}"`);
    console.error(`   Depository:`, depositoryAddress || 'MISSING');
    console.error(`   EntityProvider:`, entityProviderAddress || 'MISSING');
    throw new Error(`J-machine "${name}" contracts not deployed`);
  }

  return {
    name: jReplica?.name || name || 'browservm',
    address: 'browservm://',
    entityProviderAddress,
    depositoryAddress,
  };
}

async function ensureJMachine(env: Env): Promise<string | null> {
  if (isCreatingJMachine) return null;

  const names = listJMachineNames(env);
  if (names.length > 0) {
    return (env as any)?.activeJurisdiction || names[0];
  }

  isCreatingJMachine = true;
  try {
    const { getXLN } = await import('$lib/stores/xlnStore');
    const xln = await getXLN();
    const name = 'xlnomy1';

    await xln.applyRuntimeInput(env, {
      runtimeTxs: [{
        type: 'importJ',
        data: {
          name,
          chainId: 1337, // Must match View.svelte's BrowserVM chainId
          ticker: 'SIM',
          rpcs: [],
        }
      }],
      entityInputs: []
    });

    // ASSERT: J-machine created successfully
    const jReplica = getJReplica(env, name);
    if (!jReplica) {
      throw new Error('Failed to create J-machine - not found in env.jReplicas');
    }

    // ASSERT: Contracts deployed (support both top-level and legacy nested)
    const depository = jReplica?.depositoryAddress || jReplica?.contracts?.depository || jReplica?.contracts?.depositoryAddress;
    const entityProvider = jReplica?.entityProviderAddress || jReplica?.contracts?.entityProvider || jReplica?.contracts?.entityProviderAddress;

    if (!depository || !entityProvider) {
      console.error('[ensureJMachine] ❌ Contracts not deployed');
      console.error('   Depository:', depository || 'MISSING');
      console.error('   EntityProvider:', entityProvider || 'MISSING');
      throw new Error(`J-machine "${name}" contracts not deployed`);
    }

    return name;
  } catch (err) {
    console.error('[ensureJMachine] ❌ Failed:', err);
    throw err;
  } finally {
    isCreatingJMachine = false;
  }
}

/**
 * Create self-entity for signer (lazy, no blockchain registration)
 * Wrapper for backward compatibility
 */
export async function createNumberedSelfEntity(
  env: Env,
  signerAddress: string,
  jurisdictionName?: string
): Promise<string | null> {
  const jName = jurisdictionName || (env as any)?.activeJurisdiction || await ensureJMachine(env);
  if (!jName) return null;

  return await createEphemeralEntity(signerAddress, jName, env);
}

/**
 * Auto-create entity when signer is added to vault
 * Hook this into vaultStore operations
 */
export async function autoCreateEntityForSigner(
  signerAddress: string,
  jurisdiction: string = 'default'
): Promise<string | null> {
  if (!signerAddress) return null;
  if (inflightAutoCreates.has(signerAddress)) {
    return inflightAutoCreates.get(signerAddress) || null;
  }

  const task = (async () => {
    try {
      const { xlnEnvironment } = await import('$lib/stores/xlnStore');
      const { activeEnv } = await import('$lib/stores/runtimeStore');
      const env = get(xlnEnvironment) || get(activeEnv);

      if (!env) {
        if (!warnedMissingEnv) {
          warnedMissingEnv = true;
          console.warn('[EntityFactory] No env available, skipping auto-create');
        }
        return null;
      }

      const existing = findReplicaBySigner(env, signerAddress);
      if (existing?.entityId) return existing.entityId;

      const names = listJMachineNames(env);
      const targetJurisdiction =
        (jurisdiction && jurisdiction !== 'default' && names.includes(jurisdiction))
          ? jurisdiction
          : (env.activeJurisdiction || names[0] || null);

      return await createNumberedSelfEntity(env, signerAddress, targetJurisdiction || undefined);
    } catch (error) {
      console.error('[EntityFactory] Failed to auto-create entity:', error);
      return null;
    }
  })();

  inflightAutoCreates.set(signerAddress, task);
  try {
    return await task;
  } finally {
    inflightAutoCreates.delete(signerAddress);
  }
}

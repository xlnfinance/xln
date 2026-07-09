/**
 * Entity Factory - Auto-create ephemeral entities for signers
 */

import { keccak256, toUtf8Bytes } from 'ethers';
import type { Env, EntityReplica } from '@xln/runtime/xln-api';
import { unwrapLiveRuntimeEnv } from './liveRuntimeEnv';
import { getXLN, submitRuntimeInput } from '$lib/stores/xlnStore';

type JurisdictionConfig = {
  name: string;
  address: string;
  entityProviderAddress: string;
  depositoryAddress: string;
  chainId?: number;
};

type JReplica = Env['jReplicas'] extends Map<string, infer T> ? T : never;

const inflightAutoCreates = new Map<string, Promise<string | null>>();
let isCreatingJMachine = false;

const normalizeJurisdictionKey = (value: string | null | undefined): string =>
  String(value || '').trim().toLowerCase();

async function waitForCondition(
  check: () => boolean,
  label: string,
  timeoutMs = 30_000,
  intervalMs = 50,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`[EntityFactory] Timeout waiting for condition: ${label}`);
}

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
  const runtimeEnv = unwrapLiveRuntimeEnv(env) ?? env;
  const existing = findReplicaBySigner(runtimeEnv, signerId);
  const existingJurisdiction = String(existing?.state?.config?.jurisdiction?.name || '').trim();
  if (existing?.entityId && normalizeJurisdictionKey(existingJurisdiction) !== normalizeJurisdictionKey(jurisdictionName)) {
    throw new Error(
      `SIGNER_JURISDICTION_CONFLICT: signer=${signerId} entity=${existing.entityId} existing=${existingJurisdiction} incoming=${jurisdictionName}`,
    );
  }

  const jurisdiction = buildJurisdictionConfig(runtimeEnv, jurisdictionName);
  if (!jurisdiction) {
    throw new Error(`No jurisdiction config for ${jurisdictionName}`);
  }

  const xln = await getXLN();

  // Lazy entities are addressed by the EntityProvider board hash.
  const entityId = xln.generateLazyEntityId([signerId], 1n);

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
        config,
        profileName: `self-${signerId.slice(2, 8)}`,
      }
    }],
    entityInputs: []
  };

  // Apply runtime input through the shared command path so receipts and permissions stay consistent.
  await submitRuntimeInput(runtimeInput);
  await waitForCondition(
    () => {
      const expected = String(entityId).toLowerCase();
      for (const key of runtimeEnv.eReplicas.keys()) {
        const repEntity = String(key).split(':')[0];
        if (String(repEntity || '').toLowerCase() === expected) return true;
      }
      return false;
    },
    `importReplica(${entityId.slice(0, 12)})`
  );

  return entityId;
}

function findReplicaBySigner(env: Env, signerId: string, jurisdictionName?: string | null): EntityReplica | null {
  const jurisdictionLower = String(jurisdictionName || '').trim().toLowerCase();
  for (const replica of env.eReplicas.values()) {
    const replicaJurisdiction = String(replica.state?.config?.jurisdiction?.name || '').trim().toLowerCase();
    if (
      replica.signerId.toLowerCase() === signerId.toLowerCase() &&
      (!jurisdictionLower || replicaJurisdiction === jurisdictionLower)
    ) {
      return replica;
    }
  }
  return null;
}

function listJMachineNames(env: Env): string[] {
  return Array.from(env.jReplicas.keys());
}

function formatJMachineNames(env: Env): string {
  const names = listJMachineNames(env);
  return names.length > 0 ? names.join(', ') : 'none';
}

function getJReplica(env: Env, name?: string): JReplica | null {
  const normalized = normalizeJurisdictionKey(name);
  if (name) {
    const direct = env.jReplicas.get(name);
    if (direct) return direct;
    for (const replica of env.jReplicas.values()) {
      if (normalizeJurisdictionKey(replica?.name) === normalized) return replica;
    }
    return null;
  }
  return env.jReplicas.values().next().value ?? null;
}

function buildJurisdictionConfig(env: Env, name?: string): JurisdictionConfig | null {
  const jReplica = getJReplica(env, name);
  if (!jReplica) {
    throw new Error(
      `J-machine "${name || 'default'}" not found in runtime; available=${formatJMachineNames(env)}`,
    );
  }

  const depositoryAddress = jReplica.depositoryAddress;
  const entityProviderAddress = jReplica.entityProviderAddress;

  if (!depositoryAddress || !entityProviderAddress) {
    throw new Error(
      `J-machine "${name || jReplica.name || 'default'}" contracts not deployed; ` +
      `depository=${depositoryAddress || 'MISSING'} entityProvider=${entityProviderAddress || 'MISSING'}`,
    );
  }

  const rpcAddress = Array.isArray(jReplica.rpcs) && jReplica.rpcs.length > 0
    ? jReplica.rpcs[0]!
    : 'browservm://';

  return {
    name: jReplica.name || name || 'browservm',
    address: rpcAddress,
    entityProviderAddress,
    depositoryAddress,
    ...(jReplica.chainId ? { chainId: jReplica.chainId } : {}),
  };
}

async function ensureJMachine(env: Env): Promise<string | null> {
  if (isCreatingJMachine) return null;

  const names = listJMachineNames(env);
  if (names.length > 0) {
    return names[0] || env.activeJurisdiction || null;
  }

  isCreatingJMachine = true;
  try {
    throw new Error('No jurisdiction machine found - VaultStore should import the default jurisdictions first');
  } finally {
    isCreatingJMachine = false;
  }
}

/**
 * Create self-entity for signer (lazy, no blockchain registration)
 */
export async function createSelfEntity(
  env: Env,
  signerAddress: string,
  jurisdictionName?: string
): Promise<string | null> {
  const runtimeEnv = unwrapLiveRuntimeEnv(env) ?? env;
  const jName = jurisdictionName || await ensureJMachine(runtimeEnv);
  if (!jName) return null;

  return await createEphemeralEntity(signerAddress, jName, runtimeEnv);
}

/**
 * Auto-create entity when signer is added to vault
 * Hook this into vaultStore operations
 */
export async function autoCreateEntityForSigner(
  signerAddress: string,
  env: Env,
  jurisdiction: string = 'default',
): Promise<string | null> {
  if (!signerAddress) return null;
  const inflightKey = `${signerAddress.toLowerCase()}:${normalizeJurisdictionKey(jurisdiction || 'default')}`;
  if (inflightAutoCreates.has(inflightKey)) {
    return inflightAutoCreates.get(inflightKey) || null;
  }

  const task = (async () => {
    const runtimeEnv = unwrapLiveRuntimeEnv(env) ?? env;

    if (!runtimeEnv) {
      throw new Error('[EntityFactory] No runtime env available for auto-create');
    }

    const names = listJMachineNames(runtimeEnv);
    const targetJurisdiction =
      (jurisdiction && jurisdiction !== 'default' && names.includes(jurisdiction))
        ? jurisdiction
        : (names[0] || runtimeEnv.activeJurisdiction || null);

    const existing = findReplicaBySigner(runtimeEnv, signerAddress, targetJurisdiction);
    if (existing?.entityId) return existing.entityId;
    const existingForSigner = findReplicaBySigner(runtimeEnv, signerAddress);
    const existingJurisdiction = String(existingForSigner?.state?.config?.jurisdiction?.name || '').trim();
    if (
      existingForSigner?.entityId &&
      targetJurisdiction &&
      normalizeJurisdictionKey(existingJurisdiction) !== normalizeJurisdictionKey(targetJurisdiction)
    ) {
      throw new Error(
        `Refusing to create signer entity in another jurisdiction: ` +
        `signer=${signerAddress.slice(0, 10)} existing=${existingJurisdiction} incoming=${targetJurisdiction}`,
      );
    }

    return await createSelfEntity(runtimeEnv, signerAddress, targetJurisdiction || undefined);
  })();

  inflightAutoCreates.set(inflightKey, task);
  try {
    return await task;
  } finally {
    inflightAutoCreates.delete(inflightKey);
  }
}

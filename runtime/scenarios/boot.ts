/**
 * Shared scenario boot utilities
 * Common setup code for all scenarios
 */

import type { Env, JurisdictionConfig } from '../types';
import type { JAdapter, JAdapterMode } from '../jadapter/types';

export type { JAdapterMode };

/**
 * Get JAdapter mode from environment
 * Set via: JADAPTER_MODE=browservm|rpc (default: browservm)
 */
export function getJAdapterMode(): JAdapterMode {
  const mode = process.env.JADAPTER_MODE?.toLowerCase();
  if (mode === 'rpc' || mode === 'anvil') return mode as JAdapterMode;
  return 'browservm';
}

/**
 * Create JAdapter based on mode flag
 *
 * Usage:
 *   # Default (browservm - no external dependencies)
 *   bun runtime/scenarios/htlc-4hop.ts
 *
 *   # Against Anvil (requires: anvil running on 8545)
 *   JADAPTER_MODE=rpc ANVIL_RPC=http://localhost:8545 bun runtime/scenarios/htlc-4hop.ts
 */
export async function ensureJAdapter(env?: Env, mode?: JAdapterMode): Promise<JAdapter> {
  const { createJAdapter } = await import('../jadapter');
  const { setBrowserVMJurisdiction } = await import('../evm');

  const actualMode = mode ?? getJAdapterMode();
  const rpcUrl = process.env.ANVIL_RPC || 'http://localhost:8545';

  console.log(`[JAdapter] Mode: ${actualMode}${actualMode !== 'browservm' ? ` (${rpcUrl})` : ''}`);

  const jadapter = await createJAdapter({
    mode: actualMode,
    chainId: 31337,
    rpcUrl: actualMode !== 'browservm' ? rpcUrl : undefined,
  });

  // If browservm and env provided, register the BrowserVM instance
  if (actualMode === 'browservm' && env) {
    const browserVM = jadapter.getBrowserVM();
    if (browserVM) {
      (env as any).browserVM = browserVM;
      setBrowserVMJurisdiction(env, jadapter.addresses.depository, browserVM);
    }
  }

  return jadapter;
}

/**
 * Create or get BrowserVM instance (legacy - use ensureJAdapter instead)
 */
export async function ensureBrowserVM(env: any) {
  const { getBrowserVMInstance, setBrowserVMJurisdiction } = await import('../evm');
  let browserVM = getBrowserVMInstance(env);

  if (!browserVM) {
    const { BrowserVMProvider } = await import('../jadapter');
    browserVM = new BrowserVMProvider();
    await browserVM.init();
    env.browserVM = browserVM; // Store in env for isolation
    const depositoryAddress = browserVM.getDepositoryAddress();
    setBrowserVMJurisdiction(env, depositoryAddress, browserVM);
  }

  return browserVM;
}

/**
 * Create jReplica (J-Machine) for a jurisdiction
 */
export function createJReplica(
  env: Env,
  name: string,
  depositoryAddress: string,
  position: { x: number; y: number; z: number } = { x: 0, y: 600, z: 0 }
) {
  if (!env.jReplicas) {
    env.jReplicas = new Map();
  }

  const jReplica = {
    name,
    blockNumber: 0n,
    stateRoot: new Uint8Array(32),
    mempool: [],
    blockDelayMs: 300,
    lastBlockTimestamp: env.timestamp,
    position,
    contracts: {
      depository: depositoryAddress,
      entityProvider: '0x0000000000000000000000000000000000000000'
    }
  };

  env.jReplicas.set(name, jReplica);
  env.activeJurisdiction = name;

  return jReplica;
}

/**
 * Create jurisdiction config for entity registration
 */
export function createJurisdictionConfig(
  name: string,
  depositoryAddress: string
): JurisdictionConfig {
  return {
    name,
    chainId: 31337,
    entityProviderAddress: '0x0000000000000000000000000000000000000000',
    depositoryAddress,
    rpc: 'browservm://'
  };
}

/**
 * Create numbered entity using importReplica pattern
 */
export async function createNumberedEntity(
  env: Env,
  entityNumber: number,
  name: string,
  jurisdiction: JurisdictionConfig,
  position: { x: number; y: number; z: number }
): Promise<string> {
  const entityId = '0x' + entityNumber.toString(16).padStart(64, '0');
  const signer = `${entityNumber}`;

  const { applyRuntimeInput } = await import('../runtime');

  await applyRuntimeInput(env, {
    runtimeTxs: [{
      type: 'importReplica' as const,
      entityId,
      signerId: signer,
      data: {
        isProposer: true,
        position,
        config: {
          mode: 'proposer-based' as const,
          threshold: 1n,
          validators: [signer],
          shares: { [signer]: 1n },
          jurisdiction
        }
      }
    }],
    entityInputs: []
  });

  return entityId;
}

/**
 * Create 3D grid of entities (NxMxZ)
 */
export async function createGridEntities(
  env: Env,
  dimensions: { x: number; y: number; z: number }, // Grid size in each dimension
  jurisdiction: JurisdictionConfig,
  centerOffset: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 },
  spacing: number = 40
): Promise<string[]> {
  const entities: string[] = [];
  let entityNum = 1;

  for (let zi = 0; zi < dimensions.z; zi++) {
    for (let yi = 0; yi < dimensions.y; yi++) {
      for (let xi = 0; xi < dimensions.x; xi++) {
        const x = centerOffset.x + (xi - dimensions.x / 2 + 0.5) * spacing;
        const y = centerOffset.y + (yi - dimensions.y / 2 + 0.5) * spacing;
        const z = centerOffset.z + (zi - dimensions.z / 2 + 0.5) * spacing;

        const entityId = await createNumberedEntity(
          env,
          entityNum,
          `Node${entityNum}`,
          jurisdiction,
          { x, y, z }
        );

        entities.push(entityId);
        entityNum++;
      }
    }
  }

  return entities;
}

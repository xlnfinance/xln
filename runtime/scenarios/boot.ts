/**
 * Shared scenario boot utilities
 * Common setup code for all scenarios
 */

import type { Env, JurisdictionConfig } from '../types';

/**
 * Create or get BrowserVM instance
 */
export async function ensureBrowserVM() {
  const { getBrowserVMInstance, setBrowserVMJurisdiction } = await import('../evm');
  let browserVM = getBrowserVMInstance();

  if (!browserVM) {
    const { BrowserEVM } = await import('../evms/browser-evm');
    browserVM = new BrowserEVM();
    await browserVM.init();
    const depositoryAddress = browserVM.getDepositoryAddress();
    setBrowserVMJurisdiction(depositoryAddress, browserVM);
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
    lastBlockTimestamp: Date.now(),
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
  const signer = `s${entityNumber}`;

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
 * Create grid of entities
 */
export async function createGridEntities(
  env: Env,
  gridSize: number,
  jurisdiction: JurisdictionConfig,
  centerOffset: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 },
  spacing: number = 40
): Promise<string[]> {
  const entities: string[] = [];
  let entityNum = 1;

  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      const x = centerOffset.x + (col - gridSize / 2 + 0.5) * spacing;
      const y = centerOffset.y + (row - gridSize / 2 + 0.5) * spacing;
      const z = centerOffset.z;

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

  return entities;
}

/**
 * Procedural Test Economy Helpers
 * Simplifies creating N hubs + M users with channels for testing
 */

import type { Env, EntityInput } from '../types';

export interface EconomyEntity {
  id: string;
  signer: string;
  name: string;
  type: 'hub' | 'user';
}

export interface EconomyConfig {
  numHubs: number;
  usersPerHub: number;
  initialCollateral: bigint;
  creditLimit: bigint;
  tokenId: number;
  jurisdictionName: string;
}

/**
 * Create N hubs + M users procedurally
 * Returns: { hubs: Entity[], users: Entity[][] }
 */
export async function createEconomy(
  env: Env,
  config: EconomyConfig
): Promise<{ hubs: EconomyEntity[]; users: EconomyEntity[][]; all: EconomyEntity[] }> {
  const { applyRuntimeInput } = await import('../runtime');
  const { getProcess } = await import('./helpers');
  const process = await getProcess();

  console.log(`🏗️  Creating economy: ${config.numHubs} hubs × ${config.usersPerHub} users/hub\n`);

  const hubs: EconomyEntity[] = [];
  const usersByHub: EconomyEntity[][] = [];
  const all: EconomyEntity[] = [];

  let entityNumber = 1;

  // Create hubs
  for (let h = 0; h < config.numHubs; h++) {
    const hub: EconomyEntity = {
      id: '0x' + entityNumber.toString(16).padStart(64, '0'),
      signer: `s${entityNumber}`,
      name: `Hub${h + 1}`,
      type: 'hub'
    };
    hubs.push(hub);
    all.push(hub);
    entityNumber++;
  }

  // Create users for each hub
  for (let h = 0; h < config.numHubs; h++) {
    const users: EconomyEntity[] = [];
    for (let u = 0; u < config.usersPerHub; u++) {
      const user: EconomyEntity = {
        id: '0x' + entityNumber.toString(16).padStart(64, '0'),
        signer: `s${entityNumber}`,
        name: `User${h + 1}.${u + 1}`,
        type: 'user'
      };
      users.push(user);
      all.push(user);
      entityNumber++;
    }
    usersByHub.push(users);
  }

  // Batch import all entities
  console.log(`   Creating ${all.length} entities...`);
  await applyRuntimeInput(env, {
    runtimeTxs: all.map(e => ({
      type: 'importReplica' as const,
      entityId: e.id,
      signerId: e.signer,
      data: {
        isProposer: true,
        position: { x: 0, y: 0, z: 0 },
        config: {
          mode: 'proposer-based' as const,
          threshold: 1n,
          validators: [e.signer],
          shares: { [e.signer]: 1n },
        },
      },
    })),
    entityInputs: []
  });

  console.log(`   ✅ Created ${hubs.length} hubs, ${all.length - hubs.length} users\n`);

  // Fund all entities
  console.log(`   Depositing ${config.initialCollateral} collateral for each entity...`);
  await process(env, all.map(e => ({
    entityId: e.id,
    signerId: e.signer,
    entityTxs: [{
      type: 'depositCollateral',
      data: {
        jurisdictionId: config.jurisdictionName,
        tokenId: config.tokenId,
        amount: config.initialCollateral
      }
    }]
  })));

  console.log(`   ✅ All entities funded\n`);

  return { hubs, users: usersByHub, all };
}

/**
 * Open bilateral channels between entities with credit
 * Pattern: Creates account + extends credit both ways
 */
export async function openChannel(
  env: Env,
  entityA: EconomyEntity,
  entityB: EconomyEntity,
  creditLimit: bigint,
  tokenId: number
): Promise<void> {
  const { getProcess } = await import('./helpers');
  const process = await getProcess();

  // A opens account with B
  await process(env, [{
    entityId: entityA.id,
    signerId: entityA.signer,
    entityTxs: [{
      type: 'openAccount',
      data: { targetEntityId: entityB.id }
    }]
  }]);

  // Wait for bilateral account creation
  await converge(env);

  // Both extend credit
  await process(env, [
    {
      entityId: entityA.id,
      signerId: entityA.signer,
      entityTxs: [{
        type: 'extendCredit',
        data: {
          counterpartyEntityId: entityB.id,
          tokenId,
          amount: creditLimit
        }
      }]
    },
    {
      entityId: entityB.id,
      signerId: entityB.signer,
      entityTxs: [{
        type: 'extendCredit',
        data: {
          counterpartyEntityId: entityA.id,
          tokenId,
          amount: creditLimit
        }
      }]
    }
  ]);

  await converge(env);
}

/**
 * Connect economy - open channels between hubs and their users
 * Creates hub-hub channels + hub-user channels
 */
export async function connectEconomy(
  env: Env,
  hubs: EconomyEntity[],
  users: EconomyEntity[][],
  creditLimit: bigint,
  tokenId: number
): Promise<void> {
  console.log(`🔗 Connecting economy channels...\n`);

  // Connect hubs to each other (full mesh)
  console.log(`   Connecting ${hubs.length} hubs (mesh)...`);
  for (let i = 0; i < hubs.length; i++) {
    for (let j = i + 1; j < hubs.length; j++) {
      await openChannel(env, hubs[i], hubs[j], creditLimit, tokenId);
      console.log(`   ✅ ${hubs[i].name} ↔ ${hubs[j].name}`);
    }
  }

  // Connect each user to their hub
  console.log(`\n   Connecting users to hubs...`);
  for (let h = 0; h < hubs.length; h++) {
    for (const user of users[h]) {
      await openChannel(env, hubs[h], user, creditLimit, tokenId);
      console.log(`   ✅ ${hubs[h].name} ↔ ${user.name}`);
    }
  }

  console.log(`\n   ✅ Economy connected!\n`);
}

/**
 * Helper: converge (copied from swap.ts pattern)
 */
async function converge(env: Env, maxCycles = 10): Promise<void> {
  const { getProcess } = await import('./helpers');
  const process = await getProcess();

  for (let i = 0; i < maxCycles; i++) {
    await process(env);
    let hasWork = false;
    for (const [, replica] of env.eReplicas) {
      for (const [, account] of replica.state.accounts) {
        if (account.mempool.length > 0 || account.pendingFrame) {
          hasWork = true;
          break;
        }
      }
      if (hasWork) break;
    }
    if (!hasWork) return;
  }
}

/**
 * Test HTLC payment through economy
 */
export async function testHtlcRoute(
  env: Env,
  from: EconomyEntity,
  to: EconomyEntity,
  route: EconomyEntity[],
  amount: bigint,
  tokenId: number,
  description: string
): Promise<void> {
  const { getProcess } = await import('./helpers');
  const process = await getProcess();

  console.log(`🔒 Testing HTLC: ${from.name} → ${route.map(e => e.name).join(' → ')} → ${to.name}`);
  console.log(`   Amount: ${amount}, Hops: ${route.length}\n`);

  await process(env, [{
    entityId: from.id,
    signerId: from.signer,
    entityTxs: [{
      type: 'htlcPayment',
      data: {
        targetEntityId: to.id,
        route: [from.id, ...route.map(e => e.id), to.id],
        tokenId,
        amount,
        description
      }
    }]
  }]);

  await converge(env);
  console.log(`   ✅ HTLC complete\n`);
}

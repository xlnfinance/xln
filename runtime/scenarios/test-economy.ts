/**
 * Test Economy - Helpers for creating multi-entity test networks
 * Used by htlc-4hop.ts and other multi-hop scenario tests
 */

import type { Env } from '../types';
import type { AccountKey } from '../ids';

export interface EconomyEntity {
  id: string;
  signer: string;
  name: string;
}

interface EconomyConfig {
  numHubs: number;
  usersPerHub: number;
  initialCollateral: bigint;
  creditLimit: bigint;
  tokenId: number;
  jurisdictionName: string;
}

interface Economy {
  hubs: EconomyEntity[];
  users: EconomyEntity[][];
  all: EconomyEntity[];
}

/**
 * Create a test economy with hubs and users
 */
export async function createEconomy(env: Env, config: EconomyConfig): Promise<Economy> {
  const { applyRuntimeInput } = await import('../runtime');

  const hubs: EconomyEntity[] = [];
  const users: EconomyEntity[][] = [];
  const all: EconomyEntity[] = [];

  let entityNum = 1;

  // Create hubs
  for (let h = 0; h < config.numHubs; h++) {
    const id = '0x' + entityNum.toString(16).padStart(64, '0');
    const signer = String(entityNum);
    const hub: EconomyEntity = { id, signer, name: `Hub${h + 1}` };
    hubs.push(hub);
    all.push(hub);
    entityNum++;
  }

  // Create users (usersPerHub per hub)
  for (let h = 0; h < config.numHubs; h++) {
    const hubUsers: EconomyEntity[] = [];
    for (let u = 0; u < config.usersPerHub; u++) {
      const id = '0x' + entityNum.toString(16).padStart(64, '0');
      const signer = String(entityNum);
      const user: EconomyEntity = { id, signer, name: `User${entityNum}` };
      hubUsers.push(user);
      all.push(user);
      entityNum++;
    }
    users.push(hubUsers);
  }

  // Register all entities
  const runtimeTxs = all.map(e => ({
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
  }));

  await (applyRuntimeInput as any)(env, { runtimeTxs, entityInputs: [] });

  return { hubs, users, all };
}

/**
 * Connect economy entities with bilateral accounts and credit limits
 */
export async function connectEconomy(
  env: Env,
  hubs: EconomyEntity[],
  users: EconomyEntity[][],
  creditLimit: bigint,
  tokenId: number,
): Promise<void> {
  const { process } = await import('../runtime');

  // Open accounts: each user to their hub
  for (let h = 0; h < hubs.length; h++) {
    const hub = hubs[h]!;
    const hubUsers = users[h] || [];
    for (const user of hubUsers) {
      await process(env, [{
        entityId: user.id,
        signerId: user.signer,
        entityTxs: [{ type: 'openAccount', data: { targetEntityId: hub.id } }],
      }]);
      // Converge
      for (let i = 0; i < 5; i++) await process(env);
    }
  }

  // Open hub-to-hub accounts
  for (let i = 0; i < hubs.length - 1; i++) {
    const hubA = hubs[i]!;
    const hubB = hubs[i + 1]!;
    await process(env, [{
      entityId: hubA.id,
      signerId: hubA.signer,
      entityTxs: [{ type: 'openAccount', data: { targetEntityId: hubB.id } }],
    }]);
    for (let j = 0; j < 5; j++) await process(env);
  }

  // Extend credit limits
  for (let h = 0; h < hubs.length; h++) {
    const hub = hubs[h]!;
    const hubUsers = users[h] || [];
    for (const user of hubUsers) {
      await process(env, [
        {
          entityId: user.id,
          signerId: user.signer,
          entityTxs: [{ type: 'extendCredit', data: { counterpartyEntityId: hub.id, tokenId, amount: creditLimit } }],
        },
        {
          entityId: hub.id,
          signerId: hub.signer,
          entityTxs: [{ type: 'extendCredit', data: { counterpartyEntityId: user.id, tokenId, amount: creditLimit } }],
        },
      ]);
      for (let i = 0; i < 5; i++) await process(env);
    }
  }

  // Hub-to-hub credit limits
  for (let i = 0; i < hubs.length - 1; i++) {
    const hubA = hubs[i]!;
    const hubB = hubs[i + 1]!;
    await process(env, [
      {
        entityId: hubA.id,
        signerId: hubA.signer,
        entityTxs: [{ type: 'extendCredit', data: { counterpartyEntityId: hubB.id, tokenId, amount: creditLimit } }],
      },
      {
        entityId: hubB.id,
        signerId: hubB.signer,
        entityTxs: [{ type: 'extendCredit', data: { counterpartyEntityId: hubA.id, tokenId, amount: creditLimit } }],
      },
    ]);
    for (let i = 0; i < 5; i++) await process(env);
  }
}

/**
 * Test an HTLC payment route
 */
export async function testHtlcRoute(
  env: Env,
  sender: EconomyEntity,
  receiver: EconomyEntity,
  route: EconomyEntity[],
  amount: bigint,
  tokenId: number,
  label: string,
  htlc: { secret: Uint8Array; hash: Uint8Array; hashlock: Uint8Array },
): Promise<void> {
  const { process } = await import('../runtime');
  const { ethers } = await import('ethers');

  const fullRoute = [sender, ...route, receiver].map(e => e.id);

  console.log(`  ${label}: ${sender.name} → ${receiver.name} (${amount / 10n**18n} tokens)`);

  await process(env, [{
    entityId: sender.id,
    signerId: sender.signer,
    entityTxs: [{
      type: 'htlcPayment',
      data: {
        targetEntityId: receiver.id,
        tokenId,
        amount,
        route: fullRoute,
        description: label,
        secret: ethers.hexlify(htlc.secret),
        hashlock: ethers.hexlify(htlc.hashlock),
      }
    }]
  }]);

  // Converge until all bilateral consensus rounds complete
  for (let i = 0; i < 20; i++) {
    await process(env);
  }

  console.log(`  ✅ ${label} complete`);
}

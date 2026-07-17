/**
 * Procedural Test Economy Helpers
 * Simplifies creating N hubs + M users with accounts for testing
 */

import type { Env, EntityInput } from '../types';
import {
  createJurisdictionConfig,
  getScenarioJAdapter,
  registerEntities,
} from './boot';
import { withDeterministicHtlcTestSecret } from '../protocol/htlc/test-secret-capability';

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

const requireEconomyEntity = (
  value: EconomyEntity | undefined,
  label: string,
): EconomyEntity => {
  if (!value) throw new Error(`ECONOMY_ENTITY_MISSING: ${label}`);
  return value;
};

/**
 * Create N hubs + M users procedurally
 * Returns: { hubs: Entity[], users: Entity[][] }
 */
export async function createEconomy(
  env: Env,
  config: EconomyConfig
): Promise<{ hubs: EconomyEntity[]; users: EconomyEntity[][]; all: EconomyEntity[] }> {
  const { getProcess } = await import('./helpers');
  const process = await getProcess();

  console.log(`🏗️  Creating economy: ${config.numHubs} hubs × ${config.usersPerHub} users/hub\n`);

  const hubs: EconomyEntity[] = [];
  const usersByHub: EconomyEntity[][] = [];
  const all: EconomyEntity[] = [];
  let signerNumber = 1;

  // Create hubs
  for (let h = 0; h < config.numHubs; h++) {
    const hub: EconomyEntity = {
      id: '',
      signer: String(signerNumber),
      name: `Hub${h + 1}`,
      type: 'hub'
    };
    hubs.push(hub);
    all.push(hub);
    signerNumber += 1;
  }

  // Create users for each hub
  for (let h = 0; h < config.numHubs; h++) {
    const users: EconomyEntity[] = [];
    for (let u = 0; u < config.usersPerHub; u++) {
      const user: EconomyEntity = {
        id: '',
        signer: String(signerNumber),
        name: `User${h + 1}.${u + 1}`,
        type: 'user'
      };
      users.push(user);
      all.push(user);
      signerNumber += 1;
    }
    usersByHub.push(users);
  }

  // Numbered Entity ids are chain-issued identities. Register the exact signer
  // boards first so the watcher can certify EntityRegistered evidence before H0
  // reaches durable storage; synthetic 0x01.. ids would fail the authority fence.
  console.log(`   Creating ${all.length} entities...`);
  const jadapter = getScenarioJAdapter(env);
  const jurisdiction = createJurisdictionConfig(
    config.jurisdictionName,
    jadapter.addresses.depository,
    jadapter.addresses.entityProvider,
  );
  const registered = await registerEntities(
    env,
    jadapter,
    all.map(entity => ({
      name: entity.name,
      signer: entity.signer,
      position: { x: 0, y: 0, z: 0 },
    })),
    jurisdiction,
  );
  for (let index = 0; index < all.length; index += 1) {
    const entity = all[index];
    const registration = registered[index];
    if (!entity || !registration) throw new Error(`ECONOMY_REGISTRATION_MISSING:${index}`);
    entity.id = registration.id;
    entity.signer = registration.signer;
  }

  console.log(`   ✅ Created ${hubs.length} hubs, ${all.length - hubs.length} users\n`);

  // Fund all entities
  console.log(`   Depositing ${config.initialCollateral} collateral for each entity...`);
  const fundingInputs: EntityInput[] = all.map(e => ({
    entityId: e.id,
    signerId: e.signer,
    entityTxs: [{
      type: 'mintReserves',
      data: {
        tokenId: config.tokenId,
        amount: config.initialCollateral
      }
    }]
  }));
  await process(env, fundingInputs);

  console.log(`   ✅ All entities funded\n`);

  return { hubs, users: usersByHub, all };
}

/**
 * Open bilateral account between entities with credit
 * Pattern: Creates account + extends credit both ways
 */
export async function openAccount(
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
      data: {
        targetEntityId: entityB.id,
        rebalancePolicy: {
          r2cRequestSoftLimit: creditLimit,
          hardLimit: creditLimit,
          maxAcceptableFee: 0n,
        },
      }
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
 * Connect economy - open accounts between hubs and their users
 * Creates hub-hub accounts + hub-user accounts
 */
export async function connectEconomy(
  env: Env,
  hubs: EconomyEntity[],
  users: EconomyEntity[][],
  creditLimit: bigint,
  tokenId: number
): Promise<void> {
  console.log(`🔗 Connecting economy accounts...\n`);

  // Connect hubs to each other (full mesh)
  console.log(`   Connecting ${hubs.length} hubs (mesh)...`);
  for (let i = 0; i < hubs.length; i++) {
    const leftHub = requireEconomyEntity(hubs[i], `hub[${i}]`);
    for (let j = i + 1; j < hubs.length; j++) {
      const rightHub = requireEconomyEntity(hubs[j], `hub[${j}]`);
      await openAccount(env, leftHub, rightHub, creditLimit, tokenId);
      console.log(`   ✅ ${leftHub.name} ↔ ${rightHub.name}`);
    }
  }

  // Connect each user to their hub
  console.log(`\n   Connecting users to hubs...`);
  for (let h = 0; h < hubs.length; h++) {
    const hub = requireEconomyEntity(hubs[h], `hub[${h}]`);
    const hubUsers = users[h] ?? [];
    for (const user of hubUsers) {
      await openAccount(env, hub, user, creditLimit, tokenId);
      console.log(`   ✅ ${hub.name} ↔ ${user.name}`);
    }
  }

  console.log(`\n   ✅ Economy connected!\n`);
}

async function converge(env: Env, maxCycles = 10): Promise<void> {
  const { converge: helperConverge } = await import('./helpers');
  return helperConverge(env, maxCycles);
}

export const htlcRouteConvergenceCycleBudget = (intermediaryCount: number): number => {
  if (!Number.isSafeInteger(intermediaryCount) || intermediaryCount < 0) {
    throw new Error(`HTLC_ROUTE_INTERMEDIARY_COUNT_INVALID:${intermediaryCount}`);
  }
  const accountHops = intermediaryCount + 1;
  const forwardAccountCommits = accountHops;
  // Each encrypted layer is advanced by the recipient Entity's default
  // proposer in a separate signed frame. Plaintext is never part of the
  // preceding Account commit replay.
  const proposerOnionAdvanceFrames = accountHops;
  const reverseSecretCommits = accountHops;
  // Each intermediary learns the downstream preimage only when that Account
  // resolve commits. Its upstream resolve is queued in the same Entity replay,
  // then needs one subsequent Runtime tick to become the next Account proposal.
  const intermediarySecretPropagationFrames = intermediaryCount;
  const recipientRevealFrame = 1;
  const sourceResolutionFrame = 1;
  // Reverse settlement can commit adjacent Accounts in the same Runtime tick,
  // but their reliable ACKs still arrive one-by-one. Keep enough budget for
  // every intermediary boundary to drain before asserting strict idle.
  const terminalAccountAckCascadeFrames = intermediaryCount;
  const terminalReceiptFrame = 1;
  return forwardAccountCommits
    + proposerOnionAdvanceFrames
    + recipientRevealFrame
    + reverseSecretCommits
    + intermediarySecretPropagationFrames
    + sourceResolutionFrame
    + terminalAccountAckCascadeFrames
    + terminalReceiptFrame;
};

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
  description: string,
  opts?: { secret?: string; hashlock?: string }
): Promise<void> {
  const { getProcess } = await import('./helpers');
  const process = await getProcess();

  console.log(`🔒 Testing HTLC: ${from.name} → ${route.map(e => e.name).join(' → ')} → ${to.name}`);
  console.log(`   Amount: ${amount}, Hops: ${route.length}\n`);

  const rawPayment = {
    type: 'htlcPayment' as const,
    data: {
      targetEntityId: to.id,
      route: [from.id, ...route.map(e => e.id), to.id],
      tokenId,
      amount,
      description,
      ...(opts?.hashlock ? { hashlock: opts.hashlock } : {}),
    },
  };
  const payment = opts?.secret
    ? withDeterministicHtlcTestSecret(rawPayment, opts.secret)
    : rawPayment;
  await process(env, [{
    entityId: from.id,
    signerId: from.signer,
    entityTxs: [payment],
  }]);

  // Each Account hop commits once outward and once on secret return. The
  // recipient reveal, source resolution, and final reliable receipt are three
  // distinct durable R-frames. Budget the bounded pipeline by route depth;
  // productive frames must not look like a stuck transport.
  await converge(env, Math.max(10, htlcRouteConvergenceCycleBudget(route.length)));
  console.log(`   ✅ HTLC complete\n`);
}

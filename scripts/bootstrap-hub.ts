#!/usr/bin/env bun
/**
 * Bootstrap Hub Entity
 *
 * Creates a hub entity (normal entity + gossip metadata).
 * Idempotent: safe to run multiple times.
 *
 * Usage:
 *   bun scripts/bootstrap-hub.ts
 *   bun scripts/bootstrap-hub.ts --name "EU Hub" --region eu
 */

import { main, applyRuntimeInput, getEnv } from '../runtime/runtime';
import { deriveSignerKeySync, registerSignerKey } from '../runtime/account-crypto';
import { encodeBoard, hashBoard } from '../runtime/entity-factory';

const args = process.argv.slice(2);

const getArg = (name: string, fallback: string): string => {
  const idx = args.indexOf(name);
  return idx === -1 ? fallback : args[idx + 1] || fallback;
};

const HUB_CONFIG = {
  name: getArg('--name', 'Main Hub'),
  region: getArg('--region', 'global'),
  signerId: getArg('--signer', 'hub-validator'),
  seed: getArg('--seed', 'xln-main-hub-2026'),
  routingFeePPM: parseInt(getArg('--fee', '100')),
  relayUrl: getArg('--relay', 'wss://xln.finance/relay'),
};

async function bootstrapHub(env?: any) {
  console.log('[BOOTSTRAP] Starting hub bootstrap...');
  console.log(`[BOOTSTRAP] Name: ${HUB_CONFIG.name}`);
  console.log(`[BOOTSTRAP] Region: ${HUB_CONFIG.region}`);

  // Initialize runtime if not provided
  if (!env) {
    const { main } = await import('../runtime/runtime');
    env = await main();
  }

  // Check if hub already exists in gossip
  const existingHubs = env.gossip?.getProfiles()?.filter(p =>
    p.metadata?.name === HUB_CONFIG.name && p.metadata?.isHub === true
  ) || [];

  if (existingHubs.length > 0) {
    console.log(`[BOOTSTRAP] ✅ Hub "${HUB_CONFIG.name}" already exists`);
    console.log(`[BOOTSTRAP]    EntityId: ${existingHubs[0].entityId}`);
    console.log(`[BOOTSTRAP]    RuntimeId: ${existingHubs[0].runtimeId}`);
    console.log('[BOOTSTRAP] Skipping creation (idempotent)');
    return;
  }

  // Derive and register signer key
  const seedBytes = new TextEncoder().encode(HUB_CONFIG.seed);
  const privateKey = deriveSignerKeySync(seedBytes, HUB_CONFIG.signerId);
  registerSignerKey(HUB_CONFIG.signerId, privateKey);

  // Create board config (normal entity)
  const config = {
    mode: 'proposer-based' as const,
    threshold: 1n,
    validators: [HUB_CONFIG.signerId],
    shares: { [HUB_CONFIG.signerId]: 1n },
  };

  const encodedBoard = encodeBoard(config);
  const boardHash = hashBoard(encodedBoard);
  const entityId = boardHash;

  console.log('[BOOTSTRAP] Creating hub entity...');
  console.log(`[BOOTSTRAP]    EntityId: ${entityId}`);

  // Import entity (normal importReplica - NO special logic)
  await applyRuntimeInput(env, {
    runtimeTxs: [{
      type: 'importReplica',
      entityId,
      signerId: HUB_CONFIG.signerId,
      data: {
        config,
        isProposer: true,
        position: { x: 0, y: 0, z: 0 },
      },
    }],
    entityInputs: [],
  });

  console.log('[BOOTSTRAP] ✅ Entity created');

  // Mark as hub in gossip (ONLY difference from normal entity)
  if (env.gossip) {
    env.gossip.announce({
      entityId,
      runtimeId: env.runtimeId,
      capabilities: ['hub', 'routing', 'faucet'],
      accounts: [], // Required field
      metadata: {
        name: HUB_CONFIG.name,
        isHub: true,
        region: HUB_CONFIG.region,
        relayUrl: HUB_CONFIG.relayUrl,
        routingFeePPM: HUB_CONFIG.routingFeePPM,
        lastUpdated: Date.now(), // Add timestamp
      },
    });
    console.log('[BOOTSTRAP] ✅ Announced in gossip as hub');

    // Verify it was stored
    const verify = env.gossip.getHubs?.();
    console.log(`[BOOTSTRAP] Gossip verification: ${verify?.length || 0} hubs found`);
  }

  console.log('[BOOTSTRAP] ✅ Hub bootstrap complete');
  console.log(`[BOOTSTRAP]    Name: ${HUB_CONFIG.name}`);
  console.log(`[BOOTSTRAP]    EntityId: ${entityId.slice(0, 16)}...`);
  console.log(`[BOOTSTRAP]    Region: ${HUB_CONFIG.region}`);
  console.log(`[BOOTSTRAP]    Fee: ${HUB_CONFIG.routingFeePPM / 10000}%`);
  console.log(`[BOOTSTRAP]    Relay: ${HUB_CONFIG.relayUrl}`);
}

if (import.meta.main) {
  bootstrapHub().catch(err => {
    console.error('[BOOTSTRAP] ❌ Failed:', err);
    process.exit(1);
  });
}

export { bootstrapHub };

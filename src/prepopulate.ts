/**
 * Prepopulate XLN with H-shaped network topology
 * Creates 10 entities: 2 hubs (E1-E2) and 8 users (E3-E10)
 * Visual structure: H-shaped for clean 1px=$1 bars visualization
 */

import type { Env, EntityInput } from './types';
import { applyServerInput } from './server';
import { createNumberedEntity } from './entity-factory';
import { getAvailableJurisdictions } from './evm';

export async function prepopulate(env: Env, processUntilEmpty: (env: Env, inputs?: EntityInput[]) => Promise<any>): Promise<void> {
  console.log('🌐 Starting XLN Prepopulation');
  console.log('================================');
  console.log('Creating H-shaped network topology:');
  console.log('  • 2 Hubs (E1, E2) - connected crossbar');
  console.log('  • 4 Users (E3-E6) - split between hubs');
  console.log('    - E3, E4 → Hub E1');
  console.log('    - E5, E6 → Hub E2');
  console.log('  Visual: Clean H-shape with 6 entities total');
  console.log('================================\n');

  // Load jurisdiction configuration using the browser-compatible function
  const jurisdictions = await getAvailableJurisdictions();
  const ethereum = jurisdictions.find(j => j.name.toLowerCase() === 'ethereum');

  if (!ethereum) {
    throw new Error('Ethereum jurisdiction not found in available jurisdictions');
  }

  console.log(`📋 Using jurisdiction: ${ethereum.name}`);
  console.log(`  ├─ EntityProvider: ${ethereum.entityProviderAddress}`);
  console.log(`  └─ Depository: ${ethereum.depositoryAddress}`);

  // Step 1: Create 6 entities by getting proper entity IDs from blockchain
  console.log('📦 Step 1: Creating 6 entities with blockchain-assigned IDs...');
  console.log('  Each entity will get sequential ID from the blockchain');

  const entities: Array<{id: string, signer: string, isHub: boolean}> = [];
  const createEntityTxs = [];

  for (let i = 1; i <= 6; i++) {
    const signer = `s${i}`;
    const isHub = i <= 2; // Only first 2 entities are hubs (H-shaped topology)
    const entityName = isHub ? `Hub ${i}` : `User ${i}`;

    // Create numbered entity through blockchain to get proper ID
    try {
      const { config, entityNumber, entityId } = await createNumberedEntity(
        entityName,
        [signer],  // Single validator
        1n,        // Threshold of 1
        ethereum   // Jurisdiction
      );

      entities.push({ id: entityId, signer, isHub });
      console.log(`  ✓ Created ${entityName}: Entity #${entityNumber} (${entityId.slice(0, 10)}...)`);

      // Add to batch for import
      createEntityTxs.push({
        type: 'importReplica' as const,
        entityId,
        signerId: signer,
        data: {
          isProposer: true,
          config
        }
      });
    } catch (error) {
      console.error(`  ❌ Failed to create ${entityName}:`, error);
      // For demo/testing, fall back to simple sequential IDs if blockchain fails
      const entityNumber = i;
      const entityId = '0x' + entityNumber.toString(16).padStart(64, '0');
      entities.push({ id: entityId, signer, isHub });

      createEntityTxs.push({
        type: 'importReplica' as const,
        entityId,
        signerId: signer,
        data: {
          isProposer: true,
          config: {
            mode: 'proposer-based' as const,
            threshold: 1n,
            validators: [signer],
            shares: { [signer]: 1n },
            jurisdiction: ethereum
          }
        }
      });
      console.log(`  ⚠️ Using fallback ID for ${entityName}: Entity #${entityNumber}`);
    }
  }

  // Import all entities in one batch
  await applyServerInput(env, {
    serverTxs: createEntityTxs,
    entityInputs: []
  });

  console.log(`\n  ✅ Imported ${entities.length} entities`);
  entities.forEach((e) => {
    const entityNum = parseInt(e.id.slice(2), 16);  // Extract number from hex ID
    console.log(`    • Entity #${entityNum}: ${e.isHub ? 'HUB' : 'User'} (signer: ${e.signer})`);
  });

  console.log('\n📡 Step 2: Connecting the two hubs (H crossbar)...');

  // Step 2: Connect Hub 1 and Hub 2 (the crossbar of the H)
  const hub1 = entities[0];
  const hub2 = entities[1];

  if (!hub1 || !hub2) {
    throw new Error('Failed to create hubs');
  }

  // Hub1 opens account with Hub2
  await processUntilEmpty(env, [{
    entityId: hub1.id,
    signerId: hub1.signer,
    entityTxs: [{
      type: 'openAccount',
      data: { targetEntityId: hub2.id }
    }]
  }]);

  const hub1Num = parseInt(hub1.id.slice(2), 16);
  const hub2Num = parseInt(hub2.id.slice(2), 16);
  console.log(`  🔗 Hub E${hub1Num} ←→ Hub E${hub2Num} connected (H crossbar)`);

  console.log('\n👥 Step 3: Connecting users to hubs (H vertical bars)...');

  // Step 3: Connect users to hubs - H shape
  const userHubMapping = [
    { users: [2, 3], hub: 0 },    // E3, E4 → Hub E1 (left bar)
    { users: [4, 5], hub: 1 },    // E5, E6 → Hub E2 (right bar)
  ];

  for (const mapping of userHubMapping) {
    for (const userIndex of mapping.users) {
      const user = entities[userIndex];
      const hub = entities[mapping.hub];
      if (!user || !hub) continue;

      // User opens account with hub
      await processUntilEmpty(env, [{
        entityId: user.id,
        signerId: user.signer,
        entityTxs: [{
          type: 'openAccount',
          data: { targetEntityId: hub.id }
        }]
      }]);

      const userNum = parseInt(user.id.slice(2), 16);
      const hubNum = parseInt(hub.id.slice(2), 16);
      console.log(`  👤 User E${userNum} → Hub E${hubNum} connected`);
    }
  }

  console.log('\n🎯 Step 4: Setting hub profiles with lower fees...');

  // Step 4: Update hub profiles with lower routing fees
  for (const hub of [hub1, hub2]) {
    const hubNum = parseInt(hub.id.slice(2), 16);

    // Send profile update to set hub capabilities and lower fees
    await processUntilEmpty(env, [{
      entityId: hub.id,
      signerId: hub.signer,
      entityTxs: [{
        type: 'profile-update',
        data: {
          profile: {
            entityId: hub.id,
            name: `Hub ${hubNum}`,
            bio: `Professional routing hub with high capacity and low fees`,
            isHub: true,
            routingFeePPM: 50, // Lower fee for hubs (0.005%)
            baseFee: 0n,
          }
        }
      }]
    }]);

    console.log(`  💰 Hub E${hubNum} - routing fee: 50 PPM (0.005%)`);
  }

  console.log('\n================================');
  console.log('✅ Prepopulation Complete!');
  console.log('\nH-shaped network topology created:');
  console.log('  • 2 Hubs connected (H crossbar)');
  console.log('  • 4 Users: 2 per hub (H vertical bars)');
  console.log('  • Total accounts: 5 (1 hub-to-hub + 4 user-to-hub)');
  console.log('  • Topology: Clean 6-entity visualization (perfect number)');
  console.log('\nYou can now:');
  console.log('  1. View clean H-shaped topology in bird view');
  console.log('  2. Send payments between any entities');
  console.log('  3. Payments will route through hubs automatically');
  console.log('================================\n');
}
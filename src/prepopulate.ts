/**
 * Prepopulate XLN with a realistic network topology
 * Creates 10 entities: 3 hubs (E1-E3) and 7 users (E4-E10)
 * Hubs connect to each other, users connect to hubs
 */

import type { Env, EntityInput } from './types';
import { applyServerInput } from './server';
import { createNumberedEntity } from './entity-factory';
import { getAvailableJurisdictions } from './evm';

export async function prepopulate(env: Env, processUntilEmpty: (env: Env, inputs?: EntityInput[]) => Promise<any>): Promise<void> {
  console.log('🌐 Starting XLN Prepopulation');
  console.log('================================');
  console.log('Creating network topology:');
  console.log('  • 3 Hubs (E1, E2, E3) - fully connected');
  console.log('  • 7 Users (E4-E10) - connected to hubs');
  console.log('    - E4, E5 → Hub E1');
  console.log('    - E6, E7 → Hub E2');
  console.log('    - E8, E9, E10 → Hub E3');
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

  // Step 1: Create 10 entities by getting proper entity IDs from blockchain
  console.log('📦 Step 1: Creating 10 entities with blockchain-assigned IDs...');
  console.log('  Each entity will get sequential ID from the blockchain');

  const entities: Array<{id: string, signer: string, isHub: boolean}> = [];
  const createEntityTxs = [];

  for (let i = 1; i <= 10; i++) {
    const signer = `s${i}`;
    const isHub = i <= 3;
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

  console.log('\n📡 Step 2: Connecting hubs to each other...');

  // Step 2: Connect hubs to each other (fully connected mesh)
  const hubs = entities.slice(0, 3);
  for (let i = 0; i < hubs.length; i++) {
    for (let j = i + 1; j < hubs.length; j++) {
      const hub1 = hubs[i];
      const hub2 = hubs[j];
      if (!hub1 || !hub2) continue;

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
      console.log(`  🔗 Hub E${hub1Num} ←→ Hub E${hub2Num} connected`);
    }
  }

  console.log('\n👥 Step 3: Connecting users to hubs...');

  // Step 3: Connect users to hubs
  const userHubMapping = [
    { users: [3, 4], hub: 0 },      // E4, E5 → E1
    { users: [5, 6], hub: 1 },      // E6, E7 → E2
    { users: [7, 8, 9], hub: 2 },   // E8, E9, E10 → E3
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
  for (let i = 0; i < 3; i++) {
    const hub = hubs[i];
    if (!hub) continue;
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
  console.log('\nNetwork topology created:');
  console.log('  • 3 Hubs with full mesh connectivity');
  console.log('  • 7 Users connected to hubs');
  console.log('  • Total accounts: 9 (3 hub-to-hub + 6 user-to-hub)');
  console.log('\nYou can now:');
  console.log('  1. Send payments between any entities');
  console.log('  2. Payments will route through hubs automatically');
  console.log('  3. View the network in the Network Directory');
  console.log('================================\n');
}
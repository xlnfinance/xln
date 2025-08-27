/**
 * Demo: J-Machine Event Watcher Integration
 *
 * This demonstrates how to integrate the J-Event Watcher with the XLN server
 * to enable automatic jurisdiction event monitoring and entity notification.
 */
import { createEmptyEnv } from './server.js';
import { setupJEventWatcher } from './j-event-watcher.js';
const DEBUG = true;
async function demoJEventWatcher() {
    console.log('🚀 DEMO: Starting J-Event Watcher Integration');
    // Create environment
    const env = createEmptyEnv();
    // Example configuration (would come from environment variables in real deployment)
    const config = {
        rpcUrl: 'http://localhost:8545', // Local hardhat/anvil node
        entityProviderAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3', // Example address
        depositoryAddress: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512' // Example address
    };
    try {
        // Set up the J-Event Watcher
        console.log('🔭 Setting up J-Event Watcher...');
        const watcher = await setupJEventWatcher(env, config.rpcUrl, config.entityProviderAddress, config.depositoryAddress);
        // Show initial status
        const status = watcher.getStatus();
        console.log('🔭 J-Watcher Status:', status);
        // Simulate some server processing to show how j-events integrate
        console.log('\n📊 Simulating server processing with j-events...');
        // In a real deployment, the watcher would automatically detect events
        // and add them to env.serverInput.entityInputs
        // Here we simulate that happening by manually adding a j-event
        simulateJurisdictionEvent(env);
        // Show that the event was captured
        console.log('\n📋 Server Input after j-event simulation:');
        console.log(`  - ${env.serverInput.entityInputs.length} entity inputs pending`);
        if (env.serverInput.entityInputs.length > 0) {
            const firstInput = env.serverInput.entityInputs[0];
            console.log(`  - First input: Entity #${firstInput.entityId}, Signer: ${firstInput.signerId}`);
            console.log(`  - Transaction types: ${firstInput.entityTxs?.map(tx => tx.type).join(', ')}`);
        }
        // Cleanup
        watcher.stopWatching();
        console.log('\n✅ Demo completed successfully');
    }
    catch (error) {
        console.error('❌ Demo error:', error);
    }
}
/**
 * Simulate a jurisdiction event being detected
 */
function simulateJurisdictionEvent(env) {
    if (DEBUG)
        console.log('🎭 Simulating jurisdiction event detection...');
    // This simulates what would happen when the watcher detects a real event
    const simulatedJEvent = {
        type: 'control_shares_released',
        blockNumber: 12345,
        transactionHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        entityNumber: 1,
        data: {
            depository: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
            controlAmount: '1000000000000000000', // 1 token with 18 decimals
            dividendAmount: '0',
            purpose: 'Series A Funding'
        }
    };
    // Create the entity transaction that would be submitted by each signer
    const entityTx = {
        type: 'j_event',
        data: {
            from: 'alice',
            event: simulatedJEvent,
            observedAt: Date.now(),
            blockNumber: simulatedJEvent.blockNumber,
            transactionHash: simulatedJEvent.transactionHash
        }
    };
    // Add to server input (this is what the watcher does automatically)
    env.serverInput.entityInputs.push({
        entityId: '1',
        signerId: 'alice',
        entityTxs: [entityTx]
    });
    if (DEBUG) {
        console.log('🎭 Simulated j-event added to server input:');
        console.log(`    Event: ${simulatedJEvent.type}`);
        console.log(`    Entity: #${simulatedJEvent.entityNumber}`);
        console.log(`    Block: ${simulatedJEvent.blockNumber}`);
        console.log(`    Purpose: ${simulatedJEvent.data.purpose}`);
    }
}
/**
 * Example of how to set up j-event watcher in production
 */
export function setupProductionJWatcher(env) {
    // Read configuration from environment
    const rpcUrl = process.env.ETHEREUM_RPC_URL || 'http://localhost:8545';
    const entityProviderAddr = process.env.ENTITY_PROVIDER_ADDRESS;
    const depositoryAddr = process.env.DEPOSITORY_ADDRESS;
    if (!entityProviderAddr || !depositoryAddr) {
        throw new Error('Missing required environment variables: ENTITY_PROVIDER_ADDRESS, DEPOSITORY_ADDRESS');
    }
    console.log('🔭 Setting up production J-Event Watcher...');
    console.log(`    RPC URL: ${rpcUrl}`);
    console.log(`    EntityProvider: ${entityProviderAddr}`);
    console.log(`    Depository: ${depositoryAddr}`);
    return setupJEventWatcher(env, rpcUrl, entityProviderAddr, depositoryAddr);
}
// Run demo if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
    demoJEventWatcher().catch(console.error);
}

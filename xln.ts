#!/usr/bin/env bun
/**
 * XLN CLI Entry Point
 *
 * This is the main entry point to run xln server.
 * Runtime is a pure library with no side effects.
 *
 * Usage:
 *   bun run xln.ts              → start server with demo prompt
 *   NO_DEMO=1 bun run xln.ts    → start server without demo
 *   bun run xln.ts --no-demo    → same as above
 */

import * as runtime from './runtime/runtime';

const { main, startJEventWatcher, getAvailableJurisdictions } = runtime;

// Verify jurisdiction registrations
async function verifyJurisdictionRegistrations() {
  console.log('\n🔍 === JURISDICTION VERIFICATION ===');
  console.log('📋 Verifying entity registrations across all jurisdictions...\n');

  const jurisdictions = await getAvailableJurisdictions();

  for (const jurisdiction of jurisdictions) {
    try {
      console.log(`🏛️ ${jurisdiction.name}:`);
      console.log(`   📡 RPC: ${jurisdiction.address}`);
      console.log(`   📄 Contract: ${jurisdiction.entityProviderAddress}`);
    } catch (error) {
      console.error(`   ❌ Error: ${error instanceof Error ? error.message : error}`);
    }
  }
  console.log('\n✅ === VERIFICATION COMPLETE ===\n');
}

// Main execution
main()
  .then(async env => {
    if (env) {
      const noDemoFlag = process.env['NO_DEMO'] === '1' || process.argv.includes('--no-demo');

      if (!noDemoFlag) {
        console.log('✅ Node.js environment initialized.');
        console.log('💡 Demo removed - use scenarios/ahb.ts or scenarios/grid.ts instead');
        console.log('💡 To skip this message, use: NO_DEMO=1 bun run xln.ts or --no-demo flag');

        await startJEventWatcher(env);

        setTimeout(async () => {
          await verifyJurisdictionRegistrations();
        }, 2000);
      } else {
        console.log('✅ Node.js environment initialized. Demo skipped (NO_DEMO=1 or --no-demo)');
        console.log('💡 Use scenarios.ahb(env) or scenarios.grid(env) for demos');
      }
    }
  })
  .catch(error => {
    console.error('❌ An error occurred:', error);
    process.exit(1);
  });

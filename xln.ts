#!/usr/bin/env bun
/**
 * XLN CLI Entry Point
 *
 * This is the main entry point to run xln server.
 * Runtime is a pure library with no side effects.
 * Uses BrowserVM by default (external RPC not yet supported).
 *
 * Usage:
 *   bun run xln.ts              → start server with BrowserVM
 *   NO_DEMO=1 bun run xln.ts    → start server without demo prompt
 *   bun run xln.ts --no-demo    → same as above
 */

import * as runtime from './runtime/runtime';
import { ensureBrowserVM } from './runtime/scenarios/boot';

const { main, startJEventWatcher } = runtime;

// Main execution
(async () => {
  try {
    // Initialize BrowserVM first (default mode)
    console.log('🔧 Initializing BrowserVM...');
    const browserVM = await ensureBrowserVM();
    console.log(`✅ BrowserVM ready (Depository: ${browserVM.getDepositoryAddress()})`);

    // Start runtime
    const env = await main();

    if (env) {
      const noDemoFlag = process.env['NO_DEMO'] === '1' || process.argv.includes('--no-demo');

      // Start j-watcher (will detect BrowserVM and skip external RPC)
      await startJEventWatcher(env);

      if (!noDemoFlag) {
        console.log('✅ Node.js environment initialized.');
        console.log('💡 Demo removed - use scenarios/ahb.ts or scenarios/grid.ts instead');
        console.log('💡 To skip this message, use: NO_DEMO=1 bun run xln.ts or --no-demo flag');
      } else {
        console.log('✅ Node.js environment initialized (NO_DEMO mode)');
        console.log('💡 Use scenarios.ahb(env) or scenarios.grid(env) for demos');
      }
    }
  } catch (error) {
    console.error('❌ An error occurred:', error);
    process.exit(1);
  }
})();

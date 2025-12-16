#!/usr/bin/env bun
/**
 * Test AHB in Node/Bun (no browser!)
 *
 * NOTE: Do NOT mock window - BrowserVMProvider uses `typeof window !== 'undefined'`
 * to detect browser vs CLI and uses filesystem for CLI mode.
 */

const runtime = await import('./runtime/runtime.ts');

console.log('Creating env...');
const env = runtime.createEmptyEnv();

console.log('Running prepopulateAHB...');
try {
  await runtime.prepopulateAHB(env);
  console.log('\n✅ ✅ ✅ AHB COMPLETED!');
  process.exit(0);
} catch (error: any) {
  console.error('\n❌ ❌ ❌ AHB FAILED:', error.message);
  process.exit(1);
}

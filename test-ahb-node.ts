#!/usr/bin/env bun
/**
 * Test AHB in Node/Bun (no browser!)
 */

// Mock browser globals for Node/Bun execution
global.window = {
  frontendLogs: { enabled: false }
} as any;
global.document = {
  querySelectorAll: () => [],
  querySelector: () => null,
  body: {}
} as any;

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

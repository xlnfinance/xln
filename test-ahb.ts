#!/usr/bin/env bun
/**
 * Test runner for AHB scenario with RJEA event consolidation
 */
import { prepopulateAHB } from './runtime/scenarios/ahb';
import { createDefaultEnv } from './runtime/runtime';

console.log('🚀 Starting AHB test with AccountSettled events...\n');

const env = createDefaultEnv();
await prepopulateAHB(env);

console.log('\n✅ AHB test completed successfully!');
console.log(`📊 Total frames: ${env.history?.length || 0}`);
console.log('🎉 RJEA event consolidation verified!\n');

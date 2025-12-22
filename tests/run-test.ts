#!/usr/bin/env bun
/**
 * E2E Test Runner for XLN
 *
 * Runs E2E tests using Playwright MCP tools via Claude Code
 *
 * Usage:
 *   bun run tests/e2e/run-test.ts <test-name>
 *
 * Example:
 *   bun run tests/e2e/run-test.ts smoke
 *   bun run tests/e2e/run-test.ts payment-flow
 */

const testName = process.argv[2] || 'smoke';

console.log('═══════════════════════════════════════');
console.log('🧪 XLN E2E Test Runner');
console.log('═══════════════════════════════════════');
console.log('');
console.log(`Test: ${testName}`);
console.log(`Base URL: https://localhost:8080`);
console.log('');
console.log('📝 Note: This script outputs instructions for running tests via Claude Code');
console.log('   The actual test execution happens through Playwright MCP tools');
console.log('');

// Test suite definitions
const tests = {
  smoke: {
    name: 'Smoke Test',
    description: 'Verify XLN loads and basic functionality works',
    steps: [
      '1. Navigate to https://localhost:8080',
      '2. Wait for XLN runtime to load (check window.XLN exists)',
      '3. Get environment state (height, replica count)',
      '4. Check for console errors',
      '5. Take screenshot',
    ]
  },

  'entity-creation': {
    name: 'Entity Creation Test',
    description: 'Test entity creation flow end-to-end',
    steps: [
      '1. Navigate to https://localhost:8080',
      '2. Wait for XLN ready',
      '3. Click Settings',
      '4. Click "Create Entity"',
      '5. Wait for entity creation (2-3 seconds)',
      '6. Verify entity count increased',
      '7. Take screenshot',
    ]
  },

  'payment-flow': {
    name: 'Complete Payment Flow Test',
    description: 'Test account opening and payment processing',
    steps: [
      '1. Navigate to https://localhost:8080',
      '2. Create Entity A (Alice)',
      '3. Create Entity B (Bob)',
      '4. Open account: Alice → Bob',
      '5. Send payment: 100 USDC',
      '6. Verify balances updated',
      '7. Verify state roots match',
      '8. Take screenshot',
    ]
  },

  'consensus-verification': {
    name: 'Bilateral Consensus Verification',
    description: 'Test bilateral consensus between two entities',
    steps: [
      '1. Create two entities',
      '2. Open account',
      '3. Send multiple payments',
      '4. Verify all state transitions match',
      '5. Check frame history consistency',
    ]
  },
};

const test = tests[testName as keyof typeof tests];

if (!test) {
  console.error(`❌ Unknown test: ${testName}`);
  console.error(`Available tests: ${Object.keys(tests).join(', ')}`);
  process.exit(1);
}

console.log(`📋 ${test.name}`);
console.log(`   ${test.description}`);
console.log('');
console.log('Test Steps:');
test.steps.forEach(step => console.log(`   ${step}`));
console.log('');
console.log('═══════════════════════════════════════');
console.log('🤖 To run this test with Claude Code:');
console.log('');
console.log('   Ask Claude: "Run E2E test: ' + testName + '"');
console.log('');
console.log('   Claude will use Playwright MCP tools to:');
console.log('   - Navigate browser to localhost:8080');
console.log('   - Execute test steps');
console.log('   - Capture screenshots');
console.log('   - Verify results');
console.log('   - Report pass/fail');
console.log('');
console.log('═══════════════════════════════════════');

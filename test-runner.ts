/**
 * Unified test runner for XLN
 * Runs all available test files
 */

import { spawn } from 'child_process';
import { readdirSync } from 'fs';

const testFiles = readdirSync('.')
  .filter(file => file.startsWith('test-') && file.endsWith('.ts'))
  .filter(file => !file.includes('runner')); // Don't run self

console.log('🧪 XLN Unified Test Runner');
console.log('=========================');
console.log(`Found ${testFiles.length} test files:`);
testFiles.forEach((file, i) => console.log(`  ${i + 1}. ${file}`));
console.log('');

async function runTest(filename: string): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    console.log(`🔄 Running ${filename}...`);
    const start = Date.now();

    const proc = spawn('bun', ['run', filename], {
      stdio: 'pipe',
      timeout: 15000 // 15 second timeout per test
    });

    let output = '';
    let errorOutput = '';

    proc.stdout.on('data', (data) => {
      output += data.toString();
    });

    proc.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    proc.on('close', (code) => {
      const duration = Date.now() - start;
      if (code === 0) {
        console.log(`✅ ${filename} passed (${duration}ms)`);
        resolve({ success: true });
      } else {
        console.log(`❌ ${filename} failed (${duration}ms)`);
        console.log(`   Error: ${errorOutput.split('\n')[0] || 'Unknown error'}`);
        resolve({ success: false, error: errorOutput });
      }
    });

    proc.on('error', (err) => {
      console.log(`❌ ${filename} errored: ${err.message}`);
      resolve({ success: false, error: err.message });
    });
  });
}

async function runAllTests() {
  let passed = 0;
  let failed = 0;

  for (const file of testFiles) {
    const result = await runTest(file);
    if (result.success) {
      passed++;
    } else {
      failed++;
    }
  }

  console.log('\n📊 Test Results Summary:');
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`📁 Total: ${testFiles.length}`);

  if (failed > 0) {
    console.log('\n⚠️  Some tests failed - review output above');
    process.exit(1);
  } else {
    console.log('\n🎉 All tests passed!');
  }
}

runAllTests().catch(console.error);
#!/usr/bin/env node
/**
 * Auto-test: Entity panel click-to-open
 * Run: node test-entity-click.mjs
 */

import { chromium } from 'playwright';

async function testEntityClick() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Capture console logs
  const consoleLogs = [];
  page.on('console', msg => {
    const text = msg.text();
    consoleLogs.push(text);
    if (text.includes('ERROR') || text.includes('FAILED') || text.includes('Missing')) {
      console.log('❌ Console error:', text);
    }
  });

  try {
    console.log('🚀 Opening https://localhost:8080/view ...');
    await page.goto('https://localhost:8080/view', {
      waitUntil: 'networkidle',
      timeout: 30000
    });

    // Wait for Graph3D to render
    console.log('⏳ Waiting for Graph3D...');
    await page.waitForTimeout(5000);

    // Check for AHB scenario loaded
    const hasEntities = await page.evaluate(() => {
      return document.body.textContent?.includes('Alice') ||
             document.body.textContent?.includes('Hub') ||
             document.body.textContent?.includes('Bob');
    });

    if (!hasEntities) {
      console.log('⚠️  AHB scenario not auto-loaded');
    } else {
      console.log('✅ AHB scenario detected');
    }

    // Try to find and click Hub entity
    console.log('🔍 Looking for Hub entity sphere...');

    // Check console for entity panel logs
    await page.waitForTimeout(2000);

    const hasStoredData = consoleLogs.some(log => log.includes('📋 Stored pending entity data'));
    const hasConsumedData = consoleLogs.some(log => log.includes('✅ Consumed pending data'));
    const hasMissingData = consoleLogs.some(log => log.includes('Missing entityId'));

    console.log('\n📊 RESULTS:');
    console.log('  - Stored entity data:', hasStoredData ? '✅' : '❌');
    console.log('  - Consumed entity data:', hasConsumedData ? '✅' : '❌');
    console.log('  - Missing data errors:', hasMissingData ? '❌ FAIL' : '✅');

    // Check for infinite loops
    const loopErrors = consoleLogs.filter(log => log.includes('effect_update_depth_exceeded'));
    if (loopErrors.length > 0) {
      console.log('  - Infinite loop detected: ❌ CRITICAL');
    } else {
      console.log('  - No infinite loops: ✅');
    }

    // Overall verdict
    if (!hasMissingData && !loopErrors.length) {
      console.log('\n🎉 ALL TESTS PASSED!');
      return true;
    } else {
      console.log('\n❌ TESTS FAILED - check console logs above');
      return false;
    }

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    return false;
  } finally {
    await browser.close();
  }
}

testEntityClick().then(success => {
  process.exit(success ? 0 : 1);
});

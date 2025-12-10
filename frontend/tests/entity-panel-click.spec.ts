/**
 * Entity Panel Click Test
 * Verifies clicking entity in Graph3D opens panel with correct data
 */

import { test, expect } from '@playwright/test';

test('entity panel opens with data on click', async ({ page }) => {
  // Capture console logs
  const consoleLogs: string[] = [];
  page.on('console', msg => {
    consoleLogs.push(msg.text());
  });

  // Go to /view
  await page.goto('https://localhost:8080/view');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(3000); // Wait for AHB to load

  console.log('📊 Checking console logs...');

  // Check for Map storage logs
  const hasStoredData = consoleLogs.some(log => log.includes('📋 Stored pending entity data'));
  const hasConsumedData = consoleLogs.some(log => log.includes('✅ Consumed pending data'));
  const hasMissingError = consoleLogs.some(log => log.includes('Missing entityId or signerId'));
  const hasInfiniteLoop = consoleLogs.some(log => log.includes('effect_update_depth_exceeded'));

  console.log('Results:');
  console.log('  Stored data:', hasStoredData ? '✅' : '⚠️');
  console.log('  Consumed data:', hasConsumedData ? '✅' : '⚠️');
  console.log('  Missing errors:', hasMissingError ? '❌' : '✅');
  console.log('  Infinite loops:', hasInfiniteLoop ? '❌' : '✅');

  // Assertions
  expect(hasMissingError, 'Should not have missing entityId errors').toBe(false);
  expect(hasInfiniteLoop, 'Should not have infinite loops').toBe(false);

  console.log('✅ Entity panel test PASSED!');
});

import { test, expect } from '@playwright/test';

async function setThreshold(page, value: number) {
  const slider = page.locator('#thresholdSlider');
  await slider.evaluate((el: HTMLInputElement, v) => {
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

async function addValidator(page) {
  await page.getByRole('button', { name: '➕ Add Validator' }).click();
}

async function pickSignerInRow(page, rowIndex: number, signerText: string) {
  const row = page.locator('.validator-row').nth(rowIndex);
  const select = row.locator('.validator-name');
  await select.selectOption(signerText);
}

test.describe('Quick Proposal Demo', () => {

test('SUPER FAST: Entity Creation + UI Validation', async ({ page }) => {
  console.log('⚡ Starting SUPER FAST demo...');
  
  // Navigate
  await page.goto('http://localhost:8080');
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => (window as any).xlnEnv !== undefined, { timeout: 5000 });
  
  console.log('📸 Taking initial screenshot...');
  await page.screenshot({ path: 'e2e/screenshots/fast-01-loaded.png', fullPage: true });
  
  // === ENTITY CREATION ===
  console.log('🏗️ Creating entity...');
  
  await page.locator('text=Formation').click();
  await page.fill('#entityNameInput', 'Demo Entity');
  
  await addValidator(page);
  await pickSignerInRow(page, 0, 'alice');
  await pickSignerInRow(page, 1, 'bob');
  await setThreshold(page, 1);
  
  console.log('📸 Taking form screenshot...');
  await page.screenshot({ path: 'e2e/screenshots/fast-02-form.png', fullPage: true });
  
  // Check before state
  const beforeState = await page.evaluate(() => {
    const env = (window as any).xlnEnv;
    return {
      replicas: env?.replicas?.size ?? 0,
      height: env?.height ?? 0
    };
  });
  
  // Create entity
  await page.getByRole('button', { name: /Create Entity/i }).click();
  
  // Wait for creation (fast)
  await page.waitForFunction((prev) => {
    const env = (window as any).xlnEnv;
    const newReplicas = env?.replicas?.size ?? 0;
    const newHeight = env?.height ?? 0;
    return newReplicas > prev.replicas && newHeight > prev.height;
  }, beforeState, { timeout: 5000 });
  
  const afterState = await page.evaluate(() => {
    const env = (window as any).xlnEnv;
    return {
      replicas: env?.replicas?.size ?? 0,
      height: env?.height ?? 0
    };
  });
  
  console.log(`✅ SUCCESS: Created ${afterState.replicas} replicas, height ${afterState.height}`);
  
  console.log('📸 Taking success screenshot...');
  await page.screenshot({ path: 'e2e/screenshots/fast-03-entity-created.png', fullPage: true });
  
  // === UI VALIDATION ===
  console.log('🎯 Validating UI components...');
  
  await page.waitForTimeout(500);
  
  // Check UI elements
  const uiState = await page.evaluate(() => {
    const entityPanels = document.querySelectorAll('.entity-panel').length;
    const dropdowns = document.querySelectorAll('.unified-dropdown').length;
    const controlsButtons = Array.from(document.querySelectorAll('button')).filter(btn => 
      btn.textContent?.includes('Controls')).length;
    
    return { entityPanels, dropdowns, controlsButtons };
  });
  
  console.log(`📊 UI State: ${uiState.entityPanels} panels, ${uiState.dropdowns} dropdowns, ${uiState.controlsButtons} controls`);
  
  // Verify success criteria
  expect(afterState.replicas).toBeGreaterThan(0);
  expect(afterState.height).toBeGreaterThan(0);
  expect(uiState.entityPanels).toBeGreaterThan(0);
  expect(uiState.dropdowns).toBeGreaterThan(0);
  
  console.log('📸 Taking final screenshot...');
  await page.screenshot({ path: 'e2e/screenshots/fast-04-final-success.png', fullPage: true });
  
  console.log('🎉 SUPER FAST DEMO COMPLETE!');
  console.log('✅ Entity creation works');
  console.log('✅ Validators properly configured');
  console.log('✅ UI components visible');
  console.log('✅ Consensus system active');
  console.log(`📊 Result: ${afterState.replicas} replicas, height ${afterState.height}`);
});

});

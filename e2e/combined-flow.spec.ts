import { test, expect } from '@playwright/test';

async function setThreshold(page, value: number) {
  const slider = page.locator('#thresholdSlider');
  await slider.evaluate((el: HTMLInputElement, v) => {
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

async function addValidator(page) {
  await page.getByRole('button', { name: '➕ Add New Validator' }).click();
}

async function pickSignerInRow(page, rowIndex: number, signerText: string) {
  const row = page.locator('.validator-row').nth(rowIndex);
  await row.locator('.validator-selector').click();
  const options = page.locator('.validator-options:visible');
  await expect(options).toBeVisible();
  await options.getByText(`${signerText}.eth`, { exact: true }).click();
}

async function openTabDropdown(page, tabIndex: number) {
  const panel = page.locator('.entity-panel').nth(tabIndex);
  const tabId = await panel.getAttribute('data-panel-id');
  await panel.locator('.unified-dropdown-btn').click();
  return tabId!;
}

async function selectSignerIndexAndFirstEntity(page, tabId: string, signerIndex: number) {
  const content = page.locator(`#dropdownContent-${tabId}`);
  await expect(content).toBeVisible();
  // Ensure results are populated
  await page.waitForTimeout(200);
  // pick nth signer item with '👤' prefix in the same row
  const signers = content.locator('.dropdown-item');
  const count = await signers.count();
  let clicked = false;
  for (let i = 0; i < count; i++) {
    const row = signers.nth(i);
    const text = (await row.innerText()).trim();
    if (text.includes('👤') && text.includes('.eth')) {
      if (signerIndex === 0) {
        await row.click();
        clicked = true;
        break;
      }
      signerIndex--;
    }
  }
  if (!clicked) throw new Error('No signer item found');
  // pick first entity row (starts with 0x)
  const entities = content.locator('.dropdown-item');
  const ecount = await entities.count();
  for (let i = 0; i < ecount; i++) {
    const row = entities.nth(i);
    const t = (await row.innerText()).trim();
    if (t.includes('🏢') && t.includes('0x')) {
      await row.click();
      return;
    }
  }
  throw new Error('No entity item found');
}

test('combined: proposal, chat, 3 panels with validators, time machine, holds', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as any).xlnEnv), undefined, { timeout: 30000 });

  // Create lazy entity with 3 validators (alice, bob, carol) and threshold 2
  await page.locator('#entityTypeSelect').selectOption('lazy');
  const name = `Combo_${Date.now()}`;
  await page.locator('#entityNameInput').fill(name);

  // add two more validator rows
  await addValidator(page);
  await addValidator(page);

  // pick signers for three rows
  await pickSignerInRow(page, 0, 'alice');
  await pickSignerInRow(page, 1, 'bob');
  await pickSignerInRow(page, 2, 'carol');

  // threshold 2
  await setThreshold(page, 2);

  // snapshot size before
  const beforeCount = await page.evaluate(() => (window as any).xlnEnv?.replicas?.size ?? 0);

  // create entity
  await page.getByRole('button', { name: /Create Entity/i }).click();

  // wait for replicas to include alice/bob/carol
  await page.waitForFunction((prev) => {
    const env = (window as any).xlnEnv;
    return env && env.replicas && env.replicas.size > prev;
  }, beforeCount, { timeout: 30000 });

  // Ensure we have at least 3 panels; the app initializes 3 by default
  await expect(page.locator('.entity-panel')).toHaveCount(3);

  // Open dropdowns and select signer+entity for three panels
  const tabId0 = await openTabDropdown(page, 0);
  await selectSignerIndexAndFirstEntity(page, tabId0, 0); // first signer
  const tabId1 = await openTabDropdown(page, 1);
  await selectSignerIndexAndFirstEntity(page, tabId1, 1); // second signer
  const tabId2 = await openTabDropdown(page, 2);
  await selectSignerIndexAndFirstEntity(page, tabId2, 2); // third signer

  // Create chat in first panel controls
  await page.locator(`#controls-${tabId0} .component-header`).click();
  await page.locator(`#controlsContent-${tabId0} textarea`).fill('Hello from E2E chat');
  await page.getByRole('button', { name: 'Send Message' }).first().click();

  // Create proposal in first panel
  await page.locator(`#controlsContent-${tabId0} select.controls-dropdown`).selectOption('proposal');
  const proposalTitle = 'E2E Proposal: Increase limit';
  await page.locator(`#controlsContent-${tabId0} .form-input`).first().fill(proposalTitle);
  await page.locator(`#controlsContent-${tabId0} .form-textarea`).first().fill('Propose to increase daily limit');
  await page.getByRole('button', { name: 'Create Proposal' }).click();

  // Vote YES in panel 2 and 3
  for (const tabId of [tabId1, tabId2]) {
    await page.locator(`#controls-${tabId} .component-header`).click();
    await page.locator(`#controlsContent-${tabId} select.controls-dropdown`).selectOption('vote');
    // wait for proposals to populate in select
    const select = page.locator(`#proposalSelect-${tabId}`);
    await expect(select).toBeVisible();
    // pick first real option (skip placeholder)
    const optionsCount = await select.locator('option').count();
    if (optionsCount > 1) {
      const value = await select.locator('option').nth(1).getAttribute('value');
      await select.selectOption(value!);
    }
    await page.locator(`#voteChoice-${tabId}`).selectOption('yes');
    await page.locator(`#controlsForm-${tabId}`).getByRole('button', { name: 'Submit Vote' }).click();
  }

  // Expand proposals in panel 1 and expect the created proposal to appear
  await page.locator(`#proposals-${tabId0} .component-header`).click();
  await page.waitForTimeout(500);
  await expect(page.locator(`#proposalsContent-${tabId0}`)).toContainText('E2E Proposal: Increase limit', { timeout: 8000 });

  // Time machine: step back then forward to LIVE
  await page.locator('.time-btn-compact', { hasText: '⏪' }).click();
  await page.waitForTimeout(400);
  await page.locator('.time-btn-compact', { hasText: '⏩' }).click();
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: '⚡ LIVE' }).click();

  // Final 2s hold for video
  await page.waitForTimeout(2000);
});



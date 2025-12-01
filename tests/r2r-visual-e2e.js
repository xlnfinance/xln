/**
 * 3×3 Hub E2E Test - Visual R2R Demo
 * Creates 9 entities in hub topology, funds them, runs 3 R2R payments
 *
 * Run: node tests/r2r-visual-e2e.js
 */

import { chromium } from 'playwright';

const log = (msg) => console.log(`📺 ${msg}`);
const shot = async (page, name) => {
  await page.screenshot({ path: `/tmp/hub-${name}.png` });
  console.log(`📸 /tmp/hub-${name}.png`);
};

async function main() {
  console.log('\n⬡ 3×3 HUB E2E TEST\n');

  const browser = await chromium.launch({ headless: false, slowMo: 40 });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  try {
    // 1. Navigate
    log('1. Opening /view...');
    await page.goto('http://localhost:8080/view', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(1200);

    // 2. Close tutorial
    log('2. Closing tutorial...');
    const skipBtn = await page.$('button.skip-btn');
    if (skipBtn) {
      await skipBtn.click();
      await page.waitForTimeout(300);
    }
    await shot(page, '01-start');

    // 3. Go to Economy tab first to create Xlnomy
    log('3. Opening Economy tab...');
    await page.evaluate(() => {
      document.querySelectorAll('button').forEach(b => {
        if (b.textContent?.trim() === 'Economy') b.click();
      });
    });
    await page.waitForTimeout(500);

    // 4. Click "Create Jurisdiction Here" button
    log('4. Creating Xlnomy...');
    await page.evaluate(() => {
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        if (b.textContent?.includes('Create Jurisdiction') || b.classList.contains('create-xlnomy-btn')) {
          b.click();
          return;
        }
      }
    });
    await page.waitForTimeout(500);

    // 5. Click Create in modal
    log('5. Confirming in modal...');
    const modalBtn = await page.$('.modal-actions button.action-btn:not(.secondary)');
    if (modalBtn) {
      await modalBtn.click();
      await page.waitForTimeout(1500);
      log('   ✓ Xlnomy created');
    }
    await shot(page, '02-xlnomy-created');

    // 6. Stay in Economy tab - scroll down to BANKER DEMO
    log('6. Scrolling to BANKER DEMO (in Economy tab)...');

    // BANKER DEMO is in Economy mode, not Build mode!
    // Use Playwright locator to find and scroll to Step 1
    const step1Btn = page.locator('button.step-1').first();
    await step1Btn.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await shot(page, '03-banker-demo');

    // 7. Step 1: Create 3×3 Hub (9 entities)
    log('7. Step 1: Creating 3×3 Hub...');
    await step1Btn.click();
    await page.waitForTimeout(3000);

    let count = await page.evaluate(() => {
      const m = document.body.innerText.match(/(\d+)\s*total/i);
      return m?.[1] || '0';
    });
    log(`   ✓ Created ${count} entities`);
    await shot(page, '04-entities-created');

    // 8. Step 2: Fund All
    log('8. Step 2: Funding all entities...');
    const step2Btn = page.locator('button.step-2').first();
    await step2Btn.click();
    await page.waitForTimeout(2000);
    await shot(page, '05-funded');

    // 9-11. Three R2R payments
    for (let i = 1; i <= 3; i++) {
      log(`${8+i}. R2R Payment #${i}...`);
      const step3Btn = page.locator('button.step-3').first();
      await step3Btn.click();
      await page.waitForTimeout(1500);
      await shot(page, `0${5+i}-r2r${i}`);
    }

    // 12. Final stats
    log('12. Final state...');
    const stats = await page.evaluate(() => ({
      entities: document.body.innerText.match(/(\d+)\s*total/i)?.[1] || '?',
      frames: document.body.innerText.match(/RUNTIME\s*(\d+)/)?.[1] || '?'
    }));
    log(`    ✓ ${stats.entities} entities, ${stats.frames} frames`);
    await shot(page, '09-final');

    // 13. Time machine
    log('13. Time machine replay...');
    const slider = await page.$('input[type="range"]');
    if (slider) {
      const max = parseInt(await slider.getAttribute('max') || '0');
      log(`    Slider range: 0-${max}`);
      if (max > 1) {
        await slider.fill('0');
        await page.waitForTimeout(700);
        await shot(page, '10-frame0');

        await slider.fill(String(Math.floor(max/2)));
        await page.waitForTimeout(700);
        await shot(page, '11-frameMid');

        await slider.fill(String(max));
        await page.waitForTimeout(700);
        await shot(page, '12-frameEnd');
      }
    }

    log('✅ 3×3 HUB E2E COMPLETE!');
    await page.waitForTimeout(3000);

  } catch (err) {
    console.error('❌ Error:', err.message);
    await shot(page, 'error');
  } finally {
    await browser.close();
    console.log('\n📁 Screenshots: /tmp/hub-*.png\n');
  }
}

main();

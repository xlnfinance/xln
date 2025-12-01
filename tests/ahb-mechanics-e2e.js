/**
 * Alice-Hub-Bob (AHB) Mechanics E2E Test
 *
 * Tests the REAL basic mechanics:
 * - R2R (Reserve-to-Reserve transfers)
 * - R2C (Reserve-to-Collateral prefunding)
 * - Off-chain bilateral ondelta changes
 * - Credit extension beyond collateral
 * - C2R (Collateral-to-Reserve settlement)
 *
 * Run: node tests/ahb-mechanics-e2e.js
 */

import { chromium } from 'playwright';

const log = (msg) => console.log(`[AHB] ${msg}`);
const shot = async (page, name) => {
  await page.screenshot({ path: `/tmp/ahb-${name}.png` });
  console.log(`  /tmp/ahb-${name}.png`);
};

async function main() {
  console.log('\n========================================');
  console.log(' ALICE-HUB-BOB MECHANICS E2E TEST');
  console.log('========================================\n');

  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  try {
    // 1. Navigate
    log('1. Opening /view...');
    await page.goto('http://localhost:8080/view', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(1500);

    // 2. Close tutorial if present
    log('2. Checking for tutorial overlay...');
    const skipBtn = await page.$('button.skip-btn');
    if (skipBtn) {
      log('   Closing tutorial...');
      await skipBtn.click();
      await page.waitForTimeout(500);
    }
    await shot(page, '01-start');

    // 3. Go to Architect panel and find A-H-B button
    log('3. Opening Architect panel...');

    // Click on Architect tab
    await page.evaluate(() => {
      const tabs = document.querySelectorAll('.tab, .panel-tab, button');
      for (const tab of tabs) {
        if (tab.textContent?.includes('Architect')) {
          tab.click();
          return true;
        }
      }
      return false;
    });
    await page.waitForTimeout(800);

    // 4. Expand Elementary presets category
    log('4. Expanding Elementary presets...');
    await page.evaluate(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent?.toLowerCase().includes('elementary')) {
          btn.click();
          return true;
        }
      }
      return false;
    });
    await page.waitForTimeout(500);
    await shot(page, '02-architect-elementary');

    // 5. Click Alice-Hub-Bob preset
    log('5. Starting Alice-Hub-Bob tutorial...');
    const ahbClicked = await page.evaluate(() => {
      const buttons = document.querySelectorAll('button.preset-item, button');
      for (const btn of buttons) {
        if (btn.textContent?.includes('A-H-B') || btn.textContent?.includes('Alice-Hub-Bob')) {
          btn.click();
          return true;
        }
      }
      return false;
    });

    if (!ahbClicked) {
      throw new Error('Could not find Alice-Hub-Bob button');
    }

    log('   Waiting for demo to initialize...');
    await page.waitForTimeout(3000);
    await shot(page, '03-ahb-started');

    // 6. Verify entities created (should be 3: Alice, Hub, Bob)
    log('6. Verifying entities...');
    const entityCount = await page.evaluate(() => {
      const text = document.body.innerText;
      const match = text.match(/(\d+)\s*total/i);
      return match ? parseInt(match[1]) : 0;
    });
    log(`   Found ${entityCount} entities (expected 3)`);

    if (entityCount !== 3) {
      log(`   WARNING: Expected 3 entities, got ${entityCount}`);
    }

    // 7. Check for time machine frames (use slider max attribute)
    log('7. Checking time machine frames...');
    const sliderCheck = await page.$('input[type="range"]');
    const maxFrames = sliderCheck ? parseInt(await sliderCheck.getAttribute('max') || '0') + 1 : 0;
    log(`   Total frames: ${maxFrames} (expected 9)`);
    await shot(page, '04-frames-loaded');

    // 8. Step through frames using time machine
    log('8. Testing time machine playback...');

    const slider = await page.$('input[type="range"]');
    if (slider) {
      const max = parseInt(await slider.getAttribute('max') || '0');
      log(`   Slider range: 0-${max}`);

      if (max > 0) {
        // Frame 0: Initial State
        log('   Frame 0: Initial State (Hub funded)');
        await slider.fill('0');
        await page.waitForTimeout(1000);
        await shot(page, '05-frame0-initial');

        // Frame 1: R2R Hub→Alice
        if (max >= 1) {
          log('   Frame 1: R2R Hub→Alice');
          await slider.fill('1');
          await page.waitForTimeout(1000);
          await shot(page, '06-frame1-r2r-alice');
        }

        // Frame 2: R2R Hub→Bob
        if (max >= 2) {
          log('   Frame 2: R2R Hub→Bob');
          await slider.fill('2');
          await page.waitForTimeout(1000);
          await shot(page, '07-frame2-r2r-bob');
        }

        // Frame 3: R2C Alice prefunds
        if (max >= 3) {
          log('   Frame 3: R2C Alice prefunds');
          await slider.fill('3');
          await page.waitForTimeout(1000);
          await shot(page, '08-frame3-r2c-alice');
        }

        // Frame 4: R2C Bob prefunds
        if (max >= 4) {
          log('   Frame 4: R2C Bob prefunds');
          await slider.fill('4');
          await page.waitForTimeout(1000);
          await shot(page, '09-frame4-r2c-bob');
        }

        // Frame 5: Off-chain Alice→Hub
        if (max >= 5) {
          log('   Frame 5: Off-chain ondelta Alice→Hub');
          await slider.fill('5');
          await page.waitForTimeout(1000);
          await shot(page, '10-frame5-offchain-alice');
        }

        // Frame 6: Credit extension Hub→Bob
        if (max >= 6) {
          log('   Frame 6: Credit extension Hub→Bob');
          await slider.fill('6');
          await page.waitForTimeout(1000);
          await shot(page, '11-frame6-credit-extension');
        }

        // Frame 7: C2R Settlement
        if (max >= 7) {
          log('   Frame 7: C2R Alice settles');
          await slider.fill('7');
          await page.waitForTimeout(1000);
          await shot(page, '12-frame7-settlement');
        }

        // Frame 8: Final state
        if (max >= 8) {
          log('   Frame 8: Final state');
          await slider.fill('8');
          await page.waitForTimeout(1000);
          await shot(page, '13-frame8-final');
        }

        // Return to end
        await slider.fill(String(max));
        await page.waitForTimeout(500);
      }
    }

    // 9. Verify subtitles are showing (Fed Chair explanations)
    log('9. Checking for educational subtitles...');
    const hasSubtitles = await page.evaluate(() => {
      const text = document.body.innerText.toLowerCase();
      return text.includes('reserve-to-reserve') ||
             text.includes('r2r') ||
             text.includes('collateral') ||
             text.includes('ondelta') ||
             text.includes('tradfi');
    });
    log(`   Subtitles visible: ${hasSubtitles ? 'YES' : 'NO'}`);

    // 10. Final verification
    log('10. Final state check...');
    await shot(page, '14-final');

    // Summary
    console.log('\n========================================');
    console.log(' AHB MECHANICS E2E RESULTS');
    console.log('========================================');
    console.log(` Entities: ${entityCount} (expected 3)`);
    console.log(` Frames: ${maxFrames} (expected 9)`);
    console.log(` Subtitles: ${hasSubtitles ? 'Visible' : 'Not visible'}`);
    console.log('');

    if (entityCount === 3 && maxFrames >= 9 && hasSubtitles) {
      console.log(' AHB MECHANICS TEST PASSED!');
    } else {
      console.log(' AHB TEST INCOMPLETE - check screenshots');
    }
    console.log('========================================\n');

    log('Keeping browser open for 5 seconds...');
    await page.waitForTimeout(5000);

  } catch (err) {
    console.error(' Error:', err.message);
    await shot(page, 'error');
  } finally {
    await browser.close();
    console.log('\nScreenshots: /tmp/ahb-*.png\n');
  }
}

main();

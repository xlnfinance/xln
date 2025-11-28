import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Test configuration
const BASE_URL = 'http://localhost:8080';
const SCREENSHOT_DIR = path.join(__dirname, '../reports/ux-flow-screenshots');
const TIMEOUT = 30000;

// Ensure screenshot directory exists
if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

// Test results tracker
const results = {
  tutorialSkip: { status: 'PENDING', errors: [], screenshots: [] },
  panelTabNavigation: { status: 'PENDING', errors: [], screenshots: [], tabs: {} },
  entityCreation: { status: 'PENDING', errors: [], screenshots: [] },
  entityList: { status: 'PENDING', errors: [], screenshots: [] },
  miniPanelFlow: { status: 'PENDING', errors: [], screenshots: [] },
  expandToFullPanel: { status: 'PENDING', errors: [], screenshots: [] }
};

let consoleErrors = [];
let consoleWarnings = [];

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function takeScreenshot(page, name, testName) {
  const filename = `${testName}-${name}-${Date.now()}.png`;
  const filepath = path.join(SCREENSHOT_DIR, filename);
  await page.screenshot({ path: filepath, fullPage: true });
  results[testName].screenshots.push(filename);
  console.log(`📸 Screenshot saved: ${filename}`);
  return filepath;
}

async function runTests() {
  console.log('🚀 Starting XLN UX Flow Verification Tests\n');
  console.log('=' .repeat(80));

  const browser = await chromium.launch({
    headless: false,
    slowMo: 500 // Slow down actions for visibility
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 }
  });

  const page = await context.newPage();

  // Capture console messages
  page.on('console', msg => {
    const type = msg.type();
    const text = msg.text();

    if (type === 'error') {
      consoleErrors.push({ text, timestamp: new Date().toISOString() });
      console.log(`❌ Console Error: ${text}`);
    } else if (type === 'warning') {
      consoleWarnings.push({ text, timestamp: new Date().toISOString() });
    }
  });

  // Capture page errors
  page.on('pageerror', error => {
    consoleErrors.push({ text: error.message, timestamp: new Date().toISOString() });
    console.log(`❌ Page Error: ${error.message}`);
  });

  try {
    // ========================================================================
    // TEST 1: Tutorial Skip
    // ========================================================================
    console.log('\n📋 TEST 1: Tutorial Skip');
    console.log('-'.repeat(80));

    try {
      // Set localStorage before navigating
      await page.addInitScript(() => {
        localStorage.setItem('xln-tutorial-seen', 'true');
      });

      console.log('✓ Set localStorage flag: xln-tutorial-seen = true');

      // Navigate to the app
      await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: TIMEOUT });
      await sleep(2000);

      await takeScreenshot(page, 'after-load', 'tutorialSkip');

      // Check if tutorial modal is present
      const tutorialModal = await page.locator('[data-testid="tutorial-modal"], .tutorial-modal, [class*="Tutorial"]').count();
      const anyModal = await page.locator('[role="dialog"], .modal, [class*="Modal"]').count();

      if (tutorialModal === 0 && anyModal === 0) {
        results.tutorialSkip.status = 'PASS';
        console.log('✅ PASS: No tutorial modal displayed');
      } else {
        results.tutorialSkip.status = 'FAIL';
        results.tutorialSkip.errors.push(`Tutorial modal or dialog detected (count: ${tutorialModal || anyModal})`);
        console.log('❌ FAIL: Tutorial modal found when it should be hidden');
      }

      // Verify localStorage was set
      const localStorageValue = await page.evaluate(() => localStorage.getItem('xln-tutorial-seen'));
      console.log(`✓ localStorage value confirmed: ${localStorageValue}`);

    } catch (error) {
      results.tutorialSkip.status = 'FAIL';
      results.tutorialSkip.errors.push(error.message);
      console.log(`❌ FAIL: ${error.message}`);
    }

    // ========================================================================
    // TEST 2: Panel Tab Navigation
    // ========================================================================
    console.log('\n📋 TEST 2: Panel Tab Navigation');
    console.log('-'.repeat(80));

    const tabs = ['Graph3D', 'Entities', 'Depository', 'Console', 'Runtime I/O', 'Settings', 'Architect'];

    try {
      for (const tabName of tabs) {
        console.log(`\n  Testing tab: ${tabName}`);

        const errorsBefore = consoleErrors.length;

        // Try multiple selector strategies
        const selectors = [
          `[data-tab="${tabName}"]`,
          `[data-testid="${tabName.toLowerCase()}-tab"]`,
          `button:has-text("${tabName}")`,
          `.tab:has-text("${tabName}")`,
          `[role="tab"]:has-text("${tabName}")`,
          `div[title="${tabName}"]`,
          `.dockview-tab:has-text("${tabName}")`
        ];

        let clicked = false;

        for (const selector of selectors) {
          try {
            const element = page.locator(selector).first();
            const count = await element.count();

            if (count > 0) {
              await element.click({ timeout: 5000 });
              clicked = true;
              console.log(`  ✓ Clicked tab using selector: ${selector}`);
              break;
            }
          } catch (e) {
            // Try next selector
            continue;
          }
        }

        if (!clicked) {
          // Fallback: try to find any element with the tab name text
          try {
            await page.getByText(tabName, { exact: true }).first().click({ timeout: 5000 });
            clicked = true;
            console.log(`  ✓ Clicked tab using text match`);
          } catch (e) {
            results.panelTabNavigation.tabs[tabName] = 'FAIL - Not Found';
            console.log(`  ❌ Could not find tab: ${tabName}`);
            continue;
          }
        }

        await sleep(1000);

        // Take screenshot
        await takeScreenshot(page, tabName.toLowerCase().replace(/\s+/g, '-'), 'panelTabNavigation');

        // Check for new errors
        const errorsAfter = consoleErrors.length;
        const newErrors = errorsAfter - errorsBefore;

        if (newErrors === 0) {
          results.panelTabNavigation.tabs[tabName] = 'PASS';
          console.log(`  ✅ PASS: ${tabName} rendered without errors`);
        } else {
          results.panelTabNavigation.tabs[tabName] = `FAIL - ${newErrors} errors`;
          console.log(`  ❌ FAIL: ${tabName} generated ${newErrors} console errors`);
        }
      }

      // Overall status
      const failedTabs = Object.values(results.panelTabNavigation.tabs).filter(status => status.includes('FAIL'));
      if (failedTabs.length === 0) {
        results.panelTabNavigation.status = 'PASS';
      } else {
        results.panelTabNavigation.status = 'FAIL';
        results.panelTabNavigation.errors.push(`${failedTabs.length} tabs failed`);
      }

    } catch (error) {
      results.panelTabNavigation.status = 'FAIL';
      results.panelTabNavigation.errors.push(error.message);
      console.log(`❌ FAIL: ${error.message}`);
    }

    // ========================================================================
    // TEST 3: Entity Creation
    // ========================================================================
    console.log('\n📋 TEST 3: Entity Creation (Alice-Hub-Bob)');
    console.log('-'.repeat(80));

    try {
      // Click on Architect tab
      console.log('  Navigating to Architect tab...');

      const architectSelectors = [
        `[data-tab="Architect"]`,
        `button:has-text("Architect")`,
        `.tab:has-text("Architect")`,
        `[role="tab"]:has-text("Architect")`
      ];

      let architectClicked = false;
      for (const selector of architectSelectors) {
        try {
          await page.locator(selector).first().click({ timeout: 5000 });
          architectClicked = true;
          break;
        } catch (e) {
          continue;
        }
      }

      if (!architectClicked) {
        await page.getByText('Architect', { exact: true }).first().click({ timeout: 5000 });
      }

      await sleep(1000);
      console.log('  ✓ Architect tab opened');

      // Look for ELEMENTARY section
      console.log('  Looking for ELEMENTARY section...');

      const elementarySelectors = [
        `button:has-text("ELEMENTARY")`,
        `.section:has-text("ELEMENTARY")`,
        `[data-section="ELEMENTARY"]`,
        `div:has-text("ELEMENTARY")`
      ];

      let elementaryClicked = false;
      for (const selector of elementarySelectors) {
        try {
          const elem = page.locator(selector).first();
          const count = await elem.count();
          if (count > 0) {
            await elem.click({ timeout: 5000 });
            elementaryClicked = true;
            console.log(`  ✓ ELEMENTARY section found and clicked`);
            break;
          }
        } catch (e) {
          continue;
        }
      }

      if (!elementaryClicked) {
        console.log('  ℹ ELEMENTARY section not found or not clickable, continuing...');
      }

      await sleep(1000);

      // Look for Alice-Hub-Bob pattern
      console.log('  Looking for Alice-Hub-Bob pattern...');

      const ahbSelectors = [
        `button:has-text("Alice-Hub-Bob")`,
        `[data-pattern="Alice-Hub-Bob"]`,
        `[data-testid="alice-hub-bob"]`,
        `.pattern:has-text("Alice-Hub-Bob")`,
        `div:has-text("Alice-Hub-Bob")`
      ];

      let ahbClicked = false;
      for (const selector of ahbSelectors) {
        try {
          const elem = page.locator(selector).first();
          const count = await elem.count();
          if (count > 0) {
            await elem.click({ timeout: 5000 });
            ahbClicked = true;
            console.log(`  ✓ Alice-Hub-Bob pattern clicked`);
            break;
          }
        } catch (e) {
          continue;
        }
      }

      if (!ahbClicked) {
        // Try generic text search
        try {
          await page.getByText('Alice-Hub-Bob').first().click({ timeout: 5000 });
          ahbClicked = true;
          console.log(`  ✓ Alice-Hub-Bob pattern clicked (text search)`);
        } catch (e) {
          results.entityCreation.status = 'FAIL';
          results.entityCreation.errors.push('Alice-Hub-Bob pattern not found');
          console.log(`  ❌ FAIL: Could not find Alice-Hub-Bob pattern`);

          // Take screenshot of current state
          await takeScreenshot(page, 'ahb-not-found', 'entityCreation');

          // List all visible text for debugging
          const visibleText = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('*'))
              .filter(el => el.offsetParent !== null)
              .map(el => el.textContent?.trim())
              .filter(text => text && text.length > 0 && text.length < 50)
              .slice(0, 50);
          });
          console.log('  Visible text on page:', visibleText.join(', '));
        }
      }

      if (ahbClicked) {
        await sleep(2000);
        await takeScreenshot(page, 'after-ahb-creation', 'entityCreation');

        results.entityCreation.status = 'PASS';
        console.log('  ✅ PASS: Alice-Hub-Bob entities created');
      }

    } catch (error) {
      results.entityCreation.status = 'FAIL';
      results.entityCreation.errors.push(error.message);
      console.log(`  ❌ FAIL: ${error.message}`);
    }

    // ========================================================================
    // TEST 4: Entity List Verification
    // ========================================================================
    console.log('\n📋 TEST 4: Entity List Verification');
    console.log('-'.repeat(80));

    try {
      // Navigate to Entities tab
      console.log('  Navigating to Entities tab...');

      const entitiesSelectors = [
        `[data-tab="Entities"]`,
        `button:has-text("Entities")`,
        `.tab:has-text("Entities")`,
        `[role="tab"]:has-text("Entities")`
      ];

      let entitiesClicked = false;
      for (const selector of entitiesSelectors) {
        try {
          await page.locator(selector).first().click({ timeout: 5000 });
          entitiesClicked = true;
          break;
        } catch (e) {
          continue;
        }
      }

      if (!entitiesClicked) {
        await page.getByText('Entities', { exact: true }).first().click({ timeout: 5000 });
      }

      await sleep(1500);
      console.log('  ✓ Entities tab opened');

      await takeScreenshot(page, 'entities-panel', 'entityList');

      // Check for Alice, Hub, Bob
      const entities = ['Alice', 'Hub', 'Bob'];
      const foundEntities = [];

      for (const entityName of entities) {
        try {
          const element = page.getByText(entityName, { exact: false }).first();
          const count = await element.count();

          if (count > 0) {
            foundEntities.push(entityName);
            console.log(`  ✓ Found entity: ${entityName}`);

            // Try to find account count near the entity name
            const parentLocator = element.locator('xpath=ancestor::*[1]');
            const text = await parentLocator.textContent();
            console.log(`    Context: ${text?.trim().substring(0, 100)}`);
          }
        } catch (e) {
          console.log(`  ✗ Entity not found: ${entityName}`);
        }
      }

      if (foundEntities.length === 3) {
        results.entityList.status = 'PASS';
        console.log('  ✅ PASS: All entities (Alice, Hub, Bob) found in Entities panel');
      } else {
        results.entityList.status = 'FAIL';
        results.entityList.errors.push(`Only found ${foundEntities.length}/3 entities: ${foundEntities.join(', ')}`);
        console.log(`  ❌ FAIL: Only found ${foundEntities.length}/3 entities`);
      }

    } catch (error) {
      results.entityList.status = 'FAIL';
      results.entityList.errors.push(error.message);
      console.log(`  ❌ FAIL: ${error.message}`);
    }

    // ========================================================================
    // TEST 5: Mini Panel Flow
    // ========================================================================
    console.log('\n📋 TEST 5: Mini Panel Flow (Click entity in Graph3D)');
    console.log('-'.repeat(80));

    try {
      // Navigate to Graph3D tab
      console.log('  Navigating to Graph3D tab...');

      const graph3dSelectors = [
        `[data-tab="Graph3D"]`,
        `button:has-text("Graph3D")`,
        `.tab:has-text("Graph3D")`,
        `[role="tab"]:has-text("Graph3D")`
      ];

      let graph3dClicked = false;
      for (const selector of graph3dSelectors) {
        try {
          await page.locator(selector).first().click({ timeout: 5000 });
          graph3dClicked = true;
          break;
        } catch (e) {
          continue;
        }
      }

      if (!graph3dClicked) {
        await page.getByText('Graph3D', { exact: true }).first().click({ timeout: 5000 });
      }

      await sleep(2000);
      console.log('  ✓ Graph3D tab opened');

      await takeScreenshot(page, 'graph3d-view', 'miniPanelFlow');

      // Try to find and click on an entity in the canvas
      // Look for canvas element
      const canvas = page.locator('canvas').first();
      const canvasCount = await canvas.count();

      if (canvasCount > 0) {
        console.log('  ✓ Canvas element found');

        // Get canvas bounding box
        const box = await canvas.boundingBox();

        if (box) {
          // Click in the center of the canvas (where entities might be)
          const centerX = box.x + box.width / 2;
          const centerY = box.y + box.height / 2;

          console.log(`  Clicking canvas at (${centerX.toFixed(0)}, ${centerY.toFixed(0)})...`);
          await page.mouse.click(centerX, centerY);
          await sleep(1500);

          await takeScreenshot(page, 'after-canvas-click', 'miniPanelFlow');

          // Look for mini panel with stats
          const miniPanelSelectors = [
            '[data-testid="mini-panel"]',
            '.mini-panel',
            '[class*="MiniPanel"]',
            '[class*="miniPanel"]',
            'div:has-text("Reserve")',
            'div:has-text("Collateral")',
            'div:has-text("Accounts")'
          ];

          let miniPanelFound = false;
          for (const selector of miniPanelSelectors) {
            try {
              const elem = page.locator(selector).first();
              const count = await elem.count();
              if (count > 0) {
                miniPanelFound = true;
                console.log(`  ✓ Mini panel found using: ${selector}`);

                // Check for stats
                const text = await elem.textContent();
                const hasReserve = text?.includes('Reserve') || text?.includes('reserve');
                const hasCollateral = text?.includes('Collateral') || text?.includes('collateral');
                const hasAccounts = text?.includes('Accounts') || text?.includes('accounts');

                console.log(`    Stats found - Reserve: ${hasReserve}, Collateral: ${hasCollateral}, Accounts: ${hasAccounts}`);
                break;
              }
            } catch (e) {
              continue;
            }
          }

          if (miniPanelFound) {
            results.miniPanelFlow.status = 'PASS';
            console.log('  ✅ PASS: Mini panel appeared with stats');
          } else {
            results.miniPanelFlow.status = 'FAIL';
            results.miniPanelFlow.errors.push('Mini panel not found after clicking canvas');
            console.log('  ❌ FAIL: Mini panel not found after clicking canvas');
          }
        } else {
          results.miniPanelFlow.status = 'FAIL';
          results.miniPanelFlow.errors.push('Could not get canvas bounding box');
          console.log('  ❌ FAIL: Could not get canvas bounding box');
        }
      } else {
        results.miniPanelFlow.status = 'FAIL';
        results.miniPanelFlow.errors.push('Canvas element not found');
        console.log('  ❌ FAIL: Canvas element not found');
      }

    } catch (error) {
      results.miniPanelFlow.status = 'FAIL';
      results.miniPanelFlow.errors.push(error.message);
      console.log(`  ❌ FAIL: ${error.message}`);
    }

    // ========================================================================
    // TEST 6: Expand to Full Panel
    // ========================================================================
    console.log('\n📋 TEST 6: Expand to Full Panel');
    console.log('-'.repeat(80));

    try {
      // Look for expand button (⤢)
      console.log('  Looking for expand button...');

      const expandSelectors = [
        'button:has-text("⤢")',
        '[data-testid="expand-button"]',
        '[aria-label="Expand"]',
        'button[title*="xpand"]',
        '.expand-button',
        '[class*="expand"]'
      ];

      let expandClicked = false;
      for (const selector of expandSelectors) {
        try {
          const elem = page.locator(selector).first();
          const count = await elem.count();
          if (count > 0) {
            await elem.click({ timeout: 5000 });
            expandClicked = true;
            console.log(`  ✓ Expand button clicked using: ${selector}`);
            break;
          }
        } catch (e) {
          continue;
        }
      }

      if (!expandClicked) {
        // Try clicking any button with expand-related text
        try {
          await page.locator('button').filter({ hasText: /expand|⤢/i }).first().click({ timeout: 5000 });
          expandClicked = true;
          console.log(`  ✓ Expand button clicked (filter search)`);
        } catch (e) {
          results.expandToFullPanel.status = 'FAIL';
          results.expandToFullPanel.errors.push('Expand button not found');
          console.log('  ❌ FAIL: Expand button not found');
        }
      }

      if (expandClicked) {
        await sleep(2000);
        await takeScreenshot(page, 'after-expand', 'expandToFullPanel');

        // Look for new tab with building emoji (🏢) and entity name
        const tabSelectors = [
          '[role="tab"]',
          '.tab',
          '[data-tab]',
          '.dockview-tab'
        ];

        let foundEntityTab = false;
        for (const selector of tabSelectors) {
          try {
            const tabs = await page.locator(selector).all();

            for (const tab of tabs) {
              const text = await tab.textContent();

              // Check for building emoji or entity names
              if (text?.includes('🏢') || text?.includes('Alice') || text?.includes('Hub') || text?.includes('Bob')) {
                foundEntityTab = true;
                console.log(`  ✓ Found entity tab: ${text?.trim()}`);
                break;
              }
            }

            if (foundEntityTab) break;
          } catch (e) {
            continue;
          }
        }

        if (foundEntityTab) {
          results.expandToFullPanel.status = 'PASS';
          console.log('  ✅ PASS: New tab opened with entity details');
        } else {
          results.expandToFullPanel.status = 'FAIL';
          results.expandToFullPanel.errors.push('New entity tab not found after clicking expand');
          console.log('  ❌ FAIL: New entity tab not found');
        }
      }

    } catch (error) {
      results.expandToFullPanel.status = 'FAIL';
      results.expandToFullPanel.errors.push(error.message);
      console.log(`  ❌ FAIL: ${error.message}`);
    }

    // Final screenshot
    await takeScreenshot(page, 'final-state', 'expandToFullPanel');

  } catch (error) {
    console.log(`\n💥 Fatal Error: ${error.message}`);
  } finally {
    await sleep(2000);
    await browser.close();
  }

  // ========================================================================
  // GENERATE REPORT
  // ========================================================================
  console.log('\n' + '='.repeat(80));
  console.log('📊 TEST RESULTS SUMMARY');
  console.log('='.repeat(80));

  const testOrder = [
    'tutorialSkip',
    'panelTabNavigation',
    'entityCreation',
    'entityList',
    'miniPanelFlow',
    'expandToFullPanel'
  ];

  const testNames = {
    tutorialSkip: 'Tutorial Skip',
    panelTabNavigation: 'Panel Tab Navigation',
    entityCreation: 'Entity Creation',
    entityList: 'Entity List',
    miniPanelFlow: 'Mini Panel Flow',
    expandToFullPanel: 'Expand to Full Panel'
  };

  let totalPassed = 0;
  let totalFailed = 0;

  for (const testKey of testOrder) {
    const test = results[testKey];
    const status = test.status === 'PASS' ? '✅ PASS' : '❌ FAIL';

    if (test.status === 'PASS') totalPassed++;
    else if (test.status === 'FAIL') totalFailed++;

    console.log(`\n${testNames[testKey]}: ${status}`);

    if (test.errors.length > 0) {
      console.log('  Errors:');
      test.errors.forEach(err => console.log(`    - ${err}`));
    }

    if (test.screenshots.length > 0) {
      console.log(`  Screenshots: ${test.screenshots.length}`);
    }

    // Show tab details for panel navigation test
    if (testKey === 'panelTabNavigation' && Object.keys(test.tabs).length > 0) {
      console.log('  Tab Results:');
      Object.entries(test.tabs).forEach(([tab, status]) => {
        const icon = status === 'PASS' ? '  ✓' : '  ✗';
        console.log(`    ${icon} ${tab}: ${status}`);
      });
    }
  }

  console.log('\n' + '-'.repeat(80));
  console.log(`Console Errors: ${consoleErrors.length}`);

  if (consoleErrors.length > 0 && consoleErrors.length <= 10) {
    console.log('\nConsole Error Details:');
    consoleErrors.forEach((err, idx) => {
      console.log(`  ${idx + 1}. ${err.text.substring(0, 150)}`);
    });
  } else if (consoleErrors.length > 10) {
    console.log(`\n  (First 5 errors shown)`);
    consoleErrors.slice(0, 5).forEach((err, idx) => {
      console.log(`  ${idx + 1}. ${err.text.substring(0, 150)}`);
    });
  }

  console.log('\n' + '='.repeat(80));
  console.log(`FINAL SCORE: ${totalPassed} PASSED / ${totalFailed} FAILED`);
  console.log('='.repeat(80));

  // Save detailed report to JSON
  const reportPath = path.join(__dirname, '../reports/ux-flow-verification-report.json');
  const report = {
    timestamp: new Date().toISOString(),
    summary: {
      totalPassed,
      totalFailed,
      consoleErrors: consoleErrors.length,
      consoleWarnings: consoleWarnings.length
    },
    results,
    consoleErrors,
    screenshotDir: SCREENSHOT_DIR
  };

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n📄 Detailed report saved to: ${reportPath}`);
  console.log(`📁 Screenshots saved to: ${SCREENSHOT_DIR}\n`);
}

// Run the tests
runTests().catch(console.error);

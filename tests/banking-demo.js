/**
 * XLN Banking Demo - Step-by-step R2R and R2C walkthrough
 *
 * Run with: node tests/banking-demo.js
 *
 * This demo runs in headed mode (visible browser) and explains
 * each operation like you're a banker learning the system.
 */

import { chromium } from 'playwright';

// Demo configuration
const SLOW_MO = 300;
const SUBTITLE_DURATION = 2500;

async function showSubtitle(page, text, duration = SUBTITLE_DURATION) {
  console.log(`📺 ${text}`);
  await page.evaluate((msg) => {
    const existing = document.getElementById('demo-subtitle');
    if (existing) existing.remove();

    const subtitle = document.createElement('div');
    subtitle.id = 'demo-subtitle';
    subtitle.style.cssText = `
      position: fixed;
      bottom: 100px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(0, 0, 0, 0.95);
      color: #00ff88;
      padding: 16px 32px;
      border-radius: 8px;
      font-family: 'SF Mono', monospace;
      font-size: 16px;
      z-index: 99999;
      max-width: 85%;
      text-align: center;
      border: 2px solid #00ff88;
      box-shadow: 0 4px 30px rgba(0, 255, 136, 0.4);
    `;
    subtitle.innerText = msg;
    document.body.appendChild(subtitle);
  }, text);
  await page.waitForTimeout(duration);
}

async function runDemo() {
  console.log('\n🏦 XLN BANKING DEMO - R2R & R2C Explained');
  console.log('==========================================\n');

  const browser = await chromium.launch({
    headless: false,
    slowMo: SLOW_MO
  });

  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

  try {
    // ═══════════════════════════════════════════════════════════════
    // SCENE 1: Welcome
    // ═══════════════════════════════════════════════════════════════
    console.log('\n🎬 Scene 1: Introduction');
    await page.goto('http://localhost:8080/view', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);

    // Dismiss tutorial
    await page.evaluate(() => {
      const overlay = document.querySelector('.tutorial-overlay');
      if (overlay) overlay.remove();
    });
    await page.waitForTimeout(500);

    await showSubtitle(page, '🏦 XLN BANKING DEMO', 2000);
    await showSubtitle(page, 'Learn TWO core operations:');
    await showSubtitle(page, '1️⃣ R2R = Reserve-to-Reserve (like Fedwire)');
    await showSubtitle(page, '2️⃣ R2C = Reserve-to-Collateral (lock funds for credit lines)');

    // ═══════════════════════════════════════════════════════════════
    // SCENE 2: Create Jurisdiction
    // ═══════════════════════════════════════════════════════════════
    console.log('\n🎬 Scene 2: Creating Jurisdiction');
    await showSubtitle(page, '📍 STEP 1: Create a JURISDICTION');
    await showSubtitle(page, 'A Jurisdiction = Country + Depository (like a central bank)');

    await page.click('button:has-text("Create Jurisdiction Here")').catch(() => {});
    await page.waitForTimeout(800);

    await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button')];
      const createBtn = buttons.find(b => b.textContent.trim() === 'Create');
      if (createBtn) createBtn.click();
    });
    await page.waitForTimeout(3500);

    await showSubtitle(page, '✅ Jurisdiction + Depository deployed (BrowserVM)');

    // ═══════════════════════════════════════════════════════════════
    // SCENE 3: Select Banking Scenario
    // ═══════════════════════════════════════════════════════════════
    console.log('\n🎬 Scene 3: Select Banking Scenario');
    await showSubtitle(page, '🏢 STEP 2: Create ENTITIES (Banks)');

    // Click Architect tab
    await page.click('text=Architect').catch(() => {});
    await page.waitForTimeout(500);

    // Click Build section
    await page.click('button:has-text("Build")').catch(() => {});
    await page.waitForTimeout(500);

    await showSubtitle(page, 'Entities = Banks that hold reserves and transact');

    // Select Starter scenario (9 entities: 1 Fed + 4 Clearing + 4 Community)
    await page.click('text=Starter Banking').catch(async () => {
      // Try clicking on any scenario dropdown
      await page.click('select').catch(() => {});
    });
    await page.waitForTimeout(500);

    // Click "Create Entities" or run scenario
    await page.click('button:has-text("Create Entities"), button:has-text("Run Scenario")').catch(async () => {
      // Click play button in scenario
      await page.click('button:has-text("▶")').catch(() => {});
    });
    await page.waitForTimeout(4000);

    await showSubtitle(page, '✅ Banking system created! Watch the 3D visualization...');
    await page.waitForTimeout(2000);

    // ═══════════════════════════════════════════════════════════════
    // SCENE 4: Fund Reserves
    // ═══════════════════════════════════════════════════════════════
    console.log('\n🎬 Scene 4: Funding Reserves');
    await showSubtitle(page, '💵 STEP 3: FUND RESERVES');
    await showSubtitle(page, 'Reserves = Liquid funds in the Depository (on-chain)');
    await showSubtitle(page, 'Think: Federal Reserve → Bank Reserve Accounts');

    // Click "Step 2: Fund All" button
    await page.click('button:has-text("Fund All")').catch(async () => {
      await page.click('button:has-text("Step 2")').catch(() => {});
    });
    await page.waitForTimeout(3000);

    await showSubtitle(page, '💰 WATCH: Spheres GROW as reserves increase!');
    await page.waitForTimeout(2000);
    await showSubtitle(page, 'Bigger sphere = More reserves = More capital');

    // ═══════════════════════════════════════════════════════════════
    // SCENE 5: R2R Explanation
    // ═══════════════════════════════════════════════════════════════
    console.log('\n🎬 Scene 5: R2R Transfer');
    await showSubtitle(page, '📤 STEP 4: R2R (Reserve-to-Reserve)');
    await showSubtitle(page, 'R2R = Direct transfer of reserves between entities');
    await showSubtitle(page, 'Like Fedwire: Instant, final, no middleman');

    // Click "Step 3: Send R2R" button
    await page.click('button:has-text("R2R"), button:has-text("Step 3")').catch(() => {});
    await page.waitForTimeout(3000);

    await showSubtitle(page, '⚡ WATCH: One sphere shrinks, another grows');
    await page.waitForTimeout(2000);

    await showSubtitle(page, '🔑 R2R KEY POINTS:');
    await showSubtitle(page, '• Atomic: Either both sides update or neither');
    await showSubtitle(page, '• Final: Cannot be reversed (like real-time settlement)');
    await showSubtitle(page, '• On-chain: Recorded in Depository smart contract');

    // ═══════════════════════════════════════════════════════════════
    // SCENE 6: R2C Explanation
    // ═══════════════════════════════════════════════════════════════
    console.log('\n🎬 Scene 6: R2C (Reserve-to-Collateral)');
    await showSubtitle(page, '🔒 STEP 5: R2C (Reserve-to-Collateral)');
    await showSubtitle(page, 'R2C = Lock reserves as collateral for a BILATERAL ACCOUNT');

    await showSubtitle(page, '💡 WHY R2C?');
    await showSubtitle(page, 'Reserves: GLOBAL (anyone can receive)');
    await showSubtitle(page, 'Collateral: SPECIFIC to ONE counterparty');

    await showSubtitle(page, '📊 BANKING ANALOGY:');
    await showSubtitle(page, 'R2C = Depositing margin at a clearinghouse');
    await showSubtitle(page, 'Creates a CREDIT LINE between two entities');

    await showSubtitle(page, '🔗 Connection lines = Bilateral accounts');
    await showSubtitle(page, 'Collateral enables OFF-CHAIN payments!');

    // ═══════════════════════════════════════════════════════════════
    // SCENE 7: Depository View
    // ═══════════════════════════════════════════════════════════════
    console.log('\n🎬 Scene 7: Depository Panel');
    await page.click('text=Depository').catch(() => {});
    await page.waitForTimeout(500);

    await showSubtitle(page, '📊 DEPOSITORY PANEL');
    await showSubtitle(page, 'Shows all on-chain state:');
    await showSubtitle(page, '• Reserves: Liquid funds per entity');
    await showSubtitle(page, '• Collateral: Locked funds per account pair');
    await showSubtitle(page, '• Debts: Outstanding obligations');

    await page.click('button:has-text("Refresh")').catch(() => {});
    await page.waitForTimeout(2000);

    // ═══════════════════════════════════════════════════════════════
    // SCENE 8: Summary
    // ═══════════════════════════════════════════════════════════════
    console.log('\n🎬 Scene 8: Summary');
    await showSubtitle(page, '🎓 SUMMARY', 3000);
    await showSubtitle(page, '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    await showSubtitle(page, 'R2R: Reserve → Reserve');
    await showSubtitle(page, '  → Direct transfer (like Fedwire)');
    await showSubtitle(page, '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    await showSubtitle(page, 'R2C: Reserve → Collateral');
    await showSubtitle(page, '  → Lock funds for bilateral account');
    await showSubtitle(page, '  → Enables off-chain payments');
    await showSubtitle(page, '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    await showSubtitle(page, '🏦 You now understand XLN banking!', 4000);

    console.log('\n✅ Demo complete! Browser stays open for 2 minutes.');
    console.log('Press Ctrl+C to close early.\n');

    await page.waitForTimeout(120000);

  } catch (err) {
    console.error('Demo error:', err);
  } finally {
    await browser.close();
  }
}

runDemo();

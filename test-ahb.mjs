import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1920, height: 1080 }
});
const page = await context.newPage();

const logs = [];
page.on('console', msg => {
  logs.push('[' + msg.type() + '] ' + msg.text());
});
page.on('pageerror', err => logs.push('[PAGEERROR] ' + err.message));

try {
  const url = 'https://localhost:8080/view?nocache=' + Date.now();
  console.log('Loading:', url);

  await page.goto(url, {
    waitUntil: 'networkidle',
    timeout: 30000
  });

  console.log('Page loaded, waiting for init...');
  await page.waitForTimeout(3000);

  // Click AHB button
  const ahb = page.locator('button:has-text("Alice-Hub-Bob")').first();
  const ahbVisible = await ahb.isVisible().catch(() => false);
  console.log('AHB button visible:', ahbVisible);

  if (ahbVisible) {
    logs.length = 0;
    console.log('Clicking AHB...');
    await ahb.click();
    await page.waitForTimeout(8000);

    // Show logs related to AHB, Graph3D, J-Machine
    const relevantLogs = logs.filter(l =>
      l.includes('AHB') ||
      l.includes('J-Machine') ||
      l.includes('jurisdiction') ||
      l.includes('Creating') ||
      l.includes('prepopulate') ||
      l.includes('Architect') ||
      l.includes('Error') ||
      l.includes('error')
    );

    console.log('\n=== RELEVANT LOGS ===');
    relevantLogs.forEach(l => console.log(l));

    // Check result
    const result = await page.evaluate(() => {
      const env = window.xlnEnv;
      return {
        hasEnv: !!env,
        entities: env?.eReplicas?.size || 0,
        jurisdictions: env?.jReplicas?.size || 0,
        history: env?.history?.length || 0,
        activeJurisdiction: env?.activeJurisdiction || null
      };
    });
    console.log('\n=== RESULT ===');
    console.log('Entities:', result.entities);
    console.log('Jurisdictions:', result.jurisdictions);
    console.log('History frames:', result.history);
    console.log('Active jurisdiction:', result.activeJurisdiction);

    if (result.entities === 0) {
      console.log('\n❌ FAIL: No entities created');
    } else if (result.jurisdictions === 0) {
      console.log('\n❌ FAIL: No J-machine created');
    } else {
      console.log('\n✅ SUCCESS: AHB demo working!');
    }
  } else {
    console.log('AHB button not visible');
  }

} catch (e) {
  console.log('FAIL:', e.message);
  console.log(e.stack);
}

await browser.close();

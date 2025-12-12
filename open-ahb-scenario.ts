#!/usr/bin/env bun
import { chromium } from 'playwright';

const browser = await chromium.launch({
  headless: false,
  slowMo: 500,
  args: ['--ignore-certificate-errors', '--start-maximized']
});

const page = await browser.newPage({ ignoreHTTPSErrors: true });

// Capture EVERYTHING
page.on('console', msg => {
  console.log(`[BROWSER] ${msg.text()}`);
});

page.on('pageerror', err => {
  console.error(`[PAGE ERROR] ${err.message}`);
});

console.log('🚀 Opening https://localhost:8080/view?scenario=ahb\n');

await page.goto('https://localhost:8080/view?scenario=ahb', {
  waitUntil: 'networkidle',
  timeout: 30000
});

console.log('✅ Page loaded');
console.log('⏳ Waiting 30s for AHB to auto-load...\n');

await page.waitForTimeout(30000);

const state = await page.evaluate(() => {
  const env = (window as any).xlnEnv;
  return {
    hasEnv: !!env,
    historyLen: env?.history?.length || 0,
    replicasCount: env?.eReplicas?.size || 0,
  };
});

console.log('\n📊 State after 30s:', state);

if (state.historyLen > 0) {
  console.log('\n✅ AHB LOADED! Checking Bob-Hub account...');

  const bobAccount = await page.evaluate(() => {
    const env = (window as any).xlnEnv;
    const lastFrame = env.history[env.history.length - 1];
    const bobRep = Array.from(lastFrame.eReplicas.values()).find((r: any) =>
      r.state?.entityId?.endsWith('0003')
    );
    const hubId = '0x' + '0'.repeat(63) + '2';
    const acc = bobRep?.state?.accounts?.get(hubId);
    const delta = acc?.deltas?.get(1);

    return {
      rightCredit: delta?.rightCreditLimit?.toString(),
    };
  });

  console.log('Bob-Hub rightCreditLimit:', bobAccount.rightCredit);

  if (bobAccount.rightCredit && bobAccount.rightCredit !== '0') {
    console.log('\n✅ ✅ ✅ FIXED! Bob has credit!');
  } else {
    console.log('\n❌ ❌ ❌ NO CREDIT!');
  }
} else {
  console.log('\n❌ AHB did not load');
}

console.log('\n⏸️  Browser staying open. Press Ctrl+C to close.\n');
await new Promise(() => {});

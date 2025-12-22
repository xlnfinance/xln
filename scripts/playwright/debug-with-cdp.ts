#!/usr/bin/env bun
import { chromium } from 'playwright';

const browser = await chromium.launch({
  headless: false,
  channel: 'chrome', // Use real Chrome instead of Chromium
  args: ['--ignore-certificate-errors']
});

const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1920, height: 1200 } });
const page = await context.newPage();

// CDP Session for deep console access
const client = await context.newCDPSession(page);
await client.send('Runtime.enable');
await client.send('Console.enable');
await client.send('Log.enable');

client.on('Runtime.consoleAPICalled', (event: any) => {
  const args = event.args.map((arg: any) => arg.value || arg.description || '').join(' ');
  console.log(`[CDP] ${args}`);
});

client.on('Runtime.exceptionThrown', (event: any) => {
  console.error(`[CDP EXCEPTION] ${event.exceptionDetails.exception.description}`);
  console.error(`  at ${event.exceptionDetails.url}:${event.exceptionDetails.lineNumber}`);
});

page.on('console', msg => {
  console.log(`[CONSOLE] ${msg.text()}`);
});

page.on('pageerror', err => {
  console.error(`[ERROR] ${err.message}`);
});

console.log('🌐 Opening https://localhost:8080/view?scenario=ahb');
console.log('📱 Viewport: 1920x1200');
console.log('🔍 CDP enabled - will see ALL console & exceptions\n');

await page.goto('https://localhost:8080/view?scenario=ahb', { timeout: 30000 });

console.log('\n⏳ Waiting 20s for auto-load...\n');
await page.waitForTimeout(20000);

const finalState = await page.evaluate(() => {
  const env = (window as any).xlnEnv;
  const timeMachine = document.querySelector('.time-machine-bar');
  const viewComponent = document.querySelector('[class*="view"]');

  return {
    xlnEnv: !!env,
    history: env?.history?.length || 0,
    replicas: env?.eReplicas?.size || 0,
    timeMachineExists: !!timeMachine,
    timeMachineVisible: timeMachine ? window.getComputedStyle(timeMachine).display !== 'none' : false,
    viewComponentExists: !!viewComponent,
    bodyChildren: document.body.children.length,
  };
});

console.log('\n📊 FINAL STATE:', finalState);

if (finalState.history > 0) {
  console.log('✅ AHB LOADED!');
} else {
  console.log('❌ AHB FAILED TO LOAD');
  console.log('   TimeMachine in DOM:', finalState.timeMachineExists);
  console.log('   TimeMachine visible:', finalState.timeMachineVisible);
}

console.log('\n⏸️  Browser open. Check your screen.\n');
await new Promise(() => {});

#!/usr/bin/env bun
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true, args: ['--ignore-certificate-errors'] });
const page = await browser.newContext({ ignoreHTTPSErrors: true }).then(c => c.newPage());

const logs: string[] = [];
page.on('console', msg => {
  const text = msg.text();
  logs.push(text);
  // Capture all relevant logs
  if (text.includes('PAYMENT') || text.includes('PENDING-FORWARD') || text.includes('SANITY') ||
      text.includes('AHB') || text.includes('ERROR') || text.includes('BILATERAL-STATE') ||
      text.includes('BAR-VISUAL') || text.includes('Multi-hop')) {
    console.log(text);
  }
});

console.log('Opening https://localhost:8080/view...');
await page.goto('https://localhost:8080/view', { timeout: 20000 });

console.log('Waiting for AHB auto-load...');
await page.waitForTimeout(25000);

const paymentLogs = logs.filter(l =>
  l.includes('PAYMENT SUCCESS') ||
  l.includes('PAYMENT FAILED') ||
  l.includes('H-B NOT FORWARDED')
);

console.log('\n=== PAYMENT RESULT ===');
paymentLogs.forEach(l => console.log(l));

if (paymentLogs.some(l => l.includes('SUCCESS'))) {
  console.log('\n✅ ✅ ✅ PAYMENT WORKS!');
  process.exit(0);
} else {
  console.log('\n❌ ❌ ❌ PAYMENT BROKEN!');
  process.exit(1);
}

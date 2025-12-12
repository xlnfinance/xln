#!/usr/bin/env bun
import { chromium } from 'playwright';

const browser = await chromium.launch({
  headless: false,
  args: ['--ignore-certificate-errors']
});

const page = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1920, height: 1200 } }).then(c => c.newPage());

console.log('Opening https://localhost:8080/view?scenario=ahb\n');
await page.goto('https://localhost:8080/view?scenario=ahb', { timeout: 30000 });

await page.waitForTimeout(10000);

const domCheck = await page.evaluate(() => {
  const tm = document.querySelector('.time-machine-bar');
  const view = document.querySelector('.view-wrapper');
  const body = document.body;

  return {
    timeMachine: {
      exists: !!tm,
      className: tm?.className,
      style: tm ? window.getComputedStyle(tm).cssText : 'N/A',
      position: tm?.getAttribute('data-position'),
      offsetHeight: tm?.offsetHeight,
      offsetTop: tm?.offsetTop,
    },
    viewWrapper: {
      exists: !!view,
      offsetHeight: view?.offsetHeight,
      scrollHeight: view?.scrollHeight,
    },
    body: {
      offsetHeight: body.offsetHeight,
      scrollHeight: body.scrollHeight,
      childCount: body.children.length,
    },
    xlnEnv: {
      windowHas: 'xlnEnv' in window,
      type: typeof (window as any).xlnEnv,
      isStore: typeof (window as any).xlnEnv?.subscribe === 'function',
      keys: (window as any).xlnEnv ? Object.keys((window as any).xlnEnv).slice(0, 15) : [],
    }
  };
});

console.log('\n📊 DOM CHECK:');
console.log(JSON.stringify(domCheck, null, 2));

console.log('\n⏸️  Browser open - check screen\n');
await new Promise(() => {});

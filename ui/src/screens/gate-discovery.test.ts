import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chromium, type Browser } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';

let browser: Browser;
let ui: ViteDevServer;
let api: ReturnType<typeof Bun.serve>;
let origin: string;
let status = 503;
let requests = 0;

beforeAll(async () => {
  api = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      requests += 1;
      return Response.json({ jurisdictions: {} }, { status });
    },
  });
  ui = await createServer({
    configFile: new URL('../../vite.config.ts', import.meta.url).pathname,
    root: new URL('../..', import.meta.url).pathname,
    server: { host: '127.0.0.1', port: 0, strictPort: false, proxy: { '/api': { target: api.url.origin } } },
  });
  await ui.listen();
  origin = ui.resolvedUrls!.local[0]!;
  browser = await chromium.launch({ headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await ui?.close();
  await api?.stop(true);
});

test('Gate ends failed discovery, shows the actual error and offers a retry', async () => {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(origin);
    await page.getByRole('alert').filter({ hasText: 'HTTP 503' }).waitFor({ timeout: 10_000 });
    expect(await page.getByTestId('gate-stack').getAttribute('data-state')).toBe('error');
    expect(await page.getByTestId('gate-stack').textContent()).not.toContain('Looking for');
    // The real app mounts under React StrictMode, which probes twice in development.
    expect(requests).toBeGreaterThanOrEqual(1);
    const initialRequests = requests;
    status = 502;
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'HTTP 502' }).waitFor();
    expect(requests).toBe(initialRequests + 1);
    status = 200;
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="gate-stack"]')?.getAttribute('data-state') === 'offline');
    expect(await page.getByRole('alert').count()).toBe(0);
    expect(await page.getByRole('button', { name: 'Retry', exact: true }).count()).toBe(0);
    expect(requests).toBe(initialRequests + 2);
    expect(errors).toEqual([]);
    await page.screenshot({ path: '/tmp/xln-dry2-gate-discovery.png' });
  } finally {
    await page.close();
  }
}, 30_000);

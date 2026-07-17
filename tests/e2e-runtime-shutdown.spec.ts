import { createServer, type Server } from 'node:http';
import { test, expect } from './global-setup';

let probeServer: Server;
let probeUrl = '';

test.beforeAll(async () => {
  probeServer = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>runtime shutdown probe</title>');
  });
  await new Promise<void>((resolve, reject) => {
    probeServer.once('error', reject);
    probeServer.listen(0, '127.0.0.1', resolve);
  });
  const address = probeServer.address();
  if (!address || typeof address === 'string') throw new Error('E2E_SHUTDOWN_PROBE_ADDRESS_INVALID');
  probeUrl = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    probeServer.close((error) => error ? reject(error) : resolve());
  });
});

test('manual BrowserContext close quiesces every runtime page first', { tag: '@resilience' }, async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  let quiesceCalls = 0;
  await page.exposeFunction('recordRuntimeQuiesce', () => {
    quiesceCalls += 1;
  });
  await page.goto(probeUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    const target = window as typeof window & {
      isolatedEnv?: object;
      __xln?: {
        vault?: {
          suspendAllRuntimeActivity?: () => Promise<void>;
        };
      };
      recordRuntimeQuiesce?: () => Promise<void>;
    };
    target.isolatedEnv = {};
    target.__xln = {
      vault: {
        suspendAllRuntimeActivity: async () => {
          if (!target.recordRuntimeQuiesce) throw new Error('E2E_SHUTDOWN_PROBE_BINDING_MISSING');
          await target.recordRuntimeQuiesce();
        },
      },
    };
  });

  await context.close();

  expect(quiesceCalls).toBe(1);
});

test('manual Page close quiesces its runtime before the page disappears', { tag: '@resilience' }, async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  let quiesceCalls = 0;
  await page.exposeFunction('recordRuntimeQuiesce', () => {
    quiesceCalls += 1;
  });
  await page.goto(probeUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    const target = window as typeof window & {
      isolatedEnv?: object;
      __xln?: {
        vault?: {
          suspendAllRuntimeActivity?: () => Promise<void>;
        };
      };
      recordRuntimeQuiesce?: () => Promise<void>;
    };
    target.isolatedEnv = {};
    target.__xln = {
      vault: {
        suspendAllRuntimeActivity: async () => {
          if (!target.recordRuntimeQuiesce) throw new Error('E2E_SHUTDOWN_PROBE_BINDING_MISSING');
          await target.recordRuntimeQuiesce();
        },
      },
    };
  });

  await page.close();
  await context.close();

  expect(quiesceCalls).toBe(1);
});

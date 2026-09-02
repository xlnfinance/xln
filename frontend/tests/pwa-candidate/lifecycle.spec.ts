import { createHash } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

type SmokeRelease = Readonly<{
  releaseId: string;
  cacheName: string;
  fileCount: number;
  serviceWorkerSha256: string;
  walletEntrySha256: string;
}>;

type SmokeState = Readonly<{
  activeReleaseId: string;
  releaseNetworkOnline: boolean;
  releases: readonly SmokeRelease[];
}>;

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

const postControl = async (page: Page, path: string, body: string): Promise<void> => {
  const result = await page.evaluate(async ({ requestPath, requestBody }) => {
    const response = await fetch(requestPath, { method: 'POST', body: requestBody });
    return { ok: response.ok, status: response.status, text: await response.text() };
  }, { requestPath: path, requestBody: body });
  expect(result).toEqual(expect.objectContaining({ ok: true, status: 200 }));
};

const updateRegistration = async (page: Page): Promise<void> => {
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration('/');
    if (!registration?.active) throw new Error('PWA_TEST_ACTIVE_REGISTRATION_REQUIRED');
    const previous = registration.active;
    const changed = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('PWA_TEST_CONTROLLER_CHANGE_TIMEOUT')), 30_000);
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
    });
    await registration.update();
    if (navigator.serviceWorker.controller === previous) await changed;
    const controller = navigator.serviceWorker.controller;
    if (!controller) throw new Error('PWA_TEST_UPDATE_CONTROLLER_MISSING');
    if (controller.state !== 'activated') {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('PWA_TEST_ACTIVATION_TIMEOUT')), 30_000);
        controller.addEventListener('statechange', () => {
          if (controller.state === 'activated') {
            clearTimeout(timeout);
            resolve();
          } else if (controller.state === 'redundant') {
            clearTimeout(timeout);
            reject(new Error('PWA_TEST_UPDATE_REDUNDANT'));
          }
        });
      });
    }
  });
};

const rejectIncompleteUpdate = async (page: Page): Promise<void> => {
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration('/');
    const previous = navigator.serviceWorker.controller;
    if (!registration?.active || !previous) throw new Error('PWA_TEST_ACTIVE_REGISTRATION_REQUIRED');
    const updateFound = new Promise<ServiceWorker>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('PWA_TEST_REJECTED_UPDATE_NOT_FOUND')), 30_000);
      registration.addEventListener('updatefound', () => {
        clearTimeout(timeout);
        const installing = registration.installing;
        if (!installing) reject(new Error('PWA_TEST_REJECTED_UPDATE_INSTALLER_MISSING'));
        else resolve(installing);
      }, { once: true });
    });
    const [, installing] = await Promise.all([registration.update(), updateFound]);
    if (installing.state !== 'redundant') {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('PWA_TEST_REJECTED_UPDATE_TIMEOUT')), 30_000);
        installing.addEventListener('statechange', () => {
          if (installing.state === 'redundant') {
            clearTimeout(timeout);
            resolve();
          } else if (installing.state === 'activated') {
            clearTimeout(timeout);
            reject(new Error('PWA_TEST_INCOMPLETE_UPDATE_ACTIVATED'));
          }
        });
      });
    }
    if (navigator.serviceWorker.controller !== previous) throw new Error('PWA_TEST_CONTROLLER_CHANGED_ON_REJECTION');
  });
};

const fetchWallet = async (page: Page): Promise<Readonly<{ releaseId: string | null; html: string }>> =>
  page.evaluate(async () => {
    const response = await fetch(`/app?smoke=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`PWA_TEST_WALLET_FETCH_FAILED:${response.status}`);
    return { releaseId: response.headers.get('x-xln-pwa-release'), html: await response.text() };
  });

test('installs, updates, and rolls back exact release caches through one real service worker', async ({ page }) => {
  test.setTimeout(180_000);
  const consoleFailures: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') consoleFailures.push(message.text());
  });
  page.on('pageerror', (error) => consoleFailures.push(error.message));

  await page.goto('/__xln-pwa/harness');
  const state = await page.evaluate(async () => {
    const response = await fetch('/__xln-pwa/state');
    if (!response.ok) throw new Error(`PWA_TEST_STATE_FAILED:${response.status}`);
    return response.json() as Promise<SmokeState>;
  });
  expect(state.releases).toHaveLength(2);
  const install = state.releases[0];
  const update = state.releases[1];
  if (!install || !update) throw new Error('PWA_TEST_RELEASE_PAIR_REQUIRED');
  expect(state.activeReleaseId).toBe(install.releaseId);
  expect(state.releaseNetworkOnline).toBe(true);

  const registration = await page.evaluate(async () => {
    const controlled = navigator.serviceWorker.controller ? Promise.resolve() : new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('PWA_TEST_INITIAL_CONTROL_TIMEOUT')), 30_000);
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
    });
    const registered = await navigator.serviceWorker.register('/__xln-pwa-worker.js', { scope: '/' });
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await controlled;
    return { scope: registered.scope, controlled: navigator.serviceWorker.controller !== null };
  });
  expect(registration).toEqual({ scope: new URL('/', page.url()).href, controlled: true });

  await postControl(page, '/__xln-pwa/release-network', 'offline');
  const installedWallet = await fetchWallet(page);
  expect(installedWallet.releaseId).toBe(install.releaseId);
  expect(sha256(installedWallet.html)).toBe(install.walletEntrySha256);

  await postControl(page, '/__xln-pwa/active', update.releaseId);
  await rejectIncompleteUpdate(page);
  expect(await page.evaluate(async () => globalThis.caches.keys())).toEqual([install.cacheName]);

  await postControl(page, '/__xln-pwa/release-network', 'online');
  await updateRegistration(page);
  await postControl(page, '/__xln-pwa/release-network', 'offline');
  const updatedWallet = await fetchWallet(page);
  expect(updatedWallet.releaseId).toBe(update.releaseId);
  expect(sha256(updatedWallet.html)).toBe(update.walletEntrySha256);

  await postControl(page, '/__xln-pwa/active', install.releaseId);
  await updateRegistration(page);
  const rolledBackWallet = await fetchWallet(page);
  expect(rolledBackWallet.releaseId).toBe(install.releaseId);
  expect(sha256(rolledBackWallet.html)).toBe(install.walletEntrySha256);

  const caches = await page.evaluate(async () => Promise.all((await globalThis.caches.keys()).sort().map(async (name) => ({
    name,
    count: (await (await globalThis.caches.open(name)).keys()).length,
  }))));
  expect(caches).toEqual([
    { name: install.cacheName, count: install.fileCount },
    { name: update.cacheName, count: update.fileCount },
  ].sort(({ name: left }, { name: right }) => left.localeCompare(right)));
  expect(consoleFailures).toEqual([]);
});

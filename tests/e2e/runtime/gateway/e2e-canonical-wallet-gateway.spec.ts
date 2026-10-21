import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { HDNodeWallet } from 'ethers';
import type { RuntimeReplica, XLNModule } from '../../../../core/api/public/runtime-module';
import { timedStep } from '../../../utils/e2e-timing.mts';
import { expect, test } from '../../../global-setup.mts';
import { gotoApp } from '../../../utils/e2e-demo-users';
import { createWalletIdentity, LOCAL_PASSWORD, waitForWalletBoot } from '../../../../ui/tests/wallet-ui';
import { readAccount, expectDeliveryDrained, type DebugWindow } from '../../../../ui/tests/swap-evidence';

test(
  'canonical gateway initializes React wallet and Account worker from exact current assets',
  { tag: '@functional' },
  async ({ page }, info) => {
    const runtimePath = process.env['E2E_RUNTIME_BUNDLE_PATH'];
    if (!runtimePath) throw new Error('E2E_RUNTIME_BUNDLE_PATH_REQUIRED');
    const workers: string[] = [];
    let relayFrames = 0;
    page.on('worker', worker => workers.push(new URL(worker.url()).pathname));
    page.on('websocket', socket => {
      if (new URL(socket.url()).pathname === '/relay') socket.on('framereceived', () => relayFrames++);
    });
    await gotoApp(page, { settleMs: 0 });
    await expect(page).toHaveURL(/\/ui\/$/);
    await expect(page.getByTestId('gate-stack')).toHaveAttribute('data-state', 'online');
    await gotoApp(page, { appBaseUrl: new URL(page.url()).origin, settleMs: 0 });
    const assets = [];
    for (const [url, file] of [
      ['/ui/runtime.js', 'runtime.js'],
      ['/account-worker.js', 'account-worker.js'],
    ]) {
      const response = await page.request.get(url);
      expect(response.status()).toBe(200);
      expect(response.headers()['content-type']).toMatch(/javascript/);
      const sha256 = createHash('sha256')
        .update(await response.body())
        .digest('hex');
      expect(sha256).toBe(
        createHash('sha256')
          .update(readFileSync(join(dirname(runtimePath), file)))
          .digest('hex'),
      );
      assets.push({ url, sha256 });
    }
    const phrase = HDNodeWallet.createRandom().mnemonic?.phrase;
    if (!phrase) throw new Error('TEST_WALLET_MNEMONIC_MISSING');
    await expect(page.getByTestId('gate-stack')).toHaveAttribute('data-state', 'online');
    await page.getByRole('button', { name: /Restore a wallet/ }).click();
    await page.locator('textarea').fill(phrase);
    await page.locator('button[type="submit"]').click();
    await expect(page.getByRole('heading', { name: 'Set a local password' })).toBeVisible();
    await page.getByLabel('Password', { exact: true }).fill(LOCAL_PASSWORD);
    await page.getByLabel('Confirm password', { exact: true }).fill(LOCAL_PASSWORD);
    await page.evaluate(() => {
      const started = performance.now();
      const stages: Array<{ elapsedMs: number; stage: string }> = [];
      const capture = () => {
        const stage =
          document.querySelector('button[type=submit]')?.textContent ??
          (document.querySelector('[data-testid=nav-home]') ? 'Home' : 'Opening');
        if (stages.at(-1)?.stage !== stage) stages.push({ elapsedMs: Math.round(performance.now() - started), stage });
      };
      new MutationObserver(capture).observe(document.body, { childList: true, subtree: true, characterData: true });
      (window as Window & { __gatewayBootStages?: typeof stages }).__gatewayBootStages = stages;
      capture();
    });
    await timedStep('gateway.save_and_open', async () => {
      await page.getByRole('button', { name: 'Save and open', exact: true }).click();
      try {
        await waitForWalletBoot(page);
        await expect(page.getByTestId('account-row').first()).toBeVisible();
      } finally {
        const state = await page.evaluate(async () => {
          const debug = (window as Window & { __xln: { env(): RuntimeReplica | null; xln(): Promise<XLNModule> } })
            .__xln;
          const env = debug.env();
          const xln = await debug.xln();
          return {
            stages: (window as Window & { __gatewayBootStages?: Array<{ elapsedMs: number; stage: string }> })
              .__gatewayBootStages,
            runtimeHeight: env?.state.height,
            halted: env?.infrastructure?.halted ?? false,
            relayConnected: env?.infrastructure?.p2p?.isConnected() ?? false,
            queuedRuntimeTxs: env?.runtimeMempool.runtimeTxs.map(tx => tx.type),
            queuedEntityInputs: env?.runtimeMempool.entityInputs.map(input => input.entityTxs?.map(tx => tx.type)),
            entities: env
              ? [...env.state.eReplicas.values()].map(replica => ({
                  entityId: replica.entityId,
                  height: replica.state.height,
                  pending: replica.mempool.map(tx => tx.type),
                  proposalHeight: replica.proposal?.height ?? null,
                  scan: xln.getEntityJAdapter(env, replica.entityId, replica.signerId)?.getWatcherScanProgress?.(),
                  accounts: [...replica.state.accounts.values()].map(account => ({
                    height: account.currentHeight,
                    pendingHeight: account.pendingFrame?.height ?? null,
                  })),
                }))
              : [],
          };
        });
        await info.attach('gateway-open-boundary', { body: JSON.stringify(state), contentType: 'application/json' });
        console.log('[E2E] gateway open boundary', JSON.stringify(state));
      }
    });
    await gotoApp(page, { appBaseUrl: new URL(page.url()).origin, settleMs: 0 });
    expect(workers).toContain('/account-worker.js');
    expect(relayFrames).toBeGreaterThan(1);
    await page.goto('/ui/manage');
    await page.reload();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await gotoApp(page, { appBaseUrl: new URL(page.url()).origin, settleMs: 0 });
    await expect(page).toHaveURL(/\/ui\/manage$/);
    await page.getByLabel('Password', { exact: true }).fill(LOCAL_PASSWORD);
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await expect(page.getByTestId('nav-manage').locator('visible=true')).toBeVisible();
    await info.attach('canonical-assets', {
      body: JSON.stringify({ assets, workers, relayFrames }),
      contentType: 'application/json',
    });
  },
);

test('wallet unlock uses the network discovered after Continue', { tag: '@resilience' }, async ({ page }, info) => {
  await gotoApp(page, { settleMs: 0 });
  const phrase = HDNodeWallet.createRandom().mnemonic?.phrase;
  if (!phrase) throw new Error('TEST_WALLET_MNEMONIC_MISSING');
  const identity = await createWalletIdentity(page, 'network-discovery', phrase);
  await page.getByTestId('home-faucet').click();
  await expect(page.getByTestId('test-money-status')).toHaveText('100 USDC received');
  await page.getByTestId('account-row').first().click();
  const hubId = new URL(page.url()).pathname.split('/accounts/')[1];
  if (!hubId || !/^0x[0-9a-f]{64}$/.test(hubId)) throw new Error('NETWORK_GATE_ACCOUNT_MISSING');
  await page.getByTestId('back').click();
  await expectDeliveryDrained(page, expect);
  const before = await readAccount(page, hubId);
  const origin = new URL(page.url()).origin;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  // Delay actual responses; no fabricated catalog, route handler or replacement wallet state.
  await cdp.send('Network.emulateNetworkConditionsByRule', {
    matchedNetworkConditions: [
      { urlPattern: `${origin}/api/*`, latency: 2000, downloadThroughput: -1, uploadThroughput: -1 },
    ],
  });
  try {
    const navigationStarted = Date.now();
    const detected = page.waitForResponse(
      response =>
        new URL(response.url()).pathname === '/api/hubs' &&
        response.status() === 200 &&
        response.request().timing().startTime >= navigationStarted,
    );
    await page.goto(`${origin}/ui/manage`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('gate-stack')).toHaveAttribute('data-state', 'probing');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Unlock wallet' })).toBeVisible();
    const response = await detected;
    await response.finished();
    await cdp.send('Network.emulateNetworkConditionsByRule', { matchedNetworkConditions: [] });
    await page.evaluate(
      () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
    await page.getByLabel('Password', { exact: true }).fill(LOCAL_PASSWORD);
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await page
      .locator('[data-testid="nav-home"]:visible, [role="alert"]')
      .first()
      .waitFor({ state: 'visible', timeout: 15000 });
    const alerts = await page.getByRole('alert').allTextContents();
    await info.attach('network-discovery-unlock', {
      body: JSON.stringify({ identity, before, response: response.url(), responseStatus: response.status(), alerts }),
      contentType: 'application/json',
    });
    expect(alerts).toEqual([]);
    await page.getByTestId('nav-home').locator('visible=true').first().click();
    await expect(page.getByTestId('home-entity-id')).toHaveText(identity.entityId);
    const runtimeId = await page.evaluate(() => {
      const debug = (window as DebugWindow).__xln;
      if (!debug) throw new Error('WALLET_DIAGNOSTICS_UNAVAILABLE');
      const adapter = debug.adapter();
      if (!adapter) throw new Error('WALLET_ADAPTER_UNAVAILABLE');
      return adapter.runtimeId;
    });
    expect(runtimeId).toBe(identity.runtimeId);
    expect(await readAccount(page, hubId)).toEqual(before);
    await page.screenshot({ path: info.outputPath('wallet-unlocked-after-network.png') });
  } finally {
    await cdp.send('Network.emulateNetworkConditionsByRule', { matchedNetworkConditions: [] });
    await cdp.detach();
  }
});

import { expect, test } from '../../global-setup.mts';

const QA_AUTH = { scope: 'admin', disabled: true, actorKeyId: 'fixture-auth-disabled' };

const HLT_FIXTURE = {
  ok: true,
  qaAuth: QA_AUTH,
  preview: {
    config: {
      users: 200,
      usersPerRuntime: 40,
      ratePerUserPerSecond: 1,
      durationSeconds: 10,
      mix: '0:1',
      hubs: 'H1',
      marketMakers: 'MM',
      mode: 'payments',
      profile: true,
    },
    daemons: 5,
    rounds: 10,
    cadenceMs: 1000,
    paymentLanes: 100,
    swapLanes: 0,
    offeredPayPerSecond: 100,
    offeredSwapPerSecond: 0,
    offeredOrderPerSecond: 200,
    hubShare: {
      hubCount: 1,
      evenSharePct: 100,
      workerSingleHubPct: 100,
      workerMultiHubPct: 0,
      routing: 'pin_first_hub',
      note: 'Payment and same-J workers pin hubLabels[0]. Extra labels describe mesh topology, not a traffic split.',
    },
    isolatedCommand: 'XLN_HLT_USERS=200 bun core/scripts/operations/production/local-prod-smoke.ts',
    warning: 'Smoke leases its own ports. It does not attach to the live hub-node on 8082.',
  },
  ledger: [
    {
      at: '2026-08-18T23:30:00Z',
      commit: '9a00c8cd6',
      headline: 'Batched hub-poll payments: 149/s at 200 users',
      detail: '1000/1000 in 6.7 s',
      users: 200,
      paymentsTps: 149.3,
      swapsTps: 0,
      status: 'green',
    },
  ],
  payment: {
    deliveredTps: 149.276,
    offeredRate: 100,
    deliveredPayments: 1000,
    elapsedMs: 6699,
    users: 200,
    senders: 100,
    hubFrames: 14,
    paymentsPerFrame: 71.4,
    walDeltaBytes: 16588085,
    heightBefore: 299,
    heightAfter: 313,
  },
  swap: null,
  perf: {
    parsedProfiles: 2,
    rows: [
      {
        runtime: 'H1',
        metric: 'runtime.process.total',
        count: 14,
        avgMs: 80,
        minMs: 40,
        p50Ms: 70,
        p95Ms: 120,
        p99Ms: 140,
        maxMs: 150,
        totalMs: 1120,
      },
      {
        runtime: 'H1',
        metric: 'entity.wireFit',
        count: 14,
        avgMs: 12,
        minMs: 8,
        p50Ms: 11,
        p95Ms: 18,
        p99Ms: 20,
        maxMs: 22,
        totalMs: 168,
      },
    ],
  },
  hubPerf: [
    {
      hubLabel: 'H1',
      processCount: 14,
      processAvgMs: 80,
      processTotalMs: 1120,
      cpuTps: 892.9,
    },
  ],
};

test('renders the configurable HLT dashboard across viewports', { tag: '@functional' }, async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  await page.route('**/api/qa/hlt**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(HLT_FIXTURE),
    });
  });

  await page.goto('/qa/hlt');
  const dashboard = page.getByTestId('hlt-dashboard');
  await expect(dashboard).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('hlt-users')).toHaveText('200');
  await expect(page.getByTestId('hlt-users-per-process')).toHaveText('40');
  await expect(page.getByTestId('hlt-daemons')).toHaveText('5');
  await expect(page.getByTestId('hlt-offered-pay')).toContainText('100');
  await expect(page.getByTestId('hlt-result-tps')).toContainText('149');
  await expect(page.getByTestId('hlt-result-frames')).toHaveText('14');
  await expect(page.getByTestId('hlt-perf-row')).toHaveCount(2);
  await expect(page.getByTestId('hlt-ledger-row').first()).toContainText('149');

  await page.getByTestId('hlt-users-input').evaluate((element) => {
    const input = element as HTMLInputElement;
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    descriptor?.set?.call(input, '64');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.getByTestId('hlt-users')).toHaveText('64');
  await expect(page.getByTestId('hlt-daemons')).toHaveText('2');
  await expect(page.getByTestId('hlt-offered-pay')).toContainText('32');

  for (const viewport of [
    { name: 'wide', width: 1600, height: 1000 },
    { name: 'laptop', width: 1280, height: 800 },
    { name: 'iphone', width: 393, height: 852 },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await expect(dashboard).toBeVisible();
    const bounds = await dashboard.boundingBox();
    expect(bounds, `${viewport.name} HLT dashboard must have layout bounds`).not.toBeNull();
    expect(bounds!.x, `${viewport.name} HLT dashboard must stay in the viewport`).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width, `${viewport.name} HLT dashboard must not overflow horizontally`)
      .toBeLessThanOrEqual(viewport.width + 1);
    await page.screenshot({
      path: testInfo.outputPath(`${viewport.name}-qa-hlt.png`),
      animations: 'disabled',
      fullPage: true,
    });
  }
});

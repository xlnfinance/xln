import { mkdir } from 'node:fs/promises';
import { test, expect, type Page } from '../../global-setup.mts';

const outputDir = '.logs/qa/market-cap';
const now = 1_800_000_000_000;

const price = (shareClass: 'CONTROL' | 'DIVIDEND', pairId: string | null, priceTicks: string | null, observedAt: number | null) => ({
  shareClass,
  pairId,
  priceTicks,
  observedAt,
  sourceHubEntityIds: priceTicks === null ? [] : [
    `0x${'a'.repeat(64)}`,
  ],
});

const entry = (
  entityNumber: string,
  name: string,
  status: 'fresh' | 'stale' | 'no-price',
  marketCapUsdTicks: string | null,
) => {
  const combinedPriceTicks = marketCapUsdTicks === null
    ? null
    : BigInt(marketCapUsdTicks) / 100_000_000_000n;
  const controlPriceTicks = combinedPriceTicks === null ? null : (combinedPriceTicks * 73n) / 100n;
  const dividendPriceTicks = combinedPriceTicks === null || controlPriceTicks === null
    ? null
    : combinedPriceTicks - controlPriceTicks;
  return {
    entityId: `0x${BigInt(entityNumber).toString(16).padStart(64, '0')}`,
    entityNumber,
    name,
    isHub: entityNumber === '7',
    entityKind: entityNumber === '16'
      ? null
      : entityNumber === '9'
        ? 'foundation'
        : entityNumber === '12'
          ? 'nonprofit'
          : 'company',
    sectors: entityNumber === '16'
      ? []
      : entityNumber === '7'
        ? ['finance', 'technology']
        : entityNumber === '11'
          ? ['technology']
          : entityNumber === '12'
            ? ['commerce']
            : ['finance'],
    online: entityNumber !== '12',
    jurisdictionRef: ['11', '12'].includes(entityNumber)
      ? `stack:10:0x${'d'.repeat(40)}`
      : `stack:31337:0x${'c'.repeat(40)}`,
    status,
    control: price('CONTROL', '1/2', controlPriceTicks?.toString() ?? null, status === 'no-price' ? null : now - 22_000),
    dividend: price('DIVIDEND', status === 'no-price' ? null : '1/3', dividendPriceTicks?.toString() ?? null, status === 'no-price' ? null : now - (status === 'stale' ? 420_000 : 36_000)),
    marketCapUsdTicks,
    lastTradeObservedAt: status === 'no-price' ? null : now - 22_000,
  };
};

const payload = {
  format: 'entity-market-cap',
  generatedAt: now,
  staleAfterMs: 300_000,
  connectedHubCount: 2,
  numberedEntityCount: 5,
  freshCount: 3,
  staleCount: 1,
  noPriceCount: 1,
  facets: {
    jurisdictionRefs: [`stack:10:0x${'d'.repeat(40)}`, `stack:31337:0x${'c'.repeat(40)}`],
    entityKinds: ['company', 'foundation', 'nonprofit'],
    sectors: ['commerce', 'finance', 'technology'],
  },
  jurisdictionLeaders: [
    {
      jurisdictionRef: `stack:31337:0x${'c'.repeat(40)}`,
      entityCount: 3,
      pricedEntityCount: 2,
      freshEntityCount: 2,
      marketCapUsdTicks: '4340000000000000',
    },
    {
      jurisdictionRef: `stack:10:0x${'d'.repeat(40)}`,
      entityCount: 2,
      pricedEntityCount: 2,
      freshEntityCount: 1,
      marketCapUsdTicks: '2210000000000000',
    },
  ],
  returned: 5,
  entries: [
    entry('7', 'Northstar Exchange', 'fresh', '2500000000000000'),
    entry('9', 'Atlas Treasury', 'fresh', '1840000000000000'),
    entry('11', 'Cedar Works', 'fresh', '1290000000000000'),
    entry('12', 'Orbit Cooperative', 'stale', '920000000000000'),
    entry('16', 'New Entity', 'no-price', null),
  ],
};

const openMarketCap = async (page: Page): Promise<string[]> => {
  const errors: string[] = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.route('**/api/jurisdictions?**', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: '{}',
  }));
  await page.route('**/api/market-cap?**', route => {
    const params = new URL(route.request().url()).searchParams;
    const entries = payload.entries.filter(candidate => {
      const role = params.get('role');
      const jurisdiction = params.get('jurisdiction');
      const kind = params.get('kind');
      const sector = params.get('sector');
      const status = params.get('status');
      const query = params.get('q')?.toLowerCase();
      return (role === 'all' || (role === 'hub' ? candidate.isHub : !candidate.isHub))
        && (jurisdiction === 'all' || candidate.jurisdictionRef === jurisdiction)
        && (kind === 'all' || (kind === 'unclassified' ? candidate.entityKind === null : candidate.entityKind === kind))
        && (sector === 'all' || (sector === 'unclassified' ? candidate.sectors.length === 0 : candidate.sectors.includes(sector ?? '')))
        && (status === 'all' || candidate.status === status)
        && (!query || `${candidate.entityNumber} ${candidate.name}`.toLowerCase().includes(query));
    });
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...payload, returned: entries.length, entries }),
    });
  });
  await page.goto('/market-cap');
  await expect(page.getByRole('heading', { name: 'xln Market Cap' })).toBeVisible();
  await expect(page.getByText('Northstar Exchange').first()).toBeVisible();
  return errors;
};

test.beforeAll(async () => mkdir(outputDir, { recursive: true }));

test('market cap ranks verified Entity valuations and supports exact filters', { tag: '@functional' }, async ({ page }) => {
  const errors = await openMarketCap(page);
  await expect(page.getByText('$250.0B').first()).toBeVisible();
  await page.getByLabel('Search Entities').fill('Orbit');
  await page.waitForTimeout(300);
  await expect(page.getByText('Orbit Cooperative')).toBeVisible();
  await page.getByLabel('Search Entities').fill('');
  await page.getByLabel('Status').selectOption('no-price');
  await expect(page.getByText('New Entity')).toBeVisible();
  await page.getByRole('button', { name: 'Top Hubs' }).click();
  await expect(page.getByText('Northstar Exchange').first()).toBeVisible();
  await expect(page.getByText('Atlas Treasury')).not.toBeVisible();
  await page.getByRole('button', { name: 'Top Entities' }).click();
  await page.getByLabel('Sector').selectOption('technology');
  await expect(page.getByText('Cedar Works').first()).toBeVisible();
  await page.getByLabel('Jurisdiction').selectOption(`stack:10:0x${'d'.repeat(40)}`);
  await expect(page.getByText('Cedar Works').first()).toBeVisible();
  await page.getByRole('button', { name: 'Top Jurisdictions' }).click();
  await expect(page.getByRole('heading', { name: 'Top Jurisdictions' })).toBeVisible();
  await expect(page.getByText('3 Entities · 2 priced · 2 live')).toBeVisible();
  await page.screenshot({ path: `${outputDir}/jurisdictions.png`, fullPage: true });
  expect(errors).toEqual([]);
});

const captureVisual = async (page: Page, name: string, width: number, height: number): Promise<void> => {
  await page.setViewportSize({ width, height });
  const errors = await openMarketCap(page);
  await page.screenshot({ path: `${outputDir}/${name}.png`, fullPage: true });
  expect(errors).toEqual([]);
};

test('market cap desktop visual', { tag: '@functional' }, async ({ page }) => {
  await captureVisual(page, 'desktop', 1440, 1000);
});

test('market cap iPhone visual', { tag: '@functional' }, async ({ page }) => {
  await captureVisual(page, 'iphone', 390, 844);
});

test('market cap wide visual', { tag: '@functional' }, async ({ page }) => {
  await captureVisual(page, 'wide', 1920, 1080);
});

import { expect, type Page } from '@playwright/test';

type RenderedCapacityDirection = 'outbound' | 'inbound';

const normalizeEntityId = (value: string): string => String(value || '').trim().toLowerCase();

const parseRenderedCapacity = (rawValue: string): number => {
  const numeric = Number(String(rawValue || '').replace(/,/g, '').replace(/[^0-9.-]/g, '').trim());
  return Number.isFinite(numeric) ? numeric : 0;
};

const openAccountsWorkspace = async (page: Page): Promise<void> => {
  const workspace = page.getByTestId('wallet-accounts-overview');
  if (!await workspace.isVisible().catch(() => false)) {
    const nav = page.getByTestId('wallet-nav-accounts');
    await expect(nav).toBeVisible({ timeout: 20_000 });
    await nav.click();
  }
  await expect(workspace).toBeVisible({ timeout: 20_000 });
};

const accountRows = (page: Page) => page.getByTestId('wallet-account-row');

const selectAccount = async (page: Page, counterpartyId: string): Promise<void> => {
  await openAccountsWorkspace(page);
  const row = page.locator(
    `[data-testid="wallet-account-row"][data-counterparty-id="${normalizeEntityId(counterpartyId)}"]`,
  ).first();
  await expect(row, `rendered account ${counterpartyId} must exist`).toBeVisible({ timeout: 20_000 });
  if (!String(await row.getAttribute('class') || '').split(/\s+/).includes('is-selected')) await row.click();
  await expect(page.getByTestId('wallet-account-detail')).toHaveAttribute(
    'data-counterparty-id',
    normalizeEntityId(counterpartyId),
    { timeout: 20_000 },
  );
};

const readSelectedCapacity = async (
  page: Page,
  direction: RenderedCapacityDirection,
): Promise<number> => {
  const token = page.locator('[data-testid="wallet-account-token"][data-token-id="1"]').first();
  await expect(token, 'token 1 account capacity must be rendered').toBeVisible({ timeout: 20_000 });
  const value = token.getByTestId(direction === 'outbound' ? 'wallet-token-outbound' : 'wallet-token-inbound');
  return parseRenderedCapacity(String(await value.textContent() || ''));
};

const getRenderedCapacityForAccount = async (
  page: Page,
  counterpartyId: string,
  direction: RenderedCapacityDirection,
): Promise<number> => {
  await selectAccount(page, counterpartyId);
  return readSelectedCapacity(page, direction);
};

const getRenderedPrimaryCapacity = async (
  page: Page,
  direction: RenderedCapacityDirection,
): Promise<number> => {
  await openAccountsWorkspace(page);
  const rows = accountRows(page);
  const count = await rows.count();
  if (count === 0) throw new Error('Primary rendered capacity is unavailable: no committed accounts');
  let selected = page.locator('[data-testid="wallet-account-row"].is-selected').first();
  if (!await selected.isVisible().catch(() => false)) {
    if (count !== 1) {
      const visible = await rows.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-counterparty-id')));
      throw new Error(`Primary rendered capacity is ambiguous: ${JSON.stringify(visible)}`);
    }
    selected = rows.first();
    await selected.click();
  }
  return readSelectedCapacity(page, direction);
};

const numericTextByTestId = async (page: Page, testId: string): Promise<number> => {
  const locator = page.getByTestId(testId).first();
  await expect(locator).toBeVisible({ timeout: 20_000 });
  return parseRenderedCapacity(String(await locator.textContent() || ''));
};

const waitForAccountDelta = async (
  page: Page,
  counterpartyId: string,
  baseline: number,
  expectedDelta: number,
  direction: RenderedCapacityDirection,
  options?: { timeoutMs?: number; tolerance?: number },
): Promise<number> => {
  const timeoutMs = options?.timeoutMs ?? 20_000;
  const tolerance = options?.tolerance ?? 0.000000001;
  let latest = baseline;
  await expect.poll(async () => {
    latest = await getRenderedCapacityForAccount(page, counterpartyId, direction);
    return latest - baseline;
  }, { timeout: timeoutMs, intervals: [250, 500, 750] }).toBeCloseTo(expectedDelta, 8);
  if (Math.abs((latest - baseline) - expectedDelta) > tolerance) {
    throw new Error(`Rendered ${direction} delta mismatch: baseline=${baseline} latest=${latest} expected=${expectedDelta}`);
  }
  return latest;
};

const waitForPrimaryDelta = async (
  page: Page,
  baseline: number,
  expectedDelta: number,
  direction: RenderedCapacityDirection,
  options?: { timeoutMs?: number; tolerance?: number },
): Promise<number> => {
  const timeoutMs = options?.timeoutMs ?? 20_000;
  const tolerance = options?.tolerance ?? 0.000000001;
  let latest = baseline;
  await expect.poll(async () => {
    latest = await getRenderedPrimaryCapacity(page, direction);
    return latest - baseline;
  }, { timeout: timeoutMs, intervals: [250, 500, 750] }).toBeCloseTo(expectedDelta, 8);
  if (Math.abs((latest - baseline) - expectedDelta) > tolerance) {
    throw new Error(`Rendered primary ${direction} delta mismatch: baseline=${baseline} latest=${latest} expected=${expectedDelta}`);
  }
  return latest;
};

export const listRenderedCounterpartyIds = async (page: Page): Promise<string[]> => {
  await openAccountsWorkspace(page);
  return (await accountRows(page).evaluateAll(nodes => nodes.map(node => node.getAttribute('data-counterparty-id'))))
    .map(value => normalizeEntityId(String(value || '')))
    .filter(Boolean);
};

export const getRenderedPrimaryOutbound = (page: Page): Promise<number> =>
  getRenderedPrimaryCapacity(page, 'outbound');

export const getRenderedPrimaryInbound = (page: Page): Promise<number> =>
  getRenderedPrimaryCapacity(page, 'inbound');

export const waitForRenderedPrimaryOutboundDelta = (
  page: Page, baseline: number, expectedDelta: number,
  options?: { timeoutMs?: number; tolerance?: number },
): Promise<number> => waitForPrimaryDelta(page, baseline, expectedDelta, 'outbound', options);

export const waitForRenderedPrimaryInboundDelta = (
  page: Page, baseline: number, expectedDelta: number,
  options?: { timeoutMs?: number; tolerance?: number },
): Promise<number> => waitForPrimaryDelta(page, baseline, expectedDelta, 'inbound', options);

export const getRenderedOutboundForAccount = (page: Page, counterpartyId: string): Promise<number> =>
  getRenderedCapacityForAccount(page, counterpartyId, 'outbound');

export const getRenderedInboundForAccount = (page: Page, counterpartyId: string): Promise<number> =>
  getRenderedCapacityForAccount(page, counterpartyId, 'inbound');

export const getRenderedExternalBalance = (page: Page, symbol: string): Promise<number> =>
  numericTextByTestId(page, `external-balance-${symbol}`);

export const getRenderedReserveBalance = (page: Page, symbol: string): Promise<number> =>
  numericTextByTestId(page, `reserve-balance-${symbol}`);

export const getRenderedAccountSpendableBalance = (page: Page, symbol: string): Promise<number> =>
  numericTextByTestId(page, `account-spendable-${symbol}`);

export const waitForRenderedOutboundForAccount = async (
  page: Page,
  counterpartyId: string,
  options?: { timeoutMs?: number },
): Promise<number> => {
  let latest = 0;
  await expect.poll(async () => {
    latest = await getRenderedOutboundForAccount(page, counterpartyId);
    return true;
  }, { timeout: options?.timeoutMs ?? 20_000, intervals: [250, 500, 750] }).toBe(true);
  return latest;
};

export const waitForRenderedOutboundForAccountDelta = (
  page: Page, counterpartyId: string, baseline: number, expectedDelta: number,
  options?: { timeoutMs?: number; tolerance?: number },
): Promise<number> => waitForAccountDelta(page, counterpartyId, baseline, expectedDelta, 'outbound', options);

export const waitForRenderedInboundForAccountDelta = (
  page: Page, counterpartyId: string, baseline: number, expectedDelta: number,
  options?: { timeoutMs?: number; tolerance?: number },
): Promise<number> => waitForAccountDelta(page, counterpartyId, baseline, expectedDelta, 'inbound', options);

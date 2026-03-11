import { type Page } from '@playwright/test';

type RenderedAccountCapacityView = {
  counterpartyId: string;
  outbound: number;
  inbound: number;
  selected: boolean;
};

type RenderedCapacityDirection = 'outbound' | 'inbound';

function normalizeEntityId(value: string): string {
  return String(value || '').trim().toLowerCase();
}

function parseRenderedCapacity(rawValue: string): number {
  const raw = String(rawValue || '').replace(/,/g, '').trim();
  const numeric = Number(raw.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(numeric) ? numeric : 0;
}

async function readRenderedAccountCards(page: Page): Promise<RenderedAccountCapacityView[]> {
  return page.evaluate(() => {
    const extractAmountText = (valueEl: Element): string => {
      const children = Array.from(valueEl.children);
      for (const child of children) {
        if (child instanceof HTMLElement && child.classList.contains('usd-hint')) continue;
        const raw = String(child.textContent || '').trim();
        if (raw.length > 0) return raw;
      }

      const raw = String(valueEl.textContent || '').trim();
      const usdHintText = children
        .filter((child) => child instanceof HTMLElement && child.classList.contains('usd-hint'))
        .map((child) => String(child.textContent || ''))
        .join('');
      return usdHintText.length > 0 ? raw.replace(usdHintText, '').trim() : raw;
    };

    const readMetric = (card: Element, selectors: string): number => {
      const valueEl = card.querySelector(selectors);
      if (!valueEl) return 0;
      return Number.parseFloat(extractAmountText(valueEl).replace(/,/g, '').trim()) || 0;
    };

    return Array.from(document.querySelectorAll('.account-preview')).map((card) => {
      const counterpartyId = String(
        card.getAttribute('data-counterparty-id')
        || card.querySelector('.entity-id, .id, [data-entity-id]')?.textContent
        || '',
      ).trim();
      return {
        counterpartyId,
        outbound: readMetric(card, '.delta-row .compact-out-value, .compact-out-value, .cap.out .cap-value'),
        inbound: readMetric(card, '.delta-row .compact-in-value, .compact-in-value, .cap.in .cap-value'),
        selected: card.classList.contains('selected'),
      };
    });
  });
}

export async function listRenderedCounterpartyIds(page: Page): Promise<string[]> {
  const cards = await readRenderedAccountCards(page);
  return cards
    .map((card) => normalizeEntityId(card.counterpartyId))
    .filter((counterpartyId) => counterpartyId.length > 0);
}

async function getRenderedCapacityForAccount(
  page: Page,
  counterpartyId: string,
  direction: RenderedCapacityDirection,
): Promise<number> {
  const target = normalizeEntityId(counterpartyId);
  const cards = await readRenderedAccountCards(page);
  const match = cards.find((card) => normalizeEntityId(card.counterpartyId) === target) ?? null;
  if (!match) {
    throw new Error(
      `No rendered account card for ${counterpartyId}. Visible=${cards.map((card) => card.counterpartyId || 'unknown').join(',') || 'none'}`,
    );
  }
  return direction === 'outbound' ? match.outbound : match.inbound;
}

async function getRenderedPrimaryCapacity(page: Page, selectors: string): Promise<number> {
  return page.evaluate(({ selectors }) => {
    const extractAmountText = (valueEl: Element): string => {
      const children = Array.from(valueEl.children);
      for (const child of children) {
        if (child instanceof HTMLElement && child.classList.contains('usd-hint')) continue;
        const raw = String(child.textContent || '').trim();
        if (raw.length > 0) return raw;
      }

      const raw = String(valueEl.textContent || '').trim();
      const usdHintText = children
        .filter((child) => child instanceof HTMLElement && child.classList.contains('usd-hint'))
        .map((child) => String(child.textContent || ''))
        .join('');
      return usdHintText.length > 0 ? raw.replace(usdHintText, '').trim() : raw;
    };

    const selectedCard =
      document.querySelector('.account-preview.selected')
      || document.querySelector('.account-preview');
    if (!selectedCard) return 0;

    const valueEl = selectedCard.querySelector(selectors);
    if (!valueEl) return 0;

    return Number.parseFloat(extractAmountText(valueEl).replace(/,/g, '').trim()) || 0;
  }, { selectors });
}

async function getNumericTextByTestId(page: Page, testId: string): Promise<number> {
  const locator = page.getByTestId(testId).first();
  await locator.waitFor({ state: 'visible', timeout: 20_000 });
  const text = (await locator.textContent())?.trim() ?? '0';
  return parseRenderedCapacity(text);
}

async function waitForRenderedAccountCapacityDelta(
  page: Page,
  counterpartyId: string,
  baseline: number,
  expectedDelta: number,
  direction: RenderedCapacityDirection,
  options?: {
    timeoutMs?: number;
    tolerance?: number;
  },
): Promise<number> {
  const timeoutMs = options?.timeoutMs ?? 20_000;
  const tolerance = options?.tolerance ?? 0.000001;
  const startedAt = Date.now();
  let latest = baseline;

  while (Date.now() - startedAt < timeoutMs) {
    latest = await getRenderedCapacityForAccount(page, counterpartyId, direction);
    if (Math.abs((latest - baseline) - expectedDelta) <= tolerance) return latest;
    await page.waitForTimeout(250);
  }

  const cards = await readRenderedAccountCards(page);
  throw new Error(
    `Timed out waiting for rendered ${direction} capacity on ${counterpartyId} baseline=${baseline} latest=${latest} expectedDelta=${expectedDelta} visible=${JSON.stringify(cards)}`,
  );
}

async function waitForRenderedPrimaryCapacityDelta(
  page: Page,
  baseline: number,
  expectedDelta: number,
  selectors: string,
  options?: {
    timeoutMs?: number;
    tolerance?: number;
  },
): Promise<number> {
  const timeoutMs = options?.timeoutMs ?? 20_000;
  const tolerance = options?.tolerance ?? 0.000001;
  const startedAt = Date.now();
  let latest = baseline;

  while (Date.now() - startedAt < timeoutMs) {
    latest = await getRenderedPrimaryCapacity(page, selectors);
    if (Math.abs((latest - baseline) - expectedDelta) <= tolerance) return latest;
    await page.waitForTimeout(250);
  }

  throw new Error(
    `Timed out waiting for rendered capacity delta baseline=${baseline} latest=${latest} expectedDelta=${expectedDelta}`,
  );
}

export async function getRenderedPrimaryOutbound(page: Page): Promise<number> {
  return getRenderedPrimaryCapacity(page, '.delta-row .compact-out-value, .compact-out-value, .cap.out .cap-value');
}

export async function getRenderedPrimaryInbound(page: Page): Promise<number> {
  return getRenderedPrimaryCapacity(page, '.delta-row .compact-in-value, .compact-in-value, .cap.in .cap-value');
}

export async function waitForRenderedPrimaryOutboundDelta(
  page: Page,
  baseline: number,
  expectedDelta: number,
  options?: {
    timeoutMs?: number;
    tolerance?: number;
  },
): Promise<number> {
  return waitForRenderedPrimaryCapacityDelta(
    page,
    baseline,
    expectedDelta,
    '.delta-row .compact-out-value, .compact-out-value, .cap.out .cap-value',
    options,
  );
}

export async function waitForRenderedPrimaryInboundDelta(
  page: Page,
  baseline: number,
  expectedDelta: number,
  options?: {
    timeoutMs?: number;
    tolerance?: number;
  },
): Promise<number> {
  return waitForRenderedPrimaryCapacityDelta(
    page,
    baseline,
    expectedDelta,
    '.delta-row .compact-in-value, .compact-in-value, .cap.in .cap-value',
    options,
  );
}

export async function getRenderedOutboundForAccount(page: Page, counterpartyId: string): Promise<number> {
  return getRenderedCapacityForAccount(page, counterpartyId, 'outbound');
}

export async function getRenderedInboundForAccount(page: Page, counterpartyId: string): Promise<number> {
  return getRenderedCapacityForAccount(page, counterpartyId, 'inbound');
}

export async function getRenderedExternalBalance(page: Page, symbol: string): Promise<number> {
  return getNumericTextByTestId(page, `external-balance-${symbol}`);
}

export async function getRenderedReserveBalance(page: Page, symbol: string): Promise<number> {
  return getNumericTextByTestId(page, `reserve-balance-${symbol}`);
}

export async function waitForRenderedOutboundForAccount(
  page: Page,
  counterpartyId: string,
  options?: {
    timeoutMs?: number;
  },
): Promise<number> {
  const timeoutMs = options?.timeoutMs ?? 20_000;
  const startedAt = Date.now();
  let lastError: Error | null = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await getRenderedOutboundForAccount(page, counterpartyId);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      await page.waitForTimeout(250);
    }
  }

  throw lastError ?? new Error(`Timed out waiting for rendered outbound account ${counterpartyId}`);
}

export async function waitForRenderedOutboundForAccountDelta(
  page: Page,
  counterpartyId: string,
  baseline: number,
  expectedDelta: number,
  options?: {
    timeoutMs?: number;
    tolerance?: number;
  },
): Promise<number> {
  return waitForRenderedAccountCapacityDelta(
    page,
    counterpartyId,
    baseline,
    expectedDelta,
    'outbound',
    options,
  );
}

export async function waitForRenderedInboundForAccountDelta(
  page: Page,
  counterpartyId: string,
  baseline: number,
  expectedDelta: number,
  options?: {
    timeoutMs?: number;
    tolerance?: number;
  },
): Promise<number> {
  return waitForRenderedAccountCapacityDelta(
    page,
    counterpartyId,
    baseline,
    expectedDelta,
    'inbound',
    options,
  );
}

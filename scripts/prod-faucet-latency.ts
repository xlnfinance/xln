#!/usr/bin/env bun

type FaucetResponseBody = {
  success?: boolean;
  requestId?: string;
  serverDurationMs?: number;
  error?: string;
};

type ApiTrafficEntry = {
  method: string;
  path: string;
  status?: number;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
};

const baseUrl = String(process.env.PROD_BASE_URL || process.env.E2E_BASE_URL || 'https://xln.finance')
  .replace(/\/+$/, '');
const headless = process.env.HEADFUL !== '1';
const tokenSymbol = String(process.env.PROD_FAUCET_SYMBOL || 'USDC').trim().toUpperCase();
const label = `prod-proof-${Date.now()}`;

process.env.E2E_BASE_URL = baseUrl;
process.env.E2E_API_BASE_URL = baseUrl;
process.env.PW_BASE_URL = baseUrl;

const [{ chromium }, { expect }, { Wallet }] = await Promise.all([
  import('playwright'),
  import('@playwright/test'),
  import('ethers'),
]);
const { gotoApp, createRuntimeIdentity } = await import('../tests/utils/e2e-demo-users');
const { connectRuntimeToHubWithCredit } = await import('../tests/utils/e2e-connect');
const { getHealth } = await import('../tests/utils/e2e-baseline');

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`${path} failed: ${response.status} ${await response.text().catch(() => '')}`);
  }
  return await response.json() as T;
}

async function getTokenId(symbol: string): Promise<number> {
  const body = await fetchJson<{ tokens?: Array<{ symbol?: string; tokenId?: number }> }>('/api/tokens');
  const token = (body.tokens || []).find((candidate) =>
    String(candidate.symbol || '').trim().toUpperCase() === symbol,
  );
  if (typeof token?.tokenId !== 'number') {
    throw new Error(`Token ${symbol} is not exposed by /api/tokens`);
  }
  return token.tokenId;
}

async function readRenderedAccountTokenOut(page: import('playwright').Page, hubId: string, symbol: string): Promise<number> {
  return await page.evaluate(({ hubId, symbol }) => {
    const preview = document.querySelector(`.account-preview[data-counterparty-id="${String(hubId).toLowerCase()}"]`);
    if (!preview) return Number.NaN;
    const rows = Array.from(preview.querySelectorAll('.delta-row, .delta-row-stack, .delta-summary'));
    for (const row of rows) {
      const symbolEl = row.querySelector('.token-symbol');
      if (String(symbolEl?.textContent || '').trim().toUpperCase() !== String(symbol || '').trim().toUpperCase()) {
        continue;
      }
      const valueEl = row.querySelector('.compact-out-value');
      if (!valueEl) return Number.NaN;
      const amountEl = Array.from(valueEl.children).find((child) =>
        !(child instanceof HTMLElement) || !child.classList.contains('usd-hint'),
      );
      const text = String((amountEl?.textContent || valueEl.textContent || '')).replace(/,/g, '').trim();
      const numeric = Number(text.replace(/[^0-9.-]/g, ''));
      return Number.isFinite(numeric) ? numeric : Number.NaN;
    }
    return Number.NaN;
  }, { hubId, symbol });
}

async function waitForRenderedOutAbove(
  page: import('playwright').Page,
  hubId: string,
  symbol: string,
  baselineOut: number,
  timeoutMs: number,
): Promise<{ value: number; elapsedMs: number }> {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  while (Date.now() <= deadline) {
    const value = await readRenderedAccountTokenOut(page, hubId, symbol);
    if (Number.isFinite(value) && value > baselineOut) {
      return { value, elapsedMs: Date.now() - startedAt };
    }
    await page.waitForTimeout(25);
  }
  throw new Error(`Timed out waiting for rendered ${symbol} out capacity to exceed ${baselineOut}`);
}

const browser = await chromium.launch({ headless });
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1440, height: 980 },
});
const page = await context.newPage();
page.setDefaultTimeout(30_000);

const traffic: ApiTrafficEntry[] = [];
const requestEntries = new Map<unknown, ApiTrafficEntry>();
let clickEpochMs = 0;
let faucetRequestStartedAt: number | null = null;
let faucetResponseAt: number | null = null;
let faucetResponseBody: FaucetResponseBody | null = null;

page.on('request', (request) => {
  const url = new URL(request.url());
  if (url.origin !== baseUrl || !url.pathname.startsWith('/api/')) return;
  const entry: ApiTrafficEntry = {
    method: request.method(),
    path: url.pathname,
    startedAt: Date.now(),
  };
  requestEntries.set(request, entry);
  traffic.push(entry);
  if (clickEpochMs > 0 && url.pathname === '/api/faucet/offchain') {
    faucetRequestStartedAt = entry.startedAt;
  }
});

page.on('response', async (response) => {
  const request = response.request();
  const entry = requestEntries.get(request);
  if (!entry) return;
  entry.status = response.status();
  entry.endedAt = Date.now();
  entry.durationMs = entry.endedAt - entry.startedAt;
  const url = new URL(response.url());
  if (url.pathname === '/api/faucet/offchain') {
    faucetResponseAt = entry.endedAt;
    faucetResponseBody = await response.json().catch(() => null) as FaucetResponseBody | null;
  }
});

try {
  const [health, jurisdictions, appVersion, tokenId] = await Promise.all([
    getHealth(page, baseUrl),
    fetchJson<{ deployVersion?: string; networkVersion?: string; version?: string }>('/api/jurisdictions'),
    fetchJson<{ version?: string }>('/_app/version.json'),
    getTokenId(tokenSymbol),
  ]);
  const hubId = health?.hubMesh?.hubIds?.[0];
  if (!hubId) throw new Error('Primary hub id is missing from /api/health');

  console.log(`[prod-faucet] base=${baseUrl} app=${appVersion.version || 'n/a'} network=${jurisdictions.deployVersion || jurisdictions.networkVersion || jurisdictions.version || 'n/a'}`);
  console.log(`[prod-faucet] creating ${label} and connecting to hub ${hubId.slice(0, 10)}... token=${tokenSymbol}#${tokenId}`);

  await gotoApp(page, { appBaseUrl: baseUrl, initTimeoutMs: 45_000, settleMs: 0 });
  const mnemonic = Wallet.createRandom().mnemonic!.phrase;
  const identity = await createRuntimeIdentity(page, label, mnemonic, { requireOnline: false });
  await connectRuntimeToHubWithCredit(page, identity, hubId, '10000', [tokenId], { requireOnline: false });
  await page.getByTestId('tab-accounts').first().click();

  const preview = page.locator(`.account-preview[data-counterparty-id="${hubId.toLowerCase()}"]`).first();
  await expect(preview).toBeVisible({ timeout: 30_000 });
  const row = preview.locator('.delta-row-stack, .delta-summary', { hasText: tokenSymbol }).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  const faucetButton = row.getByRole('button', { name: /^Faucet$/ }).first();
  await expect(faucetButton).toBeEnabled({ timeout: 30_000 });

  const baselineOut = await readRenderedAccountTokenOut(page, hubId, tokenSymbol);
  if (!Number.isFinite(baselineOut)) {
    throw new Error(`Could not read rendered ${tokenSymbol} out capacity before faucet`);
  }

  clickEpochMs = Date.now();
  await faucetButton.click();

  let clickToVisibleFeedbackMs: number | null = null;
  const feedbackDeadline = Date.now() + 1_500;
  while (Date.now() <= feedbackDeadline) {
    const [buttonText, disabled, renderedOut] = await Promise.all([
      faucetButton.textContent().catch(() => ''),
      faucetButton.isDisabled().catch(() => false),
      readRenderedAccountTokenOut(page, hubId, tokenSymbol),
    ]);
    if (/Funding/i.test(String(buttonText || '')) || disabled || renderedOut > baselineOut) {
      clickToVisibleFeedbackMs = Date.now() - clickEpochMs;
      break;
    }
    await page.waitForTimeout(25);
  }

  const visible = await waitForRenderedOutAbove(page, hubId, tokenSymbol, baselineOut, 15_000);
  await page.waitForTimeout(250);

  const apiTrafficAfterClick = traffic
    .filter((entry) => entry.startedAt >= clickEpochMs)
    .map(({ method, path, status, durationMs }) => ({ method, path, status, durationMs }));
  const endpointCounts = apiTrafficAfterClick.reduce<Record<string, number>>((counts, entry) => {
    const key = `${entry.method} ${entry.path}`;
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});

  const report = {
    ok: true,
    baseUrl,
    appVersion: appVersion.version || null,
    networkVersion: jurisdictions.deployVersion || jurisdictions.networkVersion || jurisdictions.version || null,
    runtimeId: identity.runtimeId,
    entityId: identity.entityId,
    signerId: identity.signerId,
    hubId,
    tokenSymbol,
    tokenId,
    baselineOut,
    finalOut: visible.value,
    gained: visible.value - baselineOut,
    clickToVisibleFeedbackMs,
    clickToFaucetRequestMs: faucetRequestStartedAt === null ? null : faucetRequestStartedAt - clickEpochMs,
    faucetApiRoundtripMs:
      faucetRequestStartedAt === null || faucetResponseAt === null ? null : faucetResponseAt - faucetRequestStartedAt,
    faucetServerDurationMs: faucetResponseBody?.serverDurationMs ?? null,
    faucetRequestId: faucetResponseBody?.requestId ?? null,
    clickToDomVisibleMs: visible.elapsedMs,
    apiRequestsAfterClick: apiTrafficAfterClick.length,
    endpointCounts,
  };

  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  await page.screenshot({ path: 'test-results/prod-faucet-latency-failure.png', fullPage: true }).catch(() => null);
  console.error(JSON.stringify({ ok: false, baseUrl, tokenSymbol, label, error: message }, null, 2));
  process.exitCode = 1;
} finally {
  await context.close().catch(() => null);
  await browser.close().catch(() => null);
}

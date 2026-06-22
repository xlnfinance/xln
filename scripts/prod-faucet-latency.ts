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

type HealthPayload = {
  hubMesh?: {
    hubIds?: string[];
  };
  hubs?: Array<{
    entityId?: string;
    name?: string;
    online?: boolean;
  }>;
};

type DebugEntity = {
  entityId?: string;
  name?: string;
  isHub?: boolean;
  online?: boolean;
  metadata?: {
    isHub?: boolean;
  };
};

type HubAccountStatus = {
  success?: boolean;
  ready?: boolean;
  currentHeight?: number;
  pendingFrameHeight?: number | null;
  mempool?: number;
  tokens?: Array<{
    tokenId?: number;
    hubOutCapacity?: string;
  }>;
};

const baseUrl = String(process.env.PROD_BASE_URL || process.env.E2E_BASE_URL || 'https://xln.finance')
  .replace(/\/+$/, '');
const headless = process.env.HEADFUL !== '1';
const tokenSymbol = String(process.env.PROD_FAUCET_SYMBOL || 'USDC').trim().toUpperCase();
const label = `prod-proof-${Date.now()}`;
const fetchTimeoutMs = Math.max(500, Number(process.env.PROD_FAUCET_FETCH_TIMEOUT_MS || '5000'));

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

async function fetchJson<T>(path: string, timeoutMs = fetchTimeoutMs): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`${path} failed: ${response.status} ${await response.text().catch(() => '')}`);
    }
    return await response.json() as T;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`${path} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
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

async function resolvePrimaryHubId(health: HealthPayload | null): Promise<string> {
  const healthHub = health?.hubMesh?.hubIds?.find((id) => /^0x[a-fA-F0-9]{64}$/.test(String(id || '')));
  if (healthHub) return healthHub;

  const namedHealthHub = health?.hubs?.find((hub) =>
    hub.online !== false && /^0x[a-fA-F0-9]{64}$/.test(String(hub.entityId || '')),
  )?.entityId;
  if (namedHealthHub) return namedHealthHub;

  const debug = await fetchJson<{ entities?: DebugEntity[] }>('/api/debug/entities?online=true&limit=100');
  const hub = (debug.entities || []).find((entity) =>
    (entity.isHub === true || entity.metadata?.isHub === true) &&
    /^0x[a-fA-F0-9]{64}$/.test(String(entity.entityId || '')),
  );
  if (!hub?.entityId) {
    throw new Error('Primary hub id is missing from /api/health and /api/debug/entities');
  }
  return hub.entityId;
}

async function readHubAccountStatus(
  hubEntityId: string,
  counterpartyEntityId: string,
  tokenId: number,
): Promise<HubAccountStatus> {
  const query = new URLSearchParams({
    hubEntityId,
    counterpartyEntityId,
    tokenIds: String(tokenId),
  });
  return await fetchJson<HubAccountStatus>(`/api/hub/account-status?${query.toString()}`);
}

function summarizeHubAccountStatus(status: HubAccountStatus | null): Record<string, unknown> | null {
  if (!status) return null;
  return {
    success: status.success === true,
    ready: status.ready === true,
    currentHeight: Number(status.currentHeight ?? 0),
    pendingFrameHeight: status.pendingFrameHeight ?? null,
    mempool: Number(status.mempool ?? 0),
    tokens: (status.tokens || []).map(token => ({
      tokenId: token.tokenId,
      hubOutCapacity: token.hubOutCapacity ?? null,
    })),
  };
}

function readHubOutCapacity(status: HubAccountStatus | null, tokenId: number): bigint | null {
  const token = (status?.tokens || []).find((candidate) => Number(candidate.tokenId) === tokenId);
  if (!token?.hubOutCapacity) return null;
  try {
    return BigInt(token.hubOutCapacity);
  } catch {
    return null;
  }
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
let faucetProxyHealthPolled: string | null = null;
let faucetProxyHealthPollMs: string | null = null;
let faucetProxyUpstreamMs: string | null = null;
let faucetProxyTotalMs: string | null = null;

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
    faucetProxyHealthPolled = response.headers()['x-xln-proxy-health-polled'] ?? null;
    faucetProxyHealthPollMs = response.headers()['x-xln-proxy-health-poll-ms'] ?? null;
    faucetProxyUpstreamMs = response.headers()['x-xln-proxy-upstream-ms'] ?? null;
    faucetProxyTotalMs = response.headers()['x-xln-proxy-total-ms'] ?? null;
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
  const hubId = await resolvePrimaryHubId(health as HealthPayload | null);

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
  const baselineServerStatus = await readHubAccountStatus(hubId, identity.entityId, tokenId).catch((error) => {
    throw new Error(`Baseline /api/hub/account-status failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  const baselineServerHeight = Number(baselineServerStatus.currentHeight ?? 0);
  const baselineServerCapacity = readHubOutCapacity(baselineServerStatus, tokenId);

  clickEpochMs = Date.now();
  await faucetButton.click();

  let clickToVisibleFeedbackMs: number | null = null;
  let clickToServerAccountReadyMs: number | null = null;
  let clickToServerCapacityChangedMs: number | null = null;
  let clickToDomVisibleMs: number | null = null;
  let lastServerStatusPollAt = 0;
  let serverAccountReadyStatus: HubAccountStatus | null = null;
  let serverCapacityChangedStatus: HubAccountStatus | null = null;
  let serverAccountStatusError: string | null = null;
  let finalServerStatus: HubAccountStatus | null = null;
  let finalOut = Number.NaN;
  const deadline = clickEpochMs + 15_000;
  while (Date.now() <= deadline) {
    if (
      (clickToServerAccountReadyMs === null || clickToServerCapacityChangedMs === null) &&
      Date.now() - lastServerStatusPollAt >= 250
    ) {
      lastServerStatusPollAt = Date.now();
      try {
        const status = await readHubAccountStatus(hubId, identity.entityId, tokenId);
        const height = Number(status.currentHeight ?? 0);
        const capacity = readHubOutCapacity(status, tokenId);
        if (clickToServerAccountReadyMs === null && status.ready === true && height >= baselineServerHeight) {
          clickToServerAccountReadyMs = Date.now() - clickEpochMs;
          serverAccountReadyStatus = status;
        }
        if (
          clickToServerCapacityChangedMs === null &&
          status.ready === true &&
          baselineServerCapacity !== null &&
          capacity !== null &&
          capacity !== baselineServerCapacity
        ) {
          clickToServerCapacityChangedMs = Date.now() - clickEpochMs;
          serverCapacityChangedStatus = status;
        }
      } catch (error) {
        serverAccountStatusError = error instanceof Error ? error.message : String(error);
      }
    }
    const [buttonState, renderedOut] = await Promise.all([
      row.evaluate((element) => {
        const buttons = Array.from(element.querySelectorAll('button'));
        return {
          hasFundingText: buttons.some((button) => /Funding/i.test(String(button.textContent || ''))),
          anyDisabled: buttons.some((button) => button.disabled),
        };
      }).catch(() => ({ hasFundingText: false, anyDisabled: false })),
      readRenderedAccountTokenOut(page, hubId, tokenSymbol),
    ]);
    if (
      clickToVisibleFeedbackMs === null &&
      (buttonState.hasFundingText || buttonState.anyDisabled || renderedOut > baselineOut)
    ) {
      clickToVisibleFeedbackMs = Date.now() - clickEpochMs;
    }
    if (Number.isFinite(renderedOut) && renderedOut > baselineOut) {
      finalOut = renderedOut;
      if (clickToDomVisibleMs === null) clickToDomVisibleMs = Date.now() - clickEpochMs;
      if (clickToServerCapacityChangedMs !== null) break;
    }
    await page.waitForTimeout(25);
  }
  if (!Number.isFinite(finalOut) || clickToDomVisibleMs === null) {
    throw new Error(`Timed out waiting for rendered ${tokenSymbol} out capacity to exceed ${baselineOut}`);
  }
  finalServerStatus = await readHubAccountStatus(hubId, identity.entityId, tokenId).catch(() => null);
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
    baselineServerStatus: summarizeHubAccountStatus(baselineServerStatus),
    baselineServerCapacity: baselineServerCapacity?.toString() ?? null,
    finalOut,
    gained: finalOut - baselineOut,
    finalServerStatus: summarizeHubAccountStatus(finalServerStatus),
    finalServerCapacity: readHubOutCapacity(finalServerStatus, tokenId)?.toString() ?? null,
    clickToVisibleFeedbackMs,
    clickToFaucetRequestMs: faucetRequestStartedAt === null ? null : faucetRequestStartedAt - clickEpochMs,
    faucetApiRoundtripMs:
      faucetRequestStartedAt === null || faucetResponseAt === null ? null : faucetResponseAt - faucetRequestStartedAt,
    faucetServerDurationMs: faucetResponseBody?.serverDurationMs ?? null,
    faucetProxyHealthPolled,
    faucetProxyHealthPollMs,
    faucetProxyUpstreamMs,
    faucetProxyTotalMs,
    faucetRequestId: faucetResponseBody?.requestId ?? null,
    clickToServerAccountReadyMs,
    clickToServerCapacityChangedMs,
    serverAccountReadyStatus: summarizeHubAccountStatus(serverAccountReadyStatus),
    serverCapacityChangedStatus: summarizeHubAccountStatus(serverCapacityChangedStatus),
    serverAccountStatusError,
    clickToDomVisibleMs,
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

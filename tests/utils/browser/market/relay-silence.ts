import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { test as base, expect, type Page, type TestInfo } from '../../../global-setup.mts';
import { API_BASE_URL, APP_BASE_URL } from '../../e2e-baseline';
import { startMarketTransport, type MarketTransport } from './market-transport';
import { readAccount, readOrders, expectDeliveryDrained } from '../../../../ui/tests/swap-evidence';
import { safeStringify } from '../../../../core/protocol/serialization';

export const test = base.extend<{ marketTransportEnabled: boolean; marketTransport: MarketTransport | null }>({
  marketTransportEnabled: false,
  marketTransport: async ({ marketTransportEnabled }, use) => {
    if (!marketTransportEnabled) return use(null);
    const transport = await startMarketTransport([API_BASE_URL, APP_BASE_URL]);
    try {
      await use(transport);
    } finally {
      await transport.close();
    }
  },
  proxy: async ({ marketTransport }, use) => {
    await use(marketTransport ? { server: marketTransport.server, bypass: '<-loopback>' } : undefined);
  },
});

function processOwner(value: unknown): { pid: number; ownerId: string } {
  if (!value || typeof value !== 'object' || !('process' in value)) throw new Error('RELAY_HEALTH_PROCESS_MISSING');
  const record = value.process;
  if (!record || typeof record !== 'object' || !('pid' in record) || !('ownerId' in record))
    throw new Error('RELAY_HEALTH_OWNER_MISSING');
  const { pid, ownerId } = record;
  if (
    typeof pid !== 'number' ||
    !Number.isSafeInteger(pid) ||
    pid <= 1 ||
    typeof ownerId !== 'string' ||
    !ownerId.startsWith(`${pid}:`)
  )
    throw new Error('RELAY_HEALTH_OWNER_INVALID');
  return { pid, ownerId };
}

export async function requireOwnedRelay(page: Page) {
  expect(process.env['E2E_ISOLATED_STACK']).toBe('1');
  expect(['127.0.0.1', 'localhost']).toContain(new URL(API_BASE_URL).hostname);
  const baseline = process.env['E2E_BASELINE_HEALTH_JSON'];
  const jurisdictions = process.env['XLN_JURISDICTIONS_PATH'];
  const output = process.env['PW_OUTPUT_DIR'];
  if (!baseline || !jurisdictions || !output) throw new Error('ISOLATED_RELAY_OWNERSHIP_EVIDENCE_MISSING');
  expect(resolve(output).startsWith(`${resolve('.logs/e2e-parallel')}/`)).toBe(true);
  expect(jurisdictions).toBe(resolve(output, '../../rdb/mesh/jurisdictions.json'));
  const expected = processOwner(JSON.parse(baseline));
  const response = await page.request.get(`${API_BASE_URL}/api/health`, { timeout: 3000 });
  expect(response.ok()).toBe(true);
  const actual = processOwner(await response.json());
  expect(actual).toEqual(expected);
  const command = execFileSync('ps', ['-p', String(actual.pid), '-o', 'command='], {
    encoding: 'utf8',
    timeout: 1000,
  }).trim();
  expect(command).toContain('core/orchestrator/orchestrator.ts');
  expect(command).toContain(`--db-root ${dirname(jurisdictions)} `);
  return actual;
}

/** Silence only the real market connection; the shared RPC and financial relay must stay healthy. */
export async function verifyRelaySilence(
  page: Page,
  info: TestInfo,
  transport: MarketTransport | null,
  phase: 'initial' | 'live' = 'initial',
): Promise<void> {
  if (!transport) throw new Error('MARKET_TRANSPORT_FIXTURE_MISSING');
  await page.getByTestId('home-faucet').click();
  await expect(page.getByTestId('test-money-status')).toHaveText('100 USDC received');
  await page.getByTestId('account-row').first().click();
  const hubId = new URL(page.url()).pathname.split('/accounts/')[1];
  if (!hubId || !/^0x[0-9a-f]{64}$/.test(hubId)) throw new Error('SILENCE_ACCOUNT_MISSING');
  await page.getByTestId('back').click();
  await expectDeliveryDrained(page, expect);
  const before = await readAccount(page, hubId);
  const orders = await readOrders(page, hubId);
  const owner = await requireOwnedRelay(page);
  await info.attach('real-relay-owner-before-pause', {
    body: safeStringify({ owner, jurisdictions: process.env['XLN_JURISDICTIONS_PATH'] }),
    contentType: 'application/json',
  });
  const book = page.getByTestId('orderbook').locator('visible=true').first();
  if (phase === 'live') {
    await page.getByTestId('home-swap').click();
    await expect(book).toHaveAttribute('data-status', 'live');
    await expect(book.getByTestId('book-row-ask')).toHaveCount(10);
    await expect(book.getByTestId('book-row-bid')).toHaveCount(10);
  }
  const started = Date.now();
  try {
    transport.pause();
    if (phase === 'initial') {
      await page.getByTestId('home-swap').click();
      await expect(book).toBeVisible();
      await expect(book).toHaveAttribute('data-status', 'syncing');
    }
    await expect(book).toHaveAttribute('data-status', 'unavailable', { timeout: 18_000 });
    await expect(book.getByTestId('book-row-ask')).toHaveCount(0);
    await expect(book.getByTestId('book-row-bid')).toHaveCount(0);
    await expect(book).not.toHaveAttribute('data-status', 'no-market');
    await expect(book).toContainText('The market feed is not responding. Waiting for fresh prices.');
    expect(transport.evidence().paused).toBe(true);
    expect(transport.evidence().activeMarketConnections).toBeGreaterThan(0);
    expect(transport.evidence().errors).toEqual([]);
    const rpc = await page.evaluate(async () => {
      const response = await fetch('/rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      });
      return { status: response.status, body: await response.json() };
    });
    expect(rpc).toEqual({ status: 200, body: { jsonrpc: '2.0', id: 1, result: '0x7a69' } });
    expect(await requireOwnedRelay(page)).toEqual(owner);
    await page.screenshot({ path: info.outputPath('relay-unavailable.png') });
    await info.attach('real-relay-silence', {
      body: safeStringify({
        phase,
        owner,
        elapsedMs: Date.now() - started,
        before,
        orders,
        transport: transport.evidence(),
        rpc,
      }),
      contentType: 'application/json',
    });
  } finally {
    transport.resume();
  }
  expect(await requireOwnedRelay(page)).toEqual(owner);
  await expect(book).toHaveAttribute('data-status', 'live');
  await expect(book.getByTestId('book-row-ask')).toHaveCount(10);
  await expect(book.getByTestId('book-row-bid')).toHaveCount(10);
  expect(await readAccount(page, hubId)).toEqual(before);
  expect(await readOrders(page, hubId)).toEqual(orders);
  expect(transport.evidence().errors).toEqual([]);
  await page.screenshot({ path: info.outputPath('relay-recovered.png') });
  await info.attach('real-relay-recovered', {
    body: safeStringify({
      phase,
      owner,
      account: await readAccount(page, hubId),
      orders: await readOrders(page, hubId),
    }),
    contentType: 'application/json',
  });
}

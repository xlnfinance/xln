import { resolveOrderbookPriceReference } from '../../../core/swapbook/price-band';
import { verifyRelayRejection } from '../../utils/browser/market/relay-rejection';
import { verifyRelaySilence } from '../../utils/browser/market/relay-silence';
import { verifyAllBooks } from '../../utils/browser/swap-all-books';
import { verifySwapTokenSelection } from '../../utils/browser/swap-token-selection';
import { verifyBookSwitching } from '../../utils/browser/swap-book-switch';
import { verifyRestingLimit } from '../../utils/browser/swap-resting-limit';
import { verifyPriceBandRejection } from '../../utils/browser/swap-price-band';
import { safeStringify } from '../../../core/protocol/serialization';
import { verifySwapFlip } from '../../utils/browser/swap-flip';
import { executeBookFill, verifyBookFill } from '../../utils/browser/swap-book-fill';
import { createWalletIdentity, LOCAL_PASSWORD } from '../../../ui/tests/wallet-ui';
import { verifyRestingSwapCancellation } from '../../../ui/tests/swap-cancellation';
/**
 * E2E swap coverage for the live UI and the built-in browser scenarios.
 *
 * These tests verify that swap offers can auto-prepare missing token capacity, place and cancel
 * cleanly through the UI, and that the scenario runners still produce partial fills after reload-safe setup.
 */
import { test, expect, type Page } from '../../global-setup.mts';
import { Wallet } from 'ethers';
import { timedStep } from '../../utils/e2e-timing.mts';
import { APP_BASE_URL, API_BASE_URL, ensureE2EBaseline, getHealth } from '../../utils/e2e-baseline';
import { gotoApp as gotoSharedApp } from '../../utils/e2e-demo-users';
import { buildDefaultEntitySwapPairs } from '../../../core/account/utils';

const INIT_TIMEOUT = 30_000;
const CANONICAL_SWAP_PAIR_IDS = buildDefaultEntitySwapPairs().map(pair => pair.pairId);

function randomMnemonic(): string {
  const mnemonic = Wallet.createRandom().mnemonic;
  if (!mnemonic) throw new Error('TEST_WALLET_MNEMONIC_MISSING');
  return mnemonic.phrase;
}

async function expectMarketMakerBooksHealthy(page: Page): Promise<void> {
  const health = await getHealth(page, API_BASE_URL);
  expect(health?.marketMaker?.ok, 'market maker health must be ready').toBe(true);
  const hubs = health?.marketMaker?.hubs ?? [];
  expect(hubs.length, 'market maker health must expose 3 hubs').toBeGreaterThanOrEqual(3);
  for (const hub of hubs) {
    expect(hub.ready, `market maker hub ${hub.hubEntityId} must be ready`).toBe(true);
    expect(hub.depthReady, `market maker hub ${hub.hubEntityId} must expose exact configured depth`).toBe(true);
    expect((hub.pairs ?? []).map(pair => pair.pairId).sort()).toEqual([...CANONICAL_SWAP_PAIR_IDS].sort());
    let expectedHubOffers = 0;
    for (const pair of hub.pairs ?? []) {
      expect(pair.ready, `market maker pair ${pair.pairId} on hub ${hub.hubEntityId} must be ready`).toBe(true);
      expect(
        pair.depthReady,
        `market maker pair ${pair.pairId} on hub ${hub.hubEntityId} must expose exact configured depth`,
      ).toBe(true);
      expect(pair.expectedOffers, `market maker pair ${pair.pairId} must declare expected depth`).toBeGreaterThan(0);
      expect(pair.offers, `market maker pair ${pair.pairId} must contain only configured offers`).toBe(
        pair.expectedOffers,
      );
      expectedHubOffers += Number(pair.expectedOffers);
    }
    expect(hub.offers, `market maker hub ${hub.hubEntityId} must contain only configured offers`).toBe(
      expectedHubOffers,
    );
  }
}

test.describe('E2E Swap Flow', () => {
  test.setTimeout(240_000);

  test.beforeEach(async ({ page }) => {
    await timedStep('swap.ensure_baseline', () =>
      ensureE2EBaseline(page, {
        requireMarketMaker: true,
        requireHubMesh: true,
        minHubCount: 3,
      }),
    );
  });

  test(
    'swap shows visible depth on all canonical pairs and selected books',
    { tag: '@functional' },
    async ({ page }, info) => {
      await gotoSharedApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 0 });
      await createWalletIdentity(page, 'all-books', randomMnemonic());
      await expectMarketMakerBooksHealthy(page);
      await verifyAllBooks(page, info);
    },
  );

  test(
    'swap orderbook becomes unavailable when the real relay cannot answer',
    { tag: '@resilience' },
    async ({ page }, info) => {
      await gotoSharedApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 0 });
      await createWalletIdentity(page, 'relay-silence', randomMnemonic());
      await verifyRelaySilence(page, info);
    },
  );

  test(
    'swap clears a live book when the real relay stops publishing',
    { tag: '@resilience' },
    async ({ page }, info) => {
      await gotoSharedApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 0 });
      await createWalletIdentity(page, 'relay-live-silence', randomMnemonic());
      await verifyRelaySilence(page, info, 'live');
    },
  );

  test(
    'swap orderbook shows terminal error state when relay rejects the market subscription',
    { tag: '@resilience' },
    async ({ page }, info) => {
      await gotoSharedApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 0 });
      await createWalletIdentity(page, 'relay-rejection', randomMnemonic());
      await verifyRelayRejection(page, info);
    },
  );

  test(
    'swap orderbook pair dropdown updates same-chain form tokens',
    { tag: '@functional' },
    async ({ page }, info) => {
      await gotoSharedApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 0 });
      await createWalletIdentity(page, 'token-selection', randomMnemonic());
      await verifySwapTokenSelection(page, info);
    },
  );

  test('swap place WETH/USDC offer survives reload', { tag: '@resilience' }, async ({ page }, info) => {
    await gotoSharedApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 0 });
    const wallet = await createWalletIdentity(page, 'resting-reload', randomMnemonic());
    // Preserve the original best-ask minus0.01 limit and maximum25USDC order value.
    await verifyRestingLimit(page, info, wallet.entityId, 9_000_000_000_000_000n, price => price - 100n);
  });

  test('swap place and cancel from UI updates state machine', { tag: '@functional' }, async ({ page }, info) => {
    await verifyRestingSwapCancellation(page, info, expect, async () => {
      await gotoSharedApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 0 });
      const wallet = await createWalletIdentity(page, 'swap-cancel', randomMnemonic());
      await expect(page.getByTestId('account-row').first()).toBeVisible();
      return async () => {
        await page.getByRole('button', { name: 'Continue', exact: true }).click();
        await page.getByLabel('Password', { exact: true }).fill(LOCAL_PASSWORD);
        await page.getByRole('button', { name: 'Unlock', exact: true }).click();
        await page.getByTestId('nav-home').locator('visible=true').first().click();
        await expect(page.getByTestId('home-entity-id')).toHaveText(wallet.entityId);
        const runtimeId = await page.evaluate(() => {
          const debug = (window as Window & { __xln?: { adapter(): { runtimeId: string } | null } }).__xln;
          if (!debug) throw new Error('WALLET_DIAGNOSTICS_UNAVAILABLE');
          const adapter = debug.adapter();
          if (!adapter) throw new Error('RESTORED_SWAP_ADAPTER_MISSING');
          return adapter.runtimeId;
        });
        expect(runtimeId).toBe(wallet.runtimeId);
      };
    });
  });

  test(
    'swap orderbook lowest ask click fills immediately at displayed book price',
    { tag: '@functional' },
    async ({ page }, testInfo) => {
      await gotoSharedApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 0 });
      const wallet = await createWalletIdentity(page, 'book-ask', randomMnemonic());
      await expect(page.getByTestId('account-row').first()).toBeVisible();
      await verifyBookFill(page, testInfo, wallet.entityId, 'ask');
    },
  );

  test(
    'swap orderbook highest bid click fills immediately at displayed book price',
    { tag: '@functional' },
    async ({ page }, testInfo) => {
      await gotoSharedApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 0 });
      const wallet = await createWalletIdentity(page, 'book-bid', randomMnemonic());
      await expect(page.getByTestId('account-row').first()).toBeVisible();
      await verifyBookFill(page, testInfo, wallet.entityId, 'bid');
    },
  );

  test(
    'swap midpoint limit rests, survives reload and cancels without a worse fill',
    { tag: '@functional' },
    async ({ page }, info) => {
      await gotoSharedApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 0 });
      const wallet = await createWalletIdentity(page, 'midpoint-limit', randomMnemonic());
      await verifyRestingLimit(page, info, wallet.entityId, 5_000_000_000_000_000n, (ask, bid) => {
        const reference = resolveOrderbookPriceReference(bid, ask);
        expect(reference.label).toBe('midpoint');
        if (reference.anchor === null) throw new Error('MIDPOINT_LIMIT_UNAVAILABLE');
        expect(reference.anchor).toBeGreaterThan(bid);
        expect(reference.anchor).toBeLessThan(ask);
        return reference.anchor;
      });
    },
  );

  test(
    'swap flip keeps the displayed receive amount as the next source amount',
    { tag: '@functional' },
    async ({ page }, testInfo) => {
      await gotoSharedApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 0 });
      await createWalletIdentity(page, 'flip-ask', randomMnemonic());
      await expect(page.getByTestId('account-row').first()).toBeVisible();
      await verifySwapFlip(page, testInfo, 'ask');
    },
  );

  test(
    'swap flip keeps the sell-side displayed receive amount as the next source amount',
    { tag: '@functional' },
    async ({ page }, testInfo) => {
      await gotoSharedApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 0 });
      await createWalletIdentity(page, 'flip-bid', randomMnemonic());
      await expect(page.getByTestId('account-row').first()).toBeVisible();
      await verifySwapFlip(page, testInfo, 'bid');
    },
  );

  test(
    'swap can buy from asks and then sell back into bids on the same book',
    { tag: '@functional' },
    async ({ page }, info) => {
      await gotoSharedApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 0 });
      const wallet = await createWalletIdentity(page, 'book-roundtrip', randomMnemonic());
      await expect(page.getByTestId('account-row').first()).toBeVisible();
      const buy = await verifyBookFill(page, info, wallet.entityId, 'ask');
      await page.getByTestId('nav-home').locator('visible=true').first().click();
      const sell = await executeBookFill(page, info, wallet.entityId, buy.hubId, 'bid', 0);
      expect(sell.hubId).toBe(buy.hubId);
      expect(sell.before).toEqual(buy.after);
      expect(sell.orders.items).toHaveLength(2);
      expect(BigInt(sell.after.usdc)).toBe(BigInt(buy.before.usdc) - buy.debit + sell.received);
      expect(BigInt(sell.after.weth)).toBe(BigInt(buy.before.weth) + buy.received - sell.debit);
      expect(BigInt(sell.after.usdc)).toBeLessThan(BigInt(buy.before.usdc));
      expect(BigInt(sell.after.weth)).toBeGreaterThanOrEqual(0n);
      await info.attach('current-book-roundtrip', {
        body: safeStringify({ entityId: wallet.entityId, runtimeId: wallet.runtimeId, buy, sell }),
        contentType: 'application/json',
      });
    },
  );

  test(
    'swap manual price override after book click uses the edited limit price',
    { tag: '@functional' },
    async ({ page }, info) => {
      await gotoSharedApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 0 });
      const wallet = await createWalletIdentity(page, 'edited-limit', randomMnemonic());
      await verifyRestingLimit(page, info, wallet.entityId, 10_000_000_000_000_000n, price => (price * 99n) / 100n);
    },
  );

  test('swap rejects price beyond 30% from current orderbook', { tag: '@resilience' }, async ({ page }, info) => {
    await gotoSharedApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 0 });
    await createWalletIdentity(page, 'price-band-ask', randomMnemonic());
    await verifyPriceBandRejection(page, info, 'ask');
  });

  test('swap rejects sell price beyond 30% from current orderbook', { tag: '@resilience' }, async ({ page }, info) => {
    await gotoSharedApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 0 });
    await createWalletIdentity(page, 'price-band-bid', randomMnemonic());
    await verifyPriceBandRejection(page, info, 'bid');
  });

  test(
    'swap keeps a within-band wide limit as a resting order instead of filling immediately',
    { tag: '@functional' },
    async ({ page }, info) => {
      await gotoSharedApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 0 });
      const wallet = await createWalletIdentity(page, 'resting-spread', randomMnemonic());
      // Preserve the original absolute0.01-USDC price reduction, inside the live spread.
      await verifyRestingLimit(page, info, wallet.entityId, 5_000_000_000_000_000n, price => price - 100n);
    },
  );

  test(
    'swap scope and account switching clears stale rows and stale book hint state',
    { tag: '@resilience' },
    async ({ page }, info) => {
      await gotoSharedApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 0 });
      await createWalletIdentity(page, 'book-switch', randomMnemonic());
      await verifyBookSwitching(page, info);
    },
  );
});

import { AbiCoder } from 'ethers';
import { deriveDelta } from '../runtime/account/utils';
import {
  API_BASE_URL,
  CROSS_J_SOURCE_COMMITTED_OR_ADVANCED_STATUSES,
  CrossDeltaSnapshot,
  CrossResolveSnapshot,
  CrossRuntimeWindow,
  RuntimeIdentity,
  TOKEN_SYMBOL_BY_ID,
  USDC,
  WETH,
  configurePair,
  configureTokens,
  dismissSwapCompletionModal,
  escapeRegex,
  flushRuntime,
  injectSyntheticJEventThroughWatcher,
  openSwapWorkspace,
  selectCounterpartyInSwap,
  selectCrossRoute,
  selectSourceChainInSwap,
} from './e2e-cross-j-swap-helpers-a';
import { expect, type Page } from './global-setup.mts';
import { enqueueEntityTxs } from './utils/e2e-runtime-input';

export async function expectCrossOrderbookReady(
  page: Page,
  options: { titlePattern?: RegExp; pairIdPattern?: RegExp } = {},
): Promise<void> {
  const orderbook = page.getByTestId('swap-orderbook').first();
  await expect(orderbook, 'cross route must keep the right-side orderbook visible').toBeVisible({ timeout: 20_000 });
  const panel = orderbook.locator('.orderbook-panel').first();
  await expect(panel, 'cross route must render an orderbook panel').toBeVisible({ timeout: 20_000 });
  await expect
    .poll(async () => String((await panel.getAttribute('data-pair-id')) || ''), {
      timeout: 20_000,
      intervals: [100, 250, 500],
      message: 'cross route orderbook must subscribe to the cross venue id, not a numeric same-chain pair',
    })
    .toMatch(options.pairIdPattern ?? /^cross:/);
  await expect(
    page.locator('[data-testid="swap-market-section"] .book-toolbar strong').first(),
    'cross orderbook title must disambiguate token jurisdictions',
  ).toContainText(options.titlePattern ?? /\((Testnet|Tron)\)\s*-\s*.*\((Testnet|Tron)\)/, { timeout: 10_000 });
  const pairSelect = page.getByTestId('swap-orderbook-pair-select').first();
  await expect(pairSelect, 'cross orderbook pair selector must be present').toHaveCount(1, { timeout: 10_000 });
  await expect
    .poll(
      async () =>
        pairSelect.evaluate(node => {
          const select = node as HTMLSelectElement;
          return select.selectedOptions[0]?.textContent?.replace(/\s+/g, ' ').trim() || '';
        }),
      {
        timeout: 10_000,
        intervals: [100, 250, 500],
        message: 'cross orderbook selector must show Asset (Jurisdiction) - Asset (Jurisdiction)',
      },
    )
    .toMatch(options.titlePattern ?? /\((Testnet|Tron)\)\s*-\s*.*\((Testnet|Tron)\)/);
  await expect
    .poll(async () => String((await panel.getAttribute('data-source-status')) || ''), {
      timeout: 20_000,
      intervals: [250, 500, 1000],
      message: 'cross route orderbook must resolve to ready or an empty book instead of hanging in syncing',
    })
    .toMatch(/^(ready|empty)$/);
  const relayCheck = await page.evaluate(() => {
    const normalizeWs = (value: string): string => {
      const raw = String(value || '').trim();
      if (!raw) return '';
      const parsed = raw.startsWith('/') ? new URL(raw, window.location.origin) : new URL(raw);
      if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
      if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
      parsed.searchParams.set('protocol', 'market');
      return parsed.toString();
    };
    const panelEl = document.querySelector('[data-testid="swap-orderbook"] .orderbook-panel') as HTMLElement | null;
    const hubId =
      String(panelEl?.getAttribute('data-hub-ids') || '')
        .split(',')[0]
        ?.trim()
        .toLowerCase() || '';
    const relayUrl = normalizeWs(String(panelEl?.getAttribute('data-relay-url') || ''));
    const env = (window as CrossRuntimeWindow).isolatedEnv as any;
    const rawProfiles =
      typeof env?.gossip?.getProfiles === 'function' ? env.gossip.getProfiles() : env?.gossip?.profiles;
    const profiles =
      rawProfiles instanceof Map ? Array.from(rawProfiles.values()) : Array.isArray(rawProfiles) ? rawProfiles : [];
    const profile = profiles.find(
      (candidate: any) =>
        String(candidate?.entityId || '')
          .trim()
          .toLowerCase() === hubId && candidate?.metadata?.isHub === true,
    ) as any;
    const expectedRelayUrl = normalizeWs(
      String((Array.isArray(profile?.relays) ? profile.relays : []).find(Boolean) || ''),
    );
    return { hubId, relayUrl, expectedRelayUrl };
  });
  expect(relayCheck.hubId, 'cross orderbook must expose the selected book hub id').toMatch(/^0x[a-f0-9]{64}$/);
  const connectedRelay = new URL(relayCheck.relayUrl);
  expect(connectedRelay.pathname, 'cross orderbook must connect through the relay endpoint').toBe('/relay');
  expect(connectedRelay.searchParams.get('protocol'), 'cross orderbook must request the market relay protocol').toBe(
    'market',
  );
  if (relayCheck.expectedRelayUrl) {
    expect(relayCheck.relayUrl, 'cross orderbook relay must follow the selected book hub gossip relay').toBe(
      relayCheck.expectedRelayUrl,
    );
  }
  await expect(orderbook.getByTestId('orderbook-source-status').first()).not.toContainText(/syncing/i, {
    timeout: 5_000,
  });
}

export async function expectDirectCrossOrderbookReady(page: Page): Promise<void> {
  await expectCrossOrderbookReady(page);
}

export async function expectSwapTokens(page: Page, fromTokenId: number, toTokenId: number): Promise<void> {
  const fromSymbol = TOKEN_SYMBOL_BY_ID[fromTokenId];
  const toSymbol = TOKEN_SYMBOL_BY_ID[toTokenId];
  expect(fromSymbol, `missing token symbol for ${fromTokenId}`).toBeTruthy();
  expect(toSymbol, `missing token symbol for ${toTokenId}`).toBeTruthy();
  const fromToken = page.getByTestId('swap-ticket-from-token').first();
  const toToken = page.getByTestId('swap-ticket-to-token').first();
  await expect(fromToken).toHaveValue(String(fromTokenId), { timeout: 10_000 });
  await expect(toToken).toHaveValue(String(toTokenId), { timeout: 10_000 });
  await expect(fromToken.locator('option:checked')).toHaveText(fromSymbol!);
  await expect(toToken.locator('option:checked')).toHaveText(toSymbol!);
}

export async function expectSwapAssetRoute(
  page: Page,
  fromTokenId: number,
  sourceJurisdiction: string,
  toTokenId: number,
  targetJurisdiction: string,
): Promise<void> {
  await expectSwapTokens(page, fromTokenId, toTokenId);
  const routeFlow = page.getByTestId('swap-route-flow').first();
  await expect
    .poll(
      async () => ({
        mode: String((await routeFlow.getAttribute('data-route-mode')) || ''),
        sourceJurisdiction: String((await routeFlow.getAttribute('data-source-jurisdiction')) || ''),
        targetJurisdiction: String((await routeFlow.getAttribute('data-target-jurisdiction')) || ''),
      }),
      {
        timeout: 10_000,
        intervals: [100, 250, 500],
        message: 'swap asset identity must include both token and jurisdiction',
      },
    )
    .toMatchObject({
      mode: 'cross',
      sourceJurisdiction,
      targetJurisdiction,
    });
}

export function visibleOrderbookRow(page: Page, side: 'ask' | 'bid') {
  return page
    .getByTestId('swap-orderbook')
    .first()
    .getByTestId(side === 'ask' ? 'orderbook-ask-row' : 'orderbook-bid-row')
    .first();
}

export async function clickCrossOrderbookLevel(
  page: Page,
  side: 'ask' | 'bid',
  expectedFromTokenId: number,
  expectedToTokenId: number,
): Promise<void> {
  const row = visibleOrderbookRow(page, side);
  await expect(row, `cross ${side} row must be visible before clicking the orderbook`).toBeVisible({ timeout: 30_000 });
  const clickedDisplayedPrice = String((await row.locator('.price').textContent()) || '').trim();
  // A fill completed while this wallet was configuring the next order can
  // legitimately surface its confirmation dialog now. A real user closes it
  // before interacting with the book; the E2E must do the same, never click
  // through the modal overlay.
  await dismissSwapCompletionModal(page);
  await row.click({ timeout: 10_000 });
  await expectSwapTokens(page, expectedFromTokenId, expectedToTokenId);
  await expect
    .poll(async () => String(await page.getByTestId('swap-ticket-amount').first().inputValue()).trim(), {
      timeout: 10_000,
      intervals: [50, 100, 200],
    })
    .not.toBe('');
  if (clickedDisplayedPrice) {
    await expect
      .poll(async () => String(await page.getByTestId('swap-ticket-rate').first().inputValue()).trim(), {
        timeout: 10_000,
        intervals: [50, 100, 200],
      })
      .toBe(clickedDisplayedPrice.replace(/,/g, '').trim());
  }
}

export async function expectCrossNonTakeableClickNoop(
  page: Page,
  side: 'ask' | 'bid',
  expectedFromTokenId: number,
  expectedToTokenId: number,
): Promise<void> {
  const panel = page.getByTestId('swap-orderbook').locator('.orderbook-panel').first();
  const row = visibleOrderbookRow(page, side);
  await expect(row, `cross ${side} row must be visible to prove wrong-side click behavior`).toBeVisible({
    timeout: 20_000,
  });
  const before = {
    pairId: String((await panel.getAttribute('data-pair-id')) || ''),
    hubIds: String((await panel.getAttribute('data-hub-ids')) || ''),
    amount: String(await page.getByTestId('swap-ticket-amount').first().inputValue()).trim(),
    price: String(await page.getByTestId('swap-ticket-rate').first().inputValue()).trim(),
  };
  expect(before.pairId, 'cross wrong-side click guard needs an active cross venue').toMatch(/^cross:/);

  await row.click({ timeout: 10_000 });
  await expectSwapTokens(page, expectedFromTokenId, expectedToTokenId);
  await expect
    .poll(async () => String((await panel.getAttribute('data-pair-id')) || ''), {
      timeout: 5_000,
      intervals: [50, 100, 200],
      message: 'cross wrong-side click must not switch the visible venue',
    })
    .toBe(before.pairId);
  await expect
    .poll(async () => String((await panel.getAttribute('data-hub-ids')) || ''), {
      timeout: 5_000,
      intervals: [50, 100, 200],
      message: 'cross wrong-side click must not switch the visible book hub',
    })
    .toBe(before.hubIds);
  await expect
    .poll(async () => String(await page.getByTestId('swap-ticket-amount').first().inputValue()).trim(), {
      timeout: 5_000,
      intervals: [50, 100, 200],
      message: 'cross wrong-side click must not pin an amount from a non-takeable level',
    })
    .toBe(before.amount);
  await expect
    .poll(async () => String(await page.getByTestId('swap-ticket-rate').first().inputValue()).trim(), {
      timeout: 5_000,
      intervals: [50, 100, 200],
      message: 'cross wrong-side click must not pin a stale price from another route',
    })
    .toBe(before.price);
}

export async function placeCrossOrder(
  page: Page,
  params: {
    source: RuntimeIdentity;
    hubId: string;
    targetEntityId: string;
    side: 'buy' | 'sell';
    amount?: string;
    price?: string;
    fromTokenId?: number;
    toTokenId?: number;
    clickBookSide?: 'ask' | 'bid';
    expectedClickFromTokenId?: number;
    expectedClickToTokenId?: number;
    checkMultihopDeferred?: boolean;
    expectSetupConsent?: boolean;
    expectedBookDepth?: number;
    expectedAutoAmount?: number;
    screenshotPath?: string;
  },
): Promise<string> {
  const flowStartedAt = Date.now();
  const emitPhaseTiming = (phase: string, startedAt: number): void => {
    console.log(`[E2E-TIMING] cross_j_order.${phase} ${Date.now() - startedAt}ms`);
  };
  await openSwapWorkspace(page);
  await dismissSwapCompletionModal(page);
  await selectSourceChainInSwap(page, params.source.entityId);
  await selectCounterpartyInSwap(page, params.hubId);
  if (params.fromTokenId && params.toTokenId && params.fromTokenId === params.toTokenId) {
    await selectCrossRoute(page, params.targetEntityId);
    await configureTokens(page, params.fromTokenId, params.toTokenId);
  } else {
    await configurePair(page, params.side);
    await selectCrossRoute(page, params.targetEntityId);
  }
  await expectCrossOrderbookReady(page);
  if (params.expectedBookDepth) {
    const orderbook = page.getByTestId('swap-orderbook').first();
    await expect(orderbook.getByTestId('orderbook-ask-row')).toHaveCount(params.expectedBookDepth, { timeout: 30_000 });
    await expect(orderbook.getByTestId('orderbook-bid-row')).toHaveCount(params.expectedBookDepth, { timeout: 30_000 });
    const displayedSizes = await orderbook.locator('.size').allTextContents();
    expect(displayedSizes, 'stable cross MM depth should be visibly sized in thousands of tokens').toEqual(
      expect.arrayContaining([expect.stringMatching(/K$/)]),
    );
    expect(displayedSizes, 'cross MM sizes must never expose raw million-lot counts').not.toEqual(
      expect.arrayContaining([expect.stringMatching(/M$/)]),
    );
  }
  await dismissSwapCompletionModal(page);
  if (params.checkMultihopDeferred) {
    await expectDirectCrossOrderbookReady(page);
    await expectCrossOrderbookReady(page);
  }
  if (params.expectedAutoAmount !== undefined) {
    await expect
      .poll(
        async () => Number(String(await page.getByTestId('swap-ticket-amount').first().inputValue()).replace(/,/g, '')),
        {
          timeout: 10_000,
          intervals: [50, 100, 200],
          message: 'opening the swap form must default to 100% canonical source capacity',
        },
      )
      .toBeCloseTo(params.expectedAutoAmount, 6);
  }
  if (params.clickBookSide) {
    const expectedFromTokenId = params.expectedClickFromTokenId ?? (params.clickBookSide === 'ask' ? USDC : WETH);
    const expectedToTokenId = params.expectedClickToTokenId ?? (params.clickBookSide === 'ask' ? WETH : USDC);
    await clickCrossOrderbookLevel(page, params.clickBookSide, expectedFromTokenId, expectedToTokenId);
  }
  const amountInput = page.getByTestId('swap-ticket-amount').first();
  const priceInput = page.getByTestId('swap-ticket-rate').first();
  const submit = page.getByTestId('swap-ticket-submit').first();
  await expect(amountInput).toBeVisible({ timeout: 20_000 });
  await expect(priceInput).toBeVisible({ timeout: 20_000 });
  const beforeSubmit = await readCrossState(page, params.source, params.hubId);
  const beforeHeight = beforeSubmit.currentHeight;
  const beforeRouteIds = new Set(beforeSubmit.routeSummaries.map(route => route.orderId));
  const beforeOfferIds = new Set(beforeSubmit.offerSummaries.map(offer => offer.offerId));
  const beforeMessageCount = beforeSubmit.messages.length;
  if (params.amount !== undefined) {
    await amountInput.fill(params.amount);
    await expect
      .poll(() => amountInput.inputValue(), {
        timeout: 10_000,
        intervals: [50, 100, 250],
        message: 'manual cross-j amount must remain owned by the user after reactive route updates',
      })
      .toBe(params.amount);
  } else {
    const autoAmount = Number(String(await amountInput.inputValue()).replace(/,/g, ''));
    expect(autoAmount, 'book click must populate a positive source amount').toBeGreaterThan(0);
    if (params.expectedAutoAmount !== undefined) {
      expect(autoAmount, 'book click must size from the full canonical source capacity').toBeCloseTo(
        params.expectedAutoAmount,
        6,
      );
    }
  }
  if (params.screenshotPath) {
    await page.screenshot({ path: params.screenshotPath, fullPage: true });
  }
  if (params.price !== undefined) await priceInput.fill(params.price);
  if (params.expectSetupConsent) {
    const consent = page.getByTestId('swap-setup-consent').first();
    await expect(consent, 'one-click cross swap must disclose automatic target setup').toBeVisible({ timeout: 10_000 });
    await expect(
      consent.getByTestId('swap-setup-step'),
      'target setup disclosure must include account + credit steps',
    ).toHaveCount(2, { timeout: 10_000 });
    await expect(
      consent.locator('[data-step-id="target-account"]'),
      'target account setup step must be visible',
    ).toContainText('Create target account');
    await expect(
      consent.locator('[data-step-id="target-credit"]'),
      'target credit setup step must be visible',
    ).toContainText('Set inbound credit limit');
    const errorText = (await page.getByTestId('swap-ticket-error').allTextContents()).join('\n');
    expect(errorText, 'auto-setup must replace the old manual create-account blocker').not.toMatch(
      /create target account|account setup required/i,
    );
  }
  await expect
    .poll(
      async () => {
        const routePicker = page.getByTestId('swap-route-picker').first();
        const [receive, formErrorParts, amountState, parsedGiveAmount, canonicalGiveAmount] = await Promise.all([
          page.getByTestId('swap-ticket-receive-amount').first().locator('.swap-ticket-receive-value').textContent(),
          page.getByTestId('swap-ticket-error').allTextContents(),
          routePicker.getAttribute('data-order-amount-state'),
          routePicker.getAttribute('data-give-amount'),
          routePicker.getAttribute('data-canonical-give-amount'),
        ]);
        const diagnostics = {
          receive,
          formError: formErrorParts.join('\n').trim(),
          amountState,
          parsedGiveAmount,
          canonicalGiveAmount,
          price: await priceInput.inputValue(),
          giveToken: await routePicker.getAttribute('data-give-token'),
          wantToken: await routePicker.getAttribute('data-want-token'),
          giveDecimals: await routePicker.getAttribute('data-give-decimals'),
        };
        const ready =
          Number(String(receive || '0').replace(/,/g, '')) > 0 &&
          diagnostics.formError === '' &&
          parsedGiveAmount !== null &&
          parsedGiveAmount !== '0' &&
          canonicalGiveAmount !== null &&
          canonicalGiveAmount !== '0';
        return {
          ready,
          diagnostics: ready ? '' : JSON.stringify(diagnostics),
        };
      },
      {
        timeout: 10_000,
        intervals: [50, 100, 250],
        message: 'cross-j manual amount must reach the canonical form state before submit',
      },
    )
    .toEqual({ ready: true, diagnostics: '' });
  await expect(submit).toBeEnabled({ timeout: 30_000 });
  emitPhaseTiming('pre_submit', flowStartedAt);
  const clickStartedAt = Date.now();
  await page.evaluate(() => {
    (window as CrossRuntimeWindow & { __crossJClickAt?: number }).__crossJClickAt = Date.now();
  });
  await submit.click();
  emitPhaseTiming('click_dispatch', clickStartedAt);
  let lastSubmitState: unknown = null;
  let createdOrderId = '';
  try {
    await expect
      .poll(
        async () => {
          const state = await readCrossState(page, params.source, params.hubId);
          const newRoutes = state.routeSummaries.filter(route => !beforeRouteIds.has(route.orderId));
          const newOffers = state.offerSummaries.filter(offer => !beforeOfferIds.has(offer.offerId));
          const newMessages = state.messages.slice(beforeMessageCount);
          const formError = await page
            .getByTestId('swap-ticket-error')
            .first()
            .textContent()
            .catch(() => '');
          const formValues = await page.evaluate(() => {
            const amount = document.querySelector<HTMLInputElement>('[data-testid="swap-ticket-amount"]')?.value || '';
            const price = document.querySelector<HTMLInputElement>('[data-testid="swap-ticket-rate"]')?.value || '';
            const view = window as CrossRuntimeWindow & { __xln_env?: any };
            const summarizeEnv = (env: any) => ({
              runtimeId: String(env?.runtimeId || ''),
              height: Number(env?.height || 0),
              timestamp: Number(env?.timestamp || 0),
              scenarioMode: Boolean(env?.scenarioMode),
              loopActive: Boolean(env?.runtimeState?.loopActive),
              wakeRequested: Boolean(env?.runtimeState?.wakeRequested),
              processing: Boolean(env?.runtimeState?.processingPromise),
              lastProcessEnteredAt: Number(env?.lastProcessEnteredAt || 0),
              lastFrameAt: Number(env?.runtimeState?.lastFrameAt || 0),
              minFrameDelayMs: Number(env?.runtimeConfig?.minFrameDelayMs || 0),
              queuedAt: Number(env?.runtimeMempool?.queuedAt || 0),
              runtimeInputTypes: Array.from(env?.runtimeInput?.entityInputs || []).map((input: any) => ({
                entityId: String(input?.entityId || '').slice(-8),
                txTypes: Array.from(input?.entityTxs || []).map((tx: any) => String(tx?.type || '')),
              })),
              mempoolTypes: Array.from(env?.runtimeMempool?.entityInputs || []).map((input: any) => ({
                entityId: String(input?.entityId || '').slice(-8),
                txTypes: Array.from(input?.entityTxs || []).map((tx: any) => String(tx?.type || '')),
              })),
            });
            return {
              amount,
              price,
              isolated: summarizeEnv(view.isolatedEnv),
              live: summarizeEnv(view.__xln_env),
            };
          });
          lastSubmitState = {
            ok: newRoutes.length > 0 || newOffers.length > 0,
            routes: state.routes,
            offers: state.offers,
            newRoutes: newRoutes.map(route => ({ orderId: route.orderId, status: route.status })),
            newOffers: newOffers.map(offer => ({ offerId: offer.offerId, status: offer.status })),
            formError: String(formError || '').trim(),
            formValues,
            recentMessages: state.messages.slice(-8),
          };
          createdOrderId = newRoutes[0]?.orderId || newOffers[0]?.offerId || '';
          return lastSubmitState;
        },
        {
          message: 'cross-j order submit must create a route or a cross-j offer in live runtime',
          timeout: 30_000,
          intervals: [500, 1_000, 2_000],
        },
      )
      .toMatchObject({ ok: true });
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nlastSubmitState=${JSON.stringify(lastSubmitState, null, 2)}`,
    );
  }
  expect(createdOrderId, 'cross-j order submit must return exact created orderId').toBeTruthy();
  emitPhaseTiming('click_to_route', clickStartedAt);
  const browserMeasures = await page.evaluate(() =>
    performance
      .getEntriesByType('measure')
      .filter(entry => entry.name.startsWith('xln.cross_j.'))
      .slice(-8)
      .map(entry => ({ name: entry.name, duration: Math.round(entry.duration) })),
  );
  for (const measure of browserMeasures) {
    console.log(`[E2E-TIMING] ${measure.name} ${measure.duration}ms`);
  }
  let lastCommitState: unknown = null;
  try {
    await expect
      .poll(
        async () => {
          await flushRuntime(page, 1);
          const state = await readCrossState(page, params.source, params.hubId);
          lastCommitState = {
            currentHeight: state.currentHeight,
            beforeHeight,
            hasPendingFrame: state.hasPendingFrame,
            pendingTxs: state.pendingTxs,
            mempoolTxs: state.mempoolTxs,
            offers: state.offers,
            route: state.routeSummaries.find(route => route.orderId === createdOrderId) || null,
            pendingOutputs: state.pendingOutputs,
            pendingNetworkOutputs: state.pendingNetworkOutputs,
            runtimeMempoolInputs: state.runtimeMempoolInputs,
            p2pState: state.p2pState,
            recoveryBarrier: state.recoveryBarrier,
            messages: state.messages.slice(-10),
          };
          const route = state.routeSummaries.find(candidate => candidate.orderId === createdOrderId);
          // The User Runtime commits both Account legs atomically after matching
          // the Hub-signed proposal pair. The human-readable terminal message is
          // emitted later by the Hub when both ACKs commit, so waiting for the old
          // source-only message here adds a protocol round trip that no longer
          // exists. The paired pull bindings and canonical route status are the
          // state-level proof of User-side admission.
          const accountPairCommittedOrAdvanced =
            Boolean(route?.sourcePull && route?.targetPull) &&
            CROSS_J_SOURCE_COMMITTED_OR_ADVANCED_STATUSES.has(String(route?.status || ''));
          const sourceQueuesDrained =
            !state.hasPendingFrame &&
            state.pendingTxs.length === 0 &&
            state.mempoolTxs.length === 0 &&
            state.runtimeMempoolInputs.length === 0;
          return {
            committed: state.currentHeight > beforeHeight && accountPairCommittedOrAdvanced && sourceQueuesDrained,
            currentHeight: state.currentHeight,
            hasPendingFrame: state.hasPendingFrame,
            routeStatus: route?.status || '',
            sourcePull: Boolean(route?.sourcePull),
            targetPull: Boolean(route?.targetPull),
          };
        },
        {
          message: `cross-j order ${createdOrderId} must reach source-committed state before matching or advance through a valid fill path`,
          timeout: 75_000,
          intervals: [250, 500, 1000],
        },
      )
      .toMatchObject({ committed: true });
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nlastCommitState=${JSON.stringify(lastCommitState, null, 2)}`,
    );
  }
  emitPhaseTiming('click_to_source_commit', clickStartedAt);
  return createdOrderId;
}

export async function readCrossState(
  page: Page,
  identity: RuntimeIdentity,
  hubId: string,
): Promise<{
  offers: number;
  routes: number;
  pulls: number;
  currentHeight: number;
  hasPendingFrame: boolean;
  pendingTxs: string[];
  mempoolTxs: string[];
  settledRoutes: number;
  claimedRoutes: number;
  replicaFound: boolean;
  accountFound: boolean;
  accountKeys: string[];
  messages: string[];
  routeSummaries: Array<{
    orderId: string;
    status: string;
    fillSeq: number;
    cumulativeFillRatio: number;
    filledSourceAmount: string;
    filledTargetAmount: string;
    sourcePull: boolean;
    targetPull: boolean;
    sourcePullId: string;
    targetPullId: string;
    bookOwnerEntityId: string;
    sourceEntityId: string;
    sourceCounterpartyEntityId: string;
    targetEntityId: string;
    targetCounterpartyEntityId: string;
    venueId: string;
    priceTicks: string;
    pendingClearRequestedAt: number;
    updatedAt: number;
  }>;
  offerSummaries: Array<{
    offerId: string;
    status: string;
    amount: string;
    cross: boolean;
  }>;
  pullIds: string[];
  pendingOutputs: Array<{ entityId: string; signerId: string; txTypes: string[]; frame: boolean; precommits: number }>;
  pendingNetworkOutputs: Array<{
    entityId: string;
    signerId: string;
    runtimeId: string;
    txTypes: string[];
    frame: boolean;
    precommits: number;
  }>;
  runtimeMempoolInputs: Array<{
    entityId: string;
    signerId: string;
    txTypes: string[];
    frame: boolean;
    precommits: number;
  }>;
  p2pState: { exists: boolean; connected: boolean; queue: unknown; directPeers: unknown };
  recoveryBarrier: boolean;
  ownerIsLeft: boolean;
  deltas: Record<string, CrossDeltaSnapshot>;
  currentFrameFees: Record<string, string>;
}> {
  return await page.evaluate(
    ({ identity, hubId }) => {
      const env = (window as CrossRuntimeWindow).isolatedEnv;
      const entityNeedle = String(identity.entityId || '').toLowerCase();
      const signerNeedle = String(identity.signerId || '').toLowerCase();
      const hubNeedle = String(hubId || '').toLowerCase();
      let replica = env?.eReplicas?.get(`${entityNeedle}:${signerNeedle}`);
      if (!replica && env?.eReplicas instanceof Map) {
        for (const [key, candidate] of env.eReplicas.entries()) {
          const keyText = String(key || '').toLowerCase();
          const candidateEntity = String(candidate?.state?.entityId || candidate?.entityId || '').toLowerCase();
          const candidateSigner = String(candidate?.signerId || '').toLowerCase();
          if (
            candidateEntity === entityNeedle ||
            keyText.startsWith(`${entityNeedle}:`) ||
            (keyText.includes(entityNeedle) &&
              (!signerNeedle || keyText.includes(signerNeedle) || candidateSigner === signerNeedle))
          ) {
            replica = candidate;
            break;
          }
        }
      }
      const state = replica?.state;
      let account = state?.accounts?.get(hubId) || state?.accounts?.get(hubNeedle);
      if (!account && state?.accounts instanceof Map) {
        for (const [key, candidate] of state.accounts.entries()) {
          const keyText = String(key || '').toLowerCase();
          const left = String(candidate?.leftEntity || '').toLowerCase();
          const right = String(candidate?.rightEntity || '').toLowerCase();
          const cp = String(candidate?.counterpartyEntityId || '').toLowerCase();
          if (keyText === hubNeedle || cp === hubNeedle || left === hubNeedle || right === hubNeedle) {
            account = candidate;
            break;
          }
        }
      }
      let offers = 0;
      for (const offer of account?.swapOffers?.values?.() || []) {
        if (offer?.crossJurisdiction) offers += 1;
      }
      let settledRoutes = 0;
      let claimedRoutes = 0;
      const routeSummaries = [];
      for (const route of state?.crossJurisdictionSwaps?.values?.() || []) {
        const status = String(route?.status || '');
        const orderId = String(route?.orderId || '');
        const filledTargetAmount = BigInt(route?.filledTargetAmount ?? route?.targetClaimed ?? 0n);
        if (status === 'settled') settledRoutes += 1;
        if (status === 'source_claimed' || status === 'target_claimed' || status === 'settled') claimedRoutes += 1;
        routeSummaries.push({
          orderId,
          status,
          fillSeq: Number(route?.fillSeq || 0),
          cumulativeFillRatio: Number(route?.cumulativeFillRatio || route?.claimedRatio || 0),
          filledSourceAmount: String(route?.filledSourceAmount ?? route?.sourceClaimed ?? '0'),
          filledTargetAmount: String(filledTargetAmount),
          sourcePull: Boolean(route?.sourcePull),
          targetPull: Boolean(route?.targetPull),
          sourcePullId: String(route?.sourcePull?.pullId || ''),
          targetPullId: String(route?.targetPull?.pullId || ''),
          bookOwnerEntityId: String(route?.bookOwnerEntityId || route?.source?.counterpartyEntityId || ''),
          sourceEntityId: String(route?.source?.entityId || ''),
          sourceCounterpartyEntityId: String(route?.source?.counterpartyEntityId || ''),
          targetEntityId: String(route?.target?.entityId || ''),
          targetCounterpartyEntityId: String(route?.target?.counterpartyEntityId || ''),
          venueId: String(route?.venueId || ''),
          priceTicks: String(route?.priceTicks ?? '0'),
          pendingClearRequestedAt: Number(route?.pendingClearRequestedAt || 0),
          updatedAt: Number(route?.updatedAt || route?.createdAt || 0),
        });
      }
      return {
        offers,
        routes: Number(state?.crossJurisdictionSwaps?.size || 0),
        pulls: Number(account?.pulls?.size || 0),
        currentHeight: Number(account?.currentHeight || 0),
        hasPendingFrame: Boolean(account?.pendingFrame),
        pendingTxs: Array.from(account?.pendingFrame?.accountTxs || []).map((tx: any) => String(tx?.type || '')),
        mempoolTxs: Array.from(account?.mempool || []).map((tx: any) => String(tx?.type || '')),
        settledRoutes,
        claimedRoutes,
        replicaFound: Boolean(replica),
        accountFound: Boolean(account),
        accountKeys: Array.from(state?.accounts?.keys?.() || []).map((key: unknown) => String(key)),
        messages: Array.from(state?.messages || []).map((message: unknown) => String(message)),
        routeSummaries,
        offerSummaries: Array.from(account?.swapOffers?.entries?.() || []).map(([offerId, offer]: [string, any]) => ({
          offerId: String(offerId),
          status: String(offer?.crossJurisdiction?.status || ''),
          amount: String(offer?.amount ?? '0'),
          cross: Boolean(offer?.crossJurisdiction),
        })),
        pullIds: Array.from(account?.pulls?.keys?.() || []).map((pullId: unknown) => String(pullId)),
        pendingOutputs: Array.from(env?.pendingOutputs || []).map((input: any) => ({
          entityId: String(input?.entityId || ''),
          signerId: String(input?.signerId || ''),
          txTypes: Array.from(input?.entityTxs || []).map((tx: any) => String(tx?.type || '')),
          frame: Boolean(input?.proposedFrame),
          precommits: Number(input?.hashPrecommits?.size || 0),
        })),
        pendingNetworkOutputs: Array.from(env?.pendingNetworkOutputs || []).map((input: any) => ({
          entityId: String(input?.entityId || ''),
          signerId: String(input?.signerId || ''),
          runtimeId: String(input?.runtimeId || ''),
          txTypes: Array.from(input?.entityTxs || []).map((tx: any) => String(tx?.type || '')),
          frame: Boolean(input?.proposedFrame),
          precommits: Number(input?.hashPrecommits?.size || 0),
        })),
        runtimeMempoolInputs: Array.from(
          env?.runtimeMempool?.entityInputs || env?.runtimeInput?.entityInputs || [],
        ).map((input: any) => ({
          entityId: String(input?.entityId || ''),
          signerId: String(input?.signerId || ''),
          txTypes: Array.from(input?.entityTxs || []).map((tx: any) => String(tx?.type || '')),
          frame: Boolean(input?.proposedFrame),
          precommits: Number(input?.hashPrecommits?.size || 0),
        })),
        p2pState: {
          exists: Boolean(env?.runtimeState?.p2p),
          connected: Boolean(env?.runtimeState?.p2p?.isConnected?.()),
          queue: env?.runtimeState?.p2p?.getQueueState?.() || null,
          directPeers: env?.runtimeState?.p2p?.getDirectPeerState?.() || null,
        },
        recoveryBarrier: Boolean(env?.runtimeState?.recoveryBackupBarrier),
        ownerIsLeft: entityNeedle === String(account?.leftEntity || '').toLowerCase(),
        currentFrameFees: Array.from(account?.currentFrame?.accountTxs || []).reduce(
          (fees: Record<string, string>, tx: any) => {
            const tokenId = Number(tx?.data?.feeTokenId ?? -1);
            const feeAmount = BigInt(tx?.data?.feeAmount ?? 0n);
            if (tokenId < 0 || feeAmount <= 0n) return fees;
            const key = String(tokenId);
            fees[key] = String(BigInt(fees[key] ?? '0') + feeAmount);
            return fees;
          },
          {},
        ),
        deltas: Object.fromEntries(
          Array.from(account?.deltas?.entries?.() || []).map(([tokenId, delta]: [unknown, any]) => [
            String(tokenId),
            {
              tokenId: Number(tokenId),
              collateral: String(delta?.collateral ?? 0n),
              ondelta: String(delta?.ondelta ?? 0n),
              offdelta: String(delta?.offdelta ?? 0n),
              leftCreditLimit: String(delta?.leftCreditLimit ?? 0n),
              rightCreditLimit: String(delta?.rightCreditLimit ?? 0n),
              leftAllowance: String(delta?.leftAllowance ?? 0n),
              rightAllowance: String(delta?.rightAllowance ?? 0n),
              leftHold: String(delta?.leftHold ?? 0n),
              rightHold: String(delta?.rightHold ?? 0n),
            },
          ]),
        ),
      };
    },
    { identity, hubId },
  );
}

export async function readHubCrossDeltas(
  page: Page,
  hubEntityId: string,
  counterpartyEntityId: string,
  tokenIds: readonly number[],
): Promise<Record<string, CrossDeltaSnapshot>> {
  const response = await page.request.get(`${API_BASE_URL}/api/hub/account-status`, {
    params: {
      hubEntityId,
      counterpartyEntityId,
      tokenIds: tokenIds.join(','),
    },
  });
  const body = (await response.json().catch(() => null)) as any;
  expect(response.ok(), `hub Account financial status failed: ${JSON.stringify(body)}`).toBe(true);
  expect(body?.success).toBe(true);
  return Object.fromEntries(
    (Array.isArray(body?.tokens) ? body.tokens : []).map((token: any) => [
      String(token?.tokenId),
      {
        ...token?.delta,
        tokenId: Number(token?.tokenId),
        leftAllowance: String(token?.delta?.leftAllowance ?? 0),
        rightAllowance: String(token?.delta?.rightAllowance ?? 0),
      },
    ]),
  );
}

export function expectCrossTransfer(
  before: CrossDeltaSnapshot,
  after: CrossDeltaSnapshot,
  amount: bigint,
  ownerIsLeft: boolean,
  direction: 'spend' | 'receive',
  label: string,
  feeAmount = 0n,
): void {
  expect(amount, `${label} amount must be positive`).toBeGreaterThan(0n);
  expect(feeAmount, `${label} fee must not be negative`).toBeGreaterThanOrEqual(0n);
  expect(feeAmount, `${label} fee must not consume the transfer`).toBeLessThan(amount);
  const canonicalSign = direction === 'spend' ? (ownerIsLeft ? -1n : 1n) : ownerIsLeft ? 1n : -1n;
  const deriveSnapshot = (snapshot: CrossDeltaSnapshot) =>
    deriveDelta(
      {
        tokenId: snapshot.tokenId,
        collateral: BigInt(snapshot.collateral),
        ondelta: BigInt(snapshot.ondelta),
        offdelta: BigInt(snapshot.offdelta),
        leftCreditLimit: BigInt(snapshot.leftCreditLimit),
        rightCreditLimit: BigInt(snapshot.rightCreditLimit),
        leftAllowance: BigInt(snapshot.leftAllowance),
        rightAllowance: BigInt(snapshot.rightAllowance),
        leftHold: BigInt(snapshot.leftHold),
        rightHold: BigInt(snapshot.rightHold),
      },
      ownerIsLeft,
    );
  expect(
    deriveSnapshot(after).delta - deriveSnapshot(before).delta,
    `${label} must apply the exact canonical delta net of its signed fee`,
  ).toBe(canonicalSign * (amount - feeAmount));
  expect({ leftHold: after.leftHold, rightHold: after.rightHold }, `${label} must clear both bilateral holds`).toEqual({
    leftHold: '0',
    rightHold: '0',
  });
}

export async function waitForCrossPullFlow(
  page: Page,
  source: RuntimeIdentity,
  target: RuntimeIdentity,
  sourceHubId: string,
  targetHubId: string,
  options: { sourceRouteId?: string; targetRouteId?: string } = {},
): Promise<void> {
  try {
    await expect
      .poll(
        async () => {
          const sourceState = await readCrossState(page, source, sourceHubId);
          const targetState = await readCrossState(page, target, targetHubId);
          const sourceRoute = options.sourceRouteId
            ? sourceState.routeSummaries.find(route => route.orderId === options.sourceRouteId)
            : sourceState.routeSummaries.find(
                route =>
                  route.sourcePull ||
                  route.targetPull ||
                  ['source_claimed', 'target_claimed', 'settled'].includes(route.status),
              );
          const targetRoute = options.targetRouteId
            ? targetState.routeSummaries.find(route => route.orderId === options.targetRouteId)
            : targetState.routeSummaries.find(
                route =>
                  route.sourcePull ||
                  route.targetPull ||
                  ['source_claimed', 'target_claimed', 'settled'].includes(route.status),
              );
          const routeHasProgress = (route: typeof sourceRoute): boolean =>
            Boolean(route) &&
            (route.cumulativeFillRatio > 0 || ['source_claimed', 'target_claimed', 'settled'].includes(route.status));
          const targetHasDurablePreparedPull = Boolean(
            targetRoute?.targetPullId &&
            targetState.pullIds.includes(targetRoute.targetPullId) &&
            [
              'target_prepared',
              'source_committed',
              'target_locked',
              'resting',
              'partially_filled',
              'clear_requested',
              'clearing',
            ].includes(targetRoute.status),
          );
          const sourceHasCommittedFill = routeHasProgress(sourceRoute);
          const targetHasClaimedFill = routeHasProgress(targetRoute);
          const targetHasPreparedOrClaimedPull = targetHasDurablePreparedPull || targetHasClaimedFill;
          return {
            ok: sourceHasCommittedFill && targetHasPreparedOrClaimedPull,
            sourceHasCommittedFill,
            targetHasDurablePreparedPull,
            targetHasClaimedFill,
            targetHasPreparedOrClaimedPull,
            sourceRouteStatus: sourceRoute?.status || '',
            targetRouteStatus: targetRoute?.status || '',
            sourceRouteId: sourceRoute?.orderId || '',
            targetRouteId: targetRoute?.orderId || '',
            sourceRoutes: sourceState.routes,
            targetRoutes: targetState.routes,
            sourcePulls: sourceState.pulls,
            targetPulls: targetState.pulls,
            sourceClaimed: sourceState.claimedRoutes,
            targetClaimed: targetState.claimedRoutes,
            sourceReplicaFound: sourceState.replicaFound,
            sourceAccountFound: sourceState.accountFound,
            targetReplicaFound: targetState.replicaFound,
            targetAccountFound: targetState.accountFound,
            sourceAccountKeys: sourceState.accountKeys,
            targetAccountKeys: targetState.accountKeys,
          };
        },
        {
          timeout: 60_000,
          intervals: [250, 500, 1000],
          message: 'cross-j match must materialize prepared pull routes or settled pull claims',
        },
      )
      .toMatchObject({
        ok: true,
        sourceHasCommittedFill: true,
        targetHasPreparedOrClaimedPull: true,
      });
  } catch (error) {
    const [sourceState, targetState] = await Promise.all([
      readCrossState(page, source, sourceHubId),
      readCrossState(page, target, targetHubId),
    ]);
    const replicas = await page.evaluate(() => {
      const env = (window as CrossRuntimeWindow).isolatedEnv;
      return Array.from(env?.eReplicas?.entries?.() || []).map(([key, replica]: [string, any]) => {
        const state = replica?.state;
        return {
          key: String(key || ''),
          entityId: String(state?.entityId || replica?.entityId || ''),
          signerId: String(replica?.signerId || ''),
          profileName: String(state?.profile?.name || ''),
          jurisdiction: String(state?.config?.jurisdiction?.name || ''),
          accounts: Array.from(state?.accounts?.entries?.() || []).map(([accountId, account]: [string, any]) => ({
            accountId: String(accountId || ''),
            currentHeight: Number(account?.currentHeight || 0),
            mempool: Array.from(account?.mempool || []).map((tx: any) => String(tx?.type || '')),
            pendingFrame: Array.from(account?.pendingFrame?.accountTxs || []).map((tx: any) => String(tx?.type || '')),
            offers: Array.from(account?.swapOffers?.entries?.() || []).map(([offerId, offer]: [string, any]) => ({
              offerId: String(offerId || ''),
              cross: Boolean(offer?.crossJurisdiction),
              status: String(offer?.crossJurisdiction?.status || ''),
            })),
            pulls: Array.from(account?.pulls?.keys?.() || []).map(String),
          })),
          routes: Array.from(state?.crossJurisdictionSwaps?.entries?.() || []).map(
            ([orderId, route]: [string, any]) => ({
              orderId: String(orderId || ''),
              status: String(route?.status || ''),
              source: String(route?.source?.entityId || ''),
              sourceHub: String(route?.source?.counterpartyEntityId || ''),
              targetHub: String(route?.target?.entityId || ''),
              target: String(route?.target?.counterpartyEntityId || ''),
            }),
          ),
          messages: Array.from(state?.messages || [])
            .slice(-20)
            .map(String),
        };
      });
    });
    console.log(
      '[E2E cross pull flow debug]',
      JSON.stringify(
        {
          source: {
            entityId: source.entityId,
            hubId: sourceHubId,
            routes: sourceState.routeSummaries,
            offers: sourceState.offerSummaries,
            pulls: sourceState.pullIds,
            accountKeys: sourceState.accountKeys,
            messages: sourceState.messages.slice(-20),
          },
          target: {
            entityId: target.entityId,
            hubId: targetHubId,
            routes: targetState.routeSummaries,
            offers: targetState.offerSummaries,
            pulls: targetState.pullIds,
            accountKeys: targetState.accountKeys,
            messages: targetState.messages.slice(-20),
          },
          replicas,
        },
        null,
        2,
      ),
    );
    throw error;
  }
}

export async function readCrossResolveSnapshots(
  page: Page,
  entityId: string,
  counterpartyId: string,
): Promise<CrossResolveSnapshot[]> {
  return await page.evaluate(
    ({ entityId, counterpartyId }) => {
      const env = (window as CrossRuntimeWindow).isolatedEnv;
      const recordOf = (value: unknown): Record<string, unknown> =>
        value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
      const owner = String(entityId || '').toLowerCase();
      const cp = String(counterpartyId || '').toLowerCase();
      const out: CrossResolveSnapshot[] = [];
      const seen = new Set<string>();

      const accountMatches = (accountKey: string, rawAccount: unknown): boolean => {
        const account = recordOf(rawAccount);
        const left = typeof account.leftEntity === 'string' ? account.leftEntity.toLowerCase() : '';
        const right = typeof account.rightEntity === 'string' ? account.rightEntity.toLowerCase() : '';
        const canonicalCp =
          typeof account.counterpartyEntityId === 'string' ? account.counterpartyEntityId.toLowerCase() : '';
        return (
          accountKey.toLowerCase() === cp ||
          canonicalCp === cp ||
          Boolean(left && right && ((left === owner && right === cp) || (right === owner && left === cp)))
        );
      };
      const collectResolveSnapshots = (history: unknown, replicaKey: string, accountKey: string) => {
        if (!(history instanceof Map)) return;
        for (const [offerId, rawLifecycle] of history.entries()) {
          const resolves = recordOf(rawLifecycle).resolves;
          if (!Array.isArray(resolves)) continue;
          for (const rawResolve of resolves) {
            const resolve = recordOf(rawResolve);
            const snapshotOfferId = String(offerId || '');
            const height = Number(resolve.height ?? recordOf(rawLifecycle).lastUpdatedHeight ?? 0);
            const fillRatio = Number(resolve.fillRatio || 0);
            const key = [
              String(replicaKey || ''),
              String(accountKey || ''),
              snapshotOfferId,
              String(height),
              String(fillRatio),
              String(resolve.fillNumerator ?? '0'),
              String(resolve.fillDenominator ?? '0'),
              String(resolve.executionGiveAmount ?? '0'),
              String(resolve.executionWantAmount ?? '0'),
            ].join(':');
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({
              offerId: snapshotOfferId,
              height,
              fillRatio: Number(resolve.fillRatio || 0),
              fillNumerator: String(resolve.fillNumerator ?? '0'),
              fillDenominator: String(resolve.fillDenominator ?? '0'),
              cancelRemainder: Boolean(resolve.cancelRemainder),
              executionGiveAmount: String(resolve.executionGiveAmount ?? '0'),
              executionWantAmount: String(resolve.executionWantAmount ?? '0'),
              comment: String(resolve.comment || ''),
            });
          }
        }
      };

      for (const [replicaKey, replica] of env?.eReplicas?.entries?.() || []) {
        if (!String(replicaKey).toLowerCase().startsWith(`${owner}:`)) continue;
        const state = recordOf(recordOf(replica).state);
        const accounts = state.accounts;
        if (!(accounts instanceof Map)) continue;
        for (const [accountKey, rawAccount] of accounts.entries()) {
          if (!accountMatches(String(accountKey || ''), rawAccount)) continue;
          // Multiple replicas can expose the same bilateral account while one is
          // one frame behind. Do not stop at the first match: the assertion needs
          // the latest committed account snapshot, not whichever Map entry appears
          // first in the browser runtime.
          collectResolveSnapshots(
            recordOf(rawAccount).swapOrderHistory,
            String(replicaKey || ''),
            String(accountKey || ''),
          );
          collectResolveSnapshots(
            recordOf(rawAccount).swapClosedOrders,
            String(replicaKey || ''),
            String(accountKey || ''),
          );
        }
      }
      return out.sort(
        (a, b) =>
          a.height - b.height ||
          a.offerId.localeCompare(b.offerId) ||
          a.executionGiveAmount.localeCompare(b.executionGiveAmount) ||
          a.executionWantAmount.localeCompare(b.executionWantAmount),
      );
    },
    { entityId, counterpartyId },
  );
}

export async function waitForLatestCrossResolveSnapshot(
  page: Page,
  entityId: string,
  counterpartyId: string,
  minimumCount: number,
): Promise<CrossResolveSnapshot> {
  try {
    await expect
      .poll(async () => (await readCrossResolveSnapshots(page, entityId, counterpartyId)).length, {
        timeout: 45_000,
        intervals: [250, 500, 1000],
        message: `cross resolve snapshots must reach ${minimumCount}`,
      })
      .toBeGreaterThanOrEqual(minimumCount);
  } catch (error) {
    const debug = await page.evaluate(
      ({ entityId, counterpartyId }) => {
        const env = (window as CrossRuntimeWindow).isolatedEnv;
        const owner = String(entityId || '').toLowerCase();
        const cp = String(counterpartyId || '').toLowerCase();
        const out: any[] = [];
        for (const [replicaKey, replica] of env?.eReplicas?.entries?.() || []) {
          if (!String(replicaKey).toLowerCase().startsWith(`${owner}:`)) continue;
          const state = replica?.state;
          out.push({
            replicaKey: String(replicaKey),
            entityId: String(state?.entityId || ''),
            profileName: String(state?.profile?.name || ''),
            messages: Array.from(state?.messages || [])
              .slice(-16)
              .map(String),
            accounts: Array.from(state?.accounts?.entries?.() || []).map(([accountKey, account]: [string, any]) => ({
              accountKey,
              matchesCounterparty:
                String(accountKey || '').toLowerCase() === cp ||
                String(account?.counterpartyEntityId || '').toLowerCase() === cp ||
                [
                  String(account?.leftEntity || '').toLowerCase(),
                  String(account?.rightEntity || '').toLowerCase(),
                ].includes(cp),
              currentHeight: Number(account?.currentHeight || 0),
              pendingTxs: Array.from(account?.pendingFrame?.accountTxs || []).map((tx: any) => String(tx?.type || '')),
              mempoolTxs: Array.from(account?.mempool || []).map(
                (tx: any) => `${String(tx?.type || '')}:${String(tx?.data?.offerId || '').slice(-8)}`,
              ),
              openOffers: Array.from(account?.swapOffers?.entries?.() || []).map(([offerId, offer]: [string, any]) => ({
                offerId,
                cross: Boolean(offer?.crossJurisdiction),
                status: String(offer?.crossJurisdiction?.status || ''),
                fillSeq: Number(offer?.crossJurisdiction?.fillSeq || 0),
                ratio: Number(offer?.crossJurisdiction?.cumulativeFillRatio || 0),
              })),
              history: Array.from(account?.swapOrderHistory?.entries?.() || []).map(
                ([offerId, entry]: [string, any]) => ({
                  offerId,
                  resolves: Array.from(entry?.resolves || []).map((resolve: any) => ({
                    height: Number(resolve?.height || 0),
                    fillRatio: Number(resolve?.fillRatio || 0),
                    executionGiveAmount: String(resolve?.executionGiveAmount ?? '0'),
                    executionWantAmount: String(resolve?.executionWantAmount ?? '0'),
                  })),
                }),
              ),
              closed: Array.from(account?.swapClosedOrders?.entries?.() || []).map(
                ([offerId, entry]: [string, any]) => ({
                  offerId,
                  resolves: Array.from(entry?.resolves || []).map((resolve: any) => ({
                    height: Number(resolve?.height || 0),
                    fillRatio: Number(resolve?.fillRatio || 0),
                    executionGiveAmount: String(resolve?.executionGiveAmount ?? '0'),
                    executionWantAmount: String(resolve?.executionWantAmount ?? '0'),
                  })),
                }),
              ),
            })),
          });
        }
        return out;
      },
      { entityId, counterpartyId },
    );
    console.log('[E2E cross resolve debug]', JSON.stringify({ entityId, counterpartyId, debug }, null, 2));
    throw error;
  }
  const latest = (await readCrossResolveSnapshots(page, entityId, counterpartyId)).at(-1);
  expect(latest, 'latest cross resolve snapshot must exist').toBeTruthy();
  return latest!;
}

export async function waitForCrossOffersCleared(
  page: Page,
  identity: RuntimeIdentity,
  hubId: string,
  label: string,
  options: { orderId?: string } = {},
): Promise<void> {
  try {
    await expect
      .poll(
        async () => {
          const state = await readCrossState(page, identity, hubId);
          const matchingOfferOpen = options.orderId
            ? state.offerSummaries.some(offer => offer.offerId === options.orderId)
            : state.offers > 0;
          return {
            offers: options.orderId ? (matchingOfferOpen ? 1 : 0) : state.offers,
            hasPendingFrame: state.hasPendingFrame,
            mempoolTxs: state.mempoolTxs,
            replicaFound: state.replicaFound,
            accountFound: state.accountFound,
            accountKeys: state.accountKeys,
            openOfferIds: state.offerSummaries.map(offer => offer.offerId),
          };
        },
        {
          timeout: 45_000,
          intervals: [250, 500, 1000],
          message: `${label} cross order should resolve/cancel after match`,
        },
      )
      .toMatchObject({ offers: 0, hasPendingFrame: false, mempoolTxs: [] });
  } catch (error) {
    const debug = await page.evaluate(
      ({ identity, hubId }) => {
        const env = (window as CrossRuntimeWindow).isolatedEnv;
        const out: any[] = [];
        for (const [key, replica] of env?.eReplicas?.entries?.() || []) {
          const state = replica?.state;
          const entityId = String(state?.entityId || replica?.entityId || '').toLowerCase();
          if (
            entityId !== String(identity.entityId).toLowerCase() &&
            !Array.from(state?.accounts?.keys?.() || []).some(
              accountId => String(accountId).toLowerCase() === String(hubId).toLowerCase(),
            )
          ) {
            continue;
          }
          out.push({
            key: String(key),
            entityId,
            signerId: String(replica?.signerId || ''),
            profileName: String(state?.profile?.name || ''),
            jurisdiction: String(state?.config?.jurisdiction?.name || ''),
            messages: Array.from(state?.messages || [])
              .slice(-12)
              .map(String),
            routes: Array.from(state?.crossJurisdictionSwaps?.entries?.() || []).map(
              ([routeId, route]: [string, any]) => ({
                routeId,
                status: String(route?.status || ''),
                source: String(route?.source?.entityId || '').slice(0, 10),
                sourceHub: String(route?.source?.counterpartyEntityId || '').slice(0, 10),
                targetHub: String(route?.target?.entityId || '').slice(0, 10),
                target: String(route?.target?.counterpartyEntityId || '').slice(0, 10),
                sourcePull: Boolean(route?.sourcePull),
                targetPull: Boolean(route?.targetPull),
              }),
            ),
            accounts: Array.from(state?.accounts?.entries?.() || []).map(([accountId, account]: [string, any]) => ({
              accountId,
              currentHeight: Number(account?.currentHeight || 0),
              mempool: Array.from(account?.mempool || []).map((tx: any) => String(tx?.type || '')),
              pendingFrame: Array.from(account?.pendingFrame?.accountTxs || []).map((tx: any) =>
                String(tx?.type || ''),
              ),
              offers: Array.from(account?.swapOffers?.entries?.() || []).map(([offerId, offer]: [string, any]) => ({
                offerId,
                cross: Boolean(offer?.crossJurisdiction),
                status: String(offer?.crossJurisdiction?.status || ''),
              })),
              pulls: Array.from(account?.pulls?.keys?.() || []),
            })),
          });
        }
        return out;
      },
      { identity, hubId },
    );
    console.log(`[E2E ${label} offer debug]`, JSON.stringify(debug, null, 2));
    throw error;
  }
}

export async function waitForCrossPendingFill(
  page: Page,
  identity: RuntimeIdentity,
  hubId: string,
  label: string,
  options: { routeId?: string; minFillSeq?: number; minRatioExclusive?: number } = {},
): Promise<{ routeId: string; ratio: number; fillSeq: number }> {
  let routeId = '';
  let ratio = 0;
  let fillSeq = 0;
  try {
    await expect
      .poll(
        async () => {
          const state = await readCrossState(page, identity, hubId);
          const route = state.routeSummaries
            .filter(
              candidate =>
                candidate.status === 'partially_filled' &&
                candidate.cumulativeFillRatio > 0 &&
                candidate.cumulativeFillRatio < 65_535 &&
                (!options.routeId || candidate.orderId === options.routeId) &&
                candidate.fillSeq >= (options.minFillSeq ?? 1) &&
                candidate.cumulativeFillRatio > (options.minRatioExclusive ?? 0),
            )
            .sort((a, b) => b.updatedAt - a.updatedAt)[0];
          routeId = route?.orderId || '';
          ratio = route?.cumulativeFillRatio || 0;
          fillSeq = route?.fillSeq || 0;
          return {
            offers: state.offers,
            pulls: state.pulls,
            routeStatus: route?.status || '',
            ratio,
            fillSeq,
          };
        },
        {
          timeout: 75_000,
          intervals: [250, 500, 1000],
          message: `${label} cross-j partial fill must remain pending in the book without clearing pulls`,
        },
      )
      .toMatchObject({
        offers: expect.any(Number),
        pulls: expect.any(Number),
        routeStatus: 'partially_filled',
        fillSeq: expect.any(Number),
      });
  } catch (error) {
    const state = await readCrossState(page, identity, hubId);
    console.log(
      `[E2E ${label} pending fill debug]`,
      JSON.stringify(
        {
          offers: state.offers,
          pulls: state.pulls,
          routes: state.routeSummaries.map((candidate: any) => ({
            orderId: String(candidate.orderId || ''),
            status: candidate.status,
            ratio: candidate.cumulativeFillRatio,
            fillSeq: candidate.fillSeq,
            filledSourceAmount: candidate.filledSourceAmount,
            filledTargetAmount: candidate.filledTargetAmount,
            sourcePull: candidate.sourcePull,
            targetPull: candidate.targetPull,
            bookOwnerEntityId: candidate.bookOwnerEntityId,
            venueId: candidate.venueId,
          })),
          offerSummaries: state.offerSummaries,
          pullIds: state.pullIds,
          accountKeys: state.accountKeys,
          messages: state.messages.slice(-20),
        },
        null,
        2,
      ),
    );
    throw error;
  }
  expect(routeId, `${label} partial route id must be available`).toBeTruthy();
  const state = await readCrossState(page, identity, hubId);
  const route = state.routeSummaries.find(candidate => candidate.orderId === routeId);
  expect(state.offers, `${label} partial order must stay open`).toBeGreaterThan(0);
  expect(state.pulls, `${label} partial pull must stay locked until explicit clear`).toBeGreaterThan(0);
  expect(route?.cumulativeFillRatio || 0, `${label} partial ratio must be positive`).toBeGreaterThan(0);
  expect(route?.cumulativeFillRatio || 0, `${label} partial ratio must not be full`).toBeLessThan(65_535);
  return { routeId, ratio, fillSeq };
}

export async function requestCrossClear(
  page: Page,
  identity: RuntimeIdentity,
  orderId: string,
  options: { cancelRemainder?: boolean } = {},
): Promise<void> {
  await enqueueEntityTxs(page, identity.entityId, identity.signerId, [
    {
      type: 'requestCrossJurisdictionClear',
      data: {
        orderId,
        cancelRemainder: Boolean(options.cancelRemainder),
      },
    },
  ]);
  await flushRuntime(page, 5);
}

export async function waitForCrossRouteStatus(
  page: Page,
  identity: RuntimeIdentity,
  hubId: string,
  orderId: string,
  statuses: readonly string[],
  label: string,
): Promise<void> {
  try {
    await expect
      .poll(
        async () => {
          const state = await readCrossState(page, identity, hubId);
          const route = state.routeSummaries.find(candidate => candidate.orderId === orderId);
          return {
            status: route?.status || '',
            offers: state.offers,
            pulls: state.pulls,
            ratio: route?.cumulativeFillRatio || 0,
          };
        },
        {
          timeout: 75_000,
          intervals: [250, 500, 1000],
          message: `${label} route ${orderId.slice(0, 10)} must reach ${statuses.join('/')}`,
        },
      )
      .toMatchObject({
        status: expect.stringMatching(new RegExp(`^(${statuses.map(escapeRegex).join('|')})$`)),
      });
  } catch (error) {
    const state = await readCrossState(page, identity, hubId);
    console.log(
      `[E2E ${label} route status debug]`,
      JSON.stringify(
        {
          orderId,
          expected: statuses,
          offers: state.offers,
          pulls: state.pulls,
          route: state.routeSummaries.find(candidate => candidate.orderId === orderId),
          offerSummaries: state.offerSummaries,
          pullIds: state.pullIds,
          messages: state.messages.slice(-24),
        },
        null,
        2,
      ),
    );
    throw error;
  }
}

export async function waitForCrossRouteMaterialized(
  page: Page,
  identity: RuntimeIdentity,
  hubId: string,
  orderId: string,
  label: string,
): Promise<void> {
  try {
    await expect
      .poll(
        async () => {
          const state = await readCrossState(page, identity, hubId);
          const route = state.routeSummaries.find(candidate => candidate.orderId === orderId);
          return {
            present: Boolean(route),
            sourcePull: Boolean(route?.sourcePull),
            targetPull: Boolean(route?.targetPull),
            status: route?.status || '',
          };
        },
        {
          timeout: 45_000,
          intervals: [250, 500, 1000],
          message: `${label} route ${orderId.slice(0, 10)} must materialize before dispute salvage`,
        },
      )
      .toMatchObject({ present: true, targetPull: true });
  } catch (error) {
    const state = await readCrossState(page, identity, hubId);
    console.log(
      `[E2E ${label} route materialization debug]`,
      JSON.stringify(
        {
          orderId,
          routes: state.routeSummaries,
          accountKeys: state.accountKeys,
          messages: state.messages.slice(-24),
        },
        null,
        2,
      ),
    );
    throw error;
  }
}

export async function triggerSourceDisputeArguments(
  page: Page,
  source: RuntimeIdentity,
  hubId: string,
  routeId: string,
  sourceHubRuntimeSeed: string,
): Promise<void> {
  expect(routeId, `${source.entityId.slice(0, 10)} active cross-j route id required for dispute args`).toBeTruthy();
  const abi = AbiCoder.defaultAbiCoder();
  const partialBinary = await page.evaluate(
    async ({ source, routeId, sourceHubRuntimeSeed }) => {
      const view = window as CrossRuntimeWindow;
      const env = view.isolatedEnv;
      if (!env) throw new Error('isolatedEnv missing');
      const runtimeModule = view.__xln?.instance;
      if (!runtimeModule) throw new Error('__xln.instance missing');
      const sourceEntityId = String(source.entityId || '').toLowerCase();
      let sourceState: any = null;
      for (const replica of env.eReplicas?.values?.() || []) {
        const state = replica?.state;
        if (String(state?.entityId || '').toLowerCase() === sourceEntityId) {
          sourceState = state;
          break;
        }
      }
      const route = sourceState?.crossJurisdictionSwaps?.get(routeId);
      if (!route) throw new Error(`cross-j source dispute route missing: ${routeId}`);
      const fillRatio = Number(route.cumulativeFillRatio || route.claimedRatio || 0);
      if (!Number.isFinite(fillRatio) || fillRatio <= 0) {
        throw new Error(`cross-j source dispute route has no committed fill: ${routeId}`);
      }
      // Pull commitments are prepared by the source hub, so source-dispute args
      // must reveal with the source hub runtime seed, not the user's BrainVault seed.
      const privateSeed = runtimeModule.getCrossJurisdictionPrivateSeed({ runtimeSeed: sourceHubRuntimeSeed }, route);
      const reveal = runtimeModule.buildCrossJurisdictionPullReveal(route, fillRatio, privateSeed);
      if (!reveal?.binary || reveal.binary === '0x') {
        throw new Error(`cross-j source dispute reveal missing binary: ${routeId}`);
      }
      return String(reveal.binary);
    },
    { source, routeId, sourceHubRuntimeSeed },
  );
  const crossPullArgs = abi.encode(
    ['tuple(uint16[] fillRatios, bytes32[] secrets, bytes[] pulls)'],
    [{ fillRatios: [], secrets: [], pulls: [partialBinary] }],
  );
  const starterInitialArguments = abi.encode(['bytes[]'], [[crossPullArgs]]);
  const suffix = routeId
    .replace(/[^a-fA-F0-9]/g, '')
    .padEnd(64, '0')
    .slice(0, 64);
  const event = {
    type: 'DisputeStarted',
    data: {
      sender: hubId,
      counterentity: source.entityId,
      nonce: '1',
      proofbodyHash: `0x${suffix}`,
      starterInitialArguments,
      starterIncrementedArguments: '0x',
      disputeTimeout: 100,
      onChainNonce: 1,
    },
  };
  const transactionHash = `0x${'cd'.repeat(32)}`;
  await injectSyntheticJEventThroughWatcher(page, source, {
    event,
    transactionHash,
  });
  await flushRuntime(page, 8);
}

export async function waitForCrossDisputeRouted(
  page: Page,
  source: RuntimeIdentity,
  hubId: string,
  routeId: string,
): Promise<void> {
  try {
    await expect
      .poll(
        async () => {
          await flushRuntime(page, 1);
          const state = await readCrossState(page, source, hubId);
          return state.messages.some(
            message => /Cross-j pull args observed/i.test(message) && message.includes(routeId),
          );
        },
        {
          timeout: 45_000,
          intervals: [250, 500, 1000],
          message: 'source dispute must route cross-j pull args to target sibling',
        },
      )
      .toBe(true);
  } catch (error) {
    const state = await readCrossState(page, source, hubId);
    console.log(
      '[E2E source dispute route debug]',
      JSON.stringify(
        {
          routeId,
          routes: state.routeSummaries,
          accountKeys: state.accountKeys,
          messages: state.messages.slice(-32),
        },
        null,
        2,
      ),
    );
    throw error;
  }
}

export async function waitForCrossSalvageQueued(
  page: Page,
  target: RuntimeIdentity,
  hubId: string,
  routeId: string,
): Promise<void> {
  try {
    await expect
      .poll(
        async () => {
          await flushRuntime(page, 1);
          const state = await readCrossState(page, target, hubId);
          const route = state.routeSummaries.find(candidate => candidate.orderId === routeId);
          const routedMessage = state.messages.some(
            message => /Cross-j salvage queued/i.test(message) && message.includes(routeId),
          );
          const disputeStarted = state.messages.some(message => /Dispute started/i.test(message));
          const routeProgressedPastSalvage = Boolean(
            route &&
            route.targetPull &&
            route.cumulativeFillRatio > 0 &&
            ['clearing', 'source_claimed', 'target_claimed', 'settled'].includes(route.status),
          );
          return routedMessage || (disputeStarted && Boolean(route)) || routeProgressedPastSalvage;
        },
        {
          timeout: 45_000,
          intervals: [250, 500, 1000],
          message: 'target sibling must queue cross-j salvage after source dispute arguments',
        },
      )
      .toBe(true);
  } catch (error) {
    const state = await readCrossState(page, target, hubId);
    console.log(
      '[E2E target salvage debug]',
      JSON.stringify(
        {
          routeId,
          routes: state.routeSummaries,
          pullIds: state.pullIds,
          accountKeys: state.accountKeys,
          messages: state.messages.slice(-32),
        },
        null,
        2,
      ),
    );
    throw error;
  }
}

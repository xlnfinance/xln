import { Wallet } from 'ethers';
import {
  API_BASE_URL,
  APP_BASE_URL,
  CrossRuntimeWindow,
  DEFAULT_USDC_REBALANCE_SOFT_LIMIT,
  INIT_TIMEOUT,
  SWAP_TOKENS,
  USDC,
  USDT,
  WETH,
  attachBrowserConsoleGuard,
  configurePair,
  configureTokens,
  createRuntimeIdentityViaStore,
  ensureDirectHubAccount,
  expectBrowserConsoleClean,
  expectExactTenByTen,
  expectMarketMakerSameAndCrossBooksHealthy,
  faucetOffchain,
  flushRuntime,
  getIsolatedHubRuntimeSeed,
  getPrimaryHubApiBaseUrl,
  getPrimaryHubId,
  getPrimaryHubName,
  getSecondaryHubInfo,
  importRpc2SiblingEntity,
  inCap,
  normalizeId,
  openSwapWorkspace,
  readFullMeshHealth,
  readHubPairSnapshot,
  readOpenDebugIncidents,
  selectCounterpartyInSwap,
  selectCrossRoute,
  selectOrderbookPairByLabel,
  selectSourceChainInSwap,
  tokenAmount,
  waitForAccountReady,
  waitForDefaultJurisdictionReplicas,
  waitForOutCapAtLeast,
  waitForRebalancePolicy,
  waitForRebalanceSecured,
} from './e2e-cross-j-swap-helpers-a';
import {
  clickCrossOrderbookLevel,
  expectCrossNonTakeableClickNoop,
  expectCrossOrderbookReady,
  expectCrossTransfer,
  expectDirectCrossOrderbookReady,
  expectSwapAssetRoute,
  expectSwapTokens,
  placeCrossOrder,
  readCrossState,
  readHubCrossDeltas,
  triggerSourceDisputeArguments,
  visibleOrderbookRow,
  waitForCrossDisputeRouted,
  waitForCrossOffersCleared,
  waitForCrossPendingFill,
  waitForCrossPullFlow,
  waitForCrossRouteMaterialized,
  waitForCrossRouteStatus,
  waitForCrossSalvageQueued,
  waitForLatestCrossResolveSnapshot,
} from './e2e-cross-j-swap-helpers-b';
import { allowDebugIncident, expect, test, type BrowserContext } from './global-setup.mts';
import { ensureE2EBaseline } from './utils/e2e-baseline';
import { connectRuntimeToHubWithCredit } from './utils/e2e-connect';
import { gotoApp } from './utils/e2e-demo-users';
import { enqueueEntityTxs } from './utils/e2e-runtime-input';
import { hasSilentRelayMarketSubscribe, installSilentRelayWebSocket } from './utils/e2e-silent-relay';
import { timedStep } from './utils/e2e-timing.mts';

test.describe('E2E Cross-J Swap Isolated Flow', () => {
  test.setTimeout(360_000);

  test(
    'market maker prepublishes same-chain and ETH/TRON cross-chain books before user swaps',
    { tag: '@functional' },
    async ({ page }) => {
      const baseline = await timedStep('cross_j_mm_books.ensure_baseline', () =>
        ensureE2EBaseline(page, {
          apiBaseUrl: API_BASE_URL,
          requireMarketMaker: true,
          requireHubMesh: true,
          minHubCount: 3,
        }),
      );
      expectMarketMakerSameAndCrossBooksHealthy(baseline);
    },
  );

  test(
    'H2 process replacement restores authoritative health and exact 10x10 public book',
    { tag: '@resilience' },
    async ({ page }) => {
      allowDebugIncident({
        source: 'orchestrator',
        code: 'CHILD_UNEXPECTED_EXIT',
        message: 'child.unexpected_exit',
      });
      allowDebugIncident({
        source: 'orchestrator',
        code: 'H2_UNEXPECTED_EXIT',
        message: 'H2_UNEXPECTED_EXIT code=null signal=SIGKILL',
      });
      const baseline = await ensureE2EBaseline(page, {
        apiBaseUrl: API_BASE_URL,
        requireMarketMaker: true,
        requireHubMesh: true,
        minHubCount: 3,
      });
      expectMarketMakerSameAndCrossBooksHealthy(baseline);

      const before = await readFullMeshHealth(page);
      const h2Process = before.process?.children?.find(child => child.role === 'hub' && child.name === 'H2');
      const h2Hub = before.hubs?.find(hub => hub.name === 'H2');
      expect(h2Process?.online, `H2 process missing before replacement: ${JSON.stringify(before.process ?? {})}`).toBe(
        true,
      );
      expect(h2Process?.pid, 'H2 PID must be visible to the isolated local operator test').toBeGreaterThan(0);
      expect(h2Hub?.entityId, `H2 hub identity missing: ${JSON.stringify(before.hubs ?? [])}`).toMatch(
        /^0x[0-9a-f]{64}$/i,
      );
      const oldPid = Number(h2Process!.pid);
      const oldRestartCount = Number(h2Process!.restartCount ?? 0);
      const beforeSnapshot = await readHubPairSnapshot(page, h2Hub!, '1/2');
      expectExactTenByTen(beforeSnapshot, 'H2 pre-restart USDC/WETH book');
      const h2CrossPairId = before.marketMaker?.cross?.routes
        ?.find(route => normalizeId(route.sourceHubEntityId) === normalizeId(h2Hub!.entityId))
        ?.pairs?.find(pair => Number(pair.expectedOffers ?? 0) === 10)?.pairId;
      expect(h2CrossPairId, 'H2 must publish a configured cross-j pair before restart').toBeTruthy();
      const beforeCrossSnapshot = await readHubPairSnapshot(page, h2Hub!, h2CrossPairId!);
      expectExactTenByTen(beforeCrossSnapshot, 'H2 pre-restart cross-j book');

      process.kill(oldPid, 'SIGKILL');

      await expect
        .poll(
          async () => {
            const health = await readFullMeshHealth(page);
            return health.systemOk;
          },
          {
            timeout: 15_000,
            intervals: [50, 100, 250],
            message: 'global health must become non-ready while H2 is unavailable',
          },
        )
        .toBe(false);

      let h2IncidentFingerprint = '';
      await expect
        .poll(
          async () => {
            const incidents = await readOpenDebugIncidents(page);
            const incident = incidents.find(
              candidate =>
                candidate.code.includes('H2_UNEXPECTED_EXIT') || candidate.message.includes('H2_UNEXPECTED_EXIT'),
            );
            h2IncidentFingerprint = incident?.fingerprint ?? '';
            return h2IncidentFingerprint;
          },
          {
            timeout: 15_000,
            intervals: [50, 100, 250],
            message: 'H2 failure must be durable in the parent incident registry before replacement',
          },
        )
        .toMatch(/^h2_unexpected_exit-/);

      await expect
        .poll(
          async () => {
            const health = await readFullMeshHealth(page);
            const child = health.process?.children?.find(
              candidate => candidate.role === 'hub' && candidate.name === 'H2',
            );
            const hub = health.hubs?.find(candidate => candidate.name === 'H2');
            return {
              replaced: Number(child?.pid ?? 0) > 0 && Number(child?.pid) !== oldPid,
              restarted: Number(child?.restartCount ?? 0) > oldRestartCount,
              processOnline: child?.online === true,
              hubOnline: hub?.online === true,
              systemOk: health.systemOk === true,
            };
          },
          {
            timeout: 90_000,
            intervals: [250, 500, 1000],
            message: 'orchestrator must replace H2 and restore authoritative live health',
          },
        )
        .toEqual({
          replaced: true,
          restarted: true,
          processOnline: true,
          hubOnline: true,
          systemOk: true,
        });

      const restored = await readFullMeshHealth(page);
      expectMarketMakerSameAndCrossBooksHealthy(restored);
      expect(
        (await readOpenDebugIncidents(page)).some(incident => incident.fingerprint === h2IncidentFingerprint),
        'H2 root incident must remain queryable after managed replacement',
      ).toBe(true);
      const restoredH2 = restored.hubs?.find(hub => hub.name === 'H2');
      expect(restoredH2?.entityId).toBe(h2Hub!.entityId);
      const restoredSnapshot = await readHubPairSnapshot(page, restoredH2!, '1/2');
      expectExactTenByTen(restoredSnapshot, 'H2 restored USDC/WETH book');
      expect(restoredSnapshot.entityHeight).toBeGreaterThanOrEqual(beforeSnapshot.entityHeight);
      const restoredCrossSnapshot = await readHubPairSnapshot(page, restoredH2!, h2CrossPairId!);
      expectExactTenByTen(restoredCrossSnapshot, 'H2 restored cross-j book');
      expect(restoredCrossSnapshot.entityHeight).toBeGreaterThanOrEqual(beforeCrossSnapshot.entityHeight);
    },
  );

  test(
    'real MM full fill auto-closes and partial fill closes manually on both legs',
    { tag: '@functional' },
    async ({ page }, testInfo) => {
      const baseline = await timedStep('cross_j_mm_fill.ensure_baseline', () =>
        ensureE2EBaseline(page, {
          apiBaseUrl: API_BASE_URL,
          requireMarketMaker: true,
          requireHubMesh: true,
          minHubCount: 3,
        }),
      );
      expectMarketMakerSameAndCrossBooksHealthy(baseline);
      const hubId = getPrimaryHubId(baseline);
      const primaryHubApiBaseUrl = getPrimaryHubApiBaseUrl(baseline, hubId);
      const primaryHubName = getPrimaryHubName(baseline, hubId);
      const targetHub = await getSecondaryHubInfo(page, hubId, primaryHubName, primaryHubApiBaseUrl);

      await gotoApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 1200 });
      const mnemonic = Wallet.createRandom().mnemonic!.phrase;
      const source = await createRuntimeIdentityViaStore(page, 'cross-real-mm', mnemonic);
      await waitForDefaultJurisdictionReplicas(page, 'cross-real-mm');
      const target = await importRpc2SiblingEntity(page, mnemonic, 'cross-real-mm');
      await connectRuntimeToHubWithCredit(page, source, hubId, '10000', SWAP_TOKENS);
      await ensureDirectHubAccount(page, target, targetHub.entityId, SWAP_TOKENS, 150_000);
      await faucetOffchain(page, primaryHubApiBaseUrl, source.entityId, hubId, USDC, '300');
      await waitForOutCapAtLeast(page, source.entityId, hubId, USDC, tokenAmount(USDC, 300n));
      const [fullSourceBefore, fullTargetBefore] = await Promise.all([
        readCrossState(page, source, hubId),
        readCrossState(page, target, targetHub.entityId),
      ]);
      expect(fullSourceBefore.deltas[String(USDC)], 'source USDC delta must exist before full fill').toBeDefined();
      expect(fullTargetBefore.deltas[String(USDC)], 'target USDC delta must exist before full fill').toBeDefined();

      const orderId = await placeCrossOrder(page, {
        source,
        hubId,
        targetEntityId: target.entityId,
        side: 'sell',
        fromTokenId: USDC,
        toTokenId: USDC,
        clickBookSide: 'bid',
        expectedClickFromTokenId: USDC,
        expectedClickToTokenId: USDC,
        expectedBookDepth: 10,
        expectedAutoAmount: 300,
        screenshotPath: testInfo.outputPath('cross-j-mm-10x10-hub-first.png'),
      });
      await expect(page.getByTestId('swap-from-token-label').first()).toContainText('USDC (Testnet)');
      await expect(page.getByTestId('swap-to-token-label').first()).toContainText('USDC (Tron)');

      await waitForCrossPullFlow(page, source, target, hubId, targetHub.entityId, {
        sourceRouteId: orderId,
        targetRouteId: orderId,
      });
      await waitForCrossOffersCleared(page, source, hubId, 'real MM USDC fill', { orderId });
      await expect
        .poll(
          async () => {
            await flushRuntime(page, 3);
            const [sourceState, targetState] = await Promise.all([
              readCrossState(page, source, hubId),
              readCrossState(page, target, targetHub.entityId),
            ]);
            return {
              sourcePulls: sourceState.pulls,
              targetPulls: targetState.pulls,
              sourcePending: sourceState.hasPendingFrame,
              targetPending: targetState.hasPendingFrame,
              sourceMempool: sourceState.mempoolTxs,
              targetMempool: targetState.mempoolTxs,
            };
          },
          {
            timeout: 75_000,
            intervals: [250, 500, 1000],
            message: 'real MM cross-j fill must leave no pulls, pending frames, or Account mempool residue',
          },
        )
        .toEqual({
          sourcePulls: 0,
          targetPulls: 0,
          sourcePending: false,
          targetPending: false,
          sourceMempool: [],
          targetMempool: [],
        });
      const [filledSourceState, filledTargetState] = await Promise.all([
        readCrossState(page, source, hubId),
        readCrossState(page, target, targetHub.entityId),
      ]);
      expect(
        filledSourceState.routeSummaries.find(route => route.orderId === orderId)?.status,
        'a fully matched source route must close automatically',
      ).toBe('settled');
      expect(
        filledTargetState.routeSummaries.find(route => route.orderId === orderId)?.status,
        'a fully matched target route must close automatically',
      ).toBe('settled');
      const filledSourceRoute = filledSourceState.routeSummaries.find(route => route.orderId === orderId);
      const filledTargetRoute = filledTargetState.routeSummaries.find(route => route.orderId === orderId);
      expect(filledSourceRoute, 'full source route must remain inspectable in Account history').toBeDefined();
      expect(filledTargetRoute, 'full target route must remain inspectable in Account history').toBeDefined();
      expect(filledTargetRoute?.filledSourceAmount).toBe(filledSourceRoute?.filledSourceAmount);
      expect(filledTargetRoute?.filledTargetAmount).toBe(filledSourceRoute?.filledTargetAmount);
      expect(BigInt(filledSourceRoute!.filledSourceAmount), 'full fill must consume the selected 300 USDC').toBe(
        tokenAmount(USDC, 300n),
      );
      const fullSourceAfter = filledSourceState.deltas[String(USDC)];
      const fullTargetAfter = filledTargetState.deltas[String(USDC)];
      await expect
        .poll(
          async () => {
            const [sourceHubDeltas, targetHubDeltas] = await Promise.all([
              readHubCrossDeltas(page, hubId, source.entityId, [USDC]),
              readHubCrossDeltas(page, targetHub.entityId, target.entityId, [USDC]),
            ]);
            return {
              source: sourceHubDeltas[String(USDC)],
              target: targetHubDeltas[String(USDC)],
            };
          },
          {
            timeout: 20_000,
            intervals: [100, 250, 500],
            message: 'both Hubs must commit the exact paired Account ACKs after full fill',
          },
        )
        .toEqual({ source: fullSourceAfter, target: fullTargetAfter });
      expectCrossTransfer(
        fullSourceBefore.deltas[String(USDC)],
        fullSourceAfter,
        BigInt(filledSourceRoute!.filledSourceAmount),
        fullSourceBefore.ownerIsLeft,
        'spend',
        'full source Account',
      );
      expectCrossTransfer(
        fullTargetBefore.deltas[String(USDC)],
        fullTargetAfter,
        BigInt(filledTargetRoute!.filledTargetAmount),
        fullTargetBefore.ownerIsLeft,
        'receive',
        'full target Account',
        BigInt(filledTargetState.currentFrameFees[String(USDC)] ?? '0'),
      );
      await expect(page.getByTestId('swap-open-order-row')).toHaveCount(0, { timeout: 15_000 });

      await enqueueEntityTxs(page, target.entityId, target.signerId, [
        {
          type: 'extendCredit',
          data: {
            counterpartyEntityId: targetHub.entityId,
            tokenId: USDC,
            amount: tokenAmount(USDC, 100_000n),
          },
        },
      ]);
      await flushRuntime(page, 8);
      await faucetOffchain(page, primaryHubApiBaseUrl, source.entityId, hubId, WETH, '15');
      await waitForOutCapAtLeast(page, source.entityId, hubId, WETH, tokenAmount(WETH, 15n));
      const [partialSourceBefore, partialTargetBefore] = await Promise.all([
        readCrossState(page, source, hubId),
        readCrossState(page, target, targetHub.entityId),
      ]);
      expect(
        partialSourceBefore.deltas[String(WETH)],
        'source WETH delta must exist before partial fill',
      ).toBeDefined();
      expect(
        partialTargetBefore.deltas[String(USDC)],
        'target USDC delta must exist before partial fill',
      ).toBeDefined();
      const partialOrderId = await placeCrossOrder(page, {
        source,
        hubId,
        targetEntityId: target.entityId,
        side: 'sell',
        fromTokenId: WETH,
        toTokenId: USDC,
        clickBookSide: 'bid',
        expectedClickFromTokenId: WETH,
        expectedClickToTokenId: USDC,
        amount: '15',
      });
      const partial = await waitForCrossPendingFill(page, source, hubId, 'real MM WETH partial', {
        routeId: partialOrderId,
      });
      await waitForCrossRouteMaterialized(
        page,
        target,
        targetHub.entityId,
        partial.routeId,
        'real MM target partial financial leg',
      );
      const [pendingSourceState, pendingTargetState] = await Promise.all([
        readCrossState(page, source, hubId),
        readCrossState(page, target, targetHub.entityId),
      ]);
      expect(
        BigInt(pendingSourceState.deltas[String(WETH)].leftHold) +
          BigInt(pendingSourceState.deltas[String(WETH)].rightHold),
        'partial source remainder must remain held until explicit Clear',
      ).toBeGreaterThan(0n);
      expect(
        BigInt(pendingTargetState.deltas[String(USDC)].leftHold) +
          BigInt(pendingTargetState.deltas[String(USDC)].rightHold),
        'partial target remainder must remain held until explicit Clear',
      ).toBeGreaterThan(0n);
      const clearButton = page.getByTestId('cross-swap-clear').first();
      await expect(clearButton, 'real MM partial remainder must expose Clear + Close').toBeVisible({ timeout: 20_000 });
      await clearButton.click({ force: true });
      await flushRuntime(page, 5);
      await Promise.all([
        waitForCrossRouteStatus(page, source, hubId, partial.routeId, ['settled'], 'real MM source clear'),
        waitForCrossRouteStatus(page, target, targetHub.entityId, partial.routeId, ['settled'], 'real MM target clear'),
      ]);
      await waitForCrossOffersCleared(page, source, hubId, 'real MM partial clear', { orderId: partial.routeId });
      await expect
        .poll(
          async () => {
            await flushRuntime(page, 3);
            const [sourceState, targetState] = await Promise.all([
              readCrossState(page, source, hubId),
              readCrossState(page, target, targetHub.entityId),
            ]);
            return {
              sourcePulls: sourceState.pulls,
              targetPulls: targetState.pulls,
              sourcePending: sourceState.hasPendingFrame,
              targetPending: targetState.hasPendingFrame,
              sourceMempool: sourceState.mempoolTxs,
              targetMempool: targetState.mempoolTxs,
            };
          },
          {
            timeout: 75_000,
            intervals: [250, 500, 1000],
            message: 'real MM Clear + Close must release both pull legs and every Account queue',
          },
        )
        .toEqual({
          sourcePulls: 0,
          targetPulls: 0,
          sourcePending: false,
          targetPending: false,
          sourceMempool: [],
          targetMempool: [],
        });
      const [partialSourceAfter, partialTargetAfter] = await Promise.all([
        readCrossState(page, source, hubId),
        readCrossState(page, target, targetHub.entityId),
      ]);
      const partialSourceRoute = partialSourceAfter.routeSummaries.find(route => route.orderId === partial.routeId);
      const partialTargetRoute = partialTargetAfter.routeSummaries.find(route => route.orderId === partial.routeId);
      expect(partialSourceRoute, 'cleared source route must remain inspectable in Account history').toBeDefined();
      expect(partialTargetRoute, 'cleared target route must remain inspectable in Account history').toBeDefined();
      expect(partialSourceRoute?.cumulativeFillRatio).toBe(partial.ratio);
      expect(partialSourceRoute?.filledSourceAmount).toBe(partialTargetRoute?.filledSourceAmount);
      expect(partialSourceRoute?.filledTargetAmount).toBe(partialTargetRoute?.filledTargetAmount);
      expect(BigInt(partialSourceRoute!.filledSourceAmount)).toBeGreaterThan(0n);
      expect(BigInt(partialSourceRoute!.filledSourceAmount)).toBeLessThan(tokenAmount(WETH, 15n));
      await expect
        .poll(
          async () => {
            const [sourceHubDeltas, targetHubDeltas] = await Promise.all([
              readHubCrossDeltas(page, hubId, source.entityId, [WETH]),
              readHubCrossDeltas(page, targetHub.entityId, target.entityId, [USDC]),
            ]);
            return {
              source: sourceHubDeltas[String(WETH)],
              target: targetHubDeltas[String(USDC)],
            };
          },
          {
            timeout: 20_000,
            intervals: [100, 250, 500],
            message: 'both Hubs must commit the exact paired Account ACKs after partial Clear',
          },
        )
        .toEqual({
          source: partialSourceAfter.deltas[String(WETH)],
          target: partialTargetAfter.deltas[String(USDC)],
        });
      expectCrossTransfer(
        partialSourceBefore.deltas[String(WETH)],
        partialSourceAfter.deltas[String(WETH)],
        BigInt(partialSourceRoute!.filledSourceAmount),
        partialSourceBefore.ownerIsLeft,
        'spend',
        'partial source Account',
      );
      expectCrossTransfer(
        partialTargetBefore.deltas[String(USDC)],
        partialTargetAfter.deltas[String(USDC)],
        BigInt(partialTargetRoute!.filledTargetAmount),
        partialTargetBefore.ownerIsLeft,
        'receive',
        'partial target Account',
        BigInt(partialTargetAfter.currentFrameFees[String(USDC)] ?? '0'),
      );
    },
  );

  test(
    'cross USDT/USDT orderbook resolves terminal no-market when the selected route relay has no snapshots',
    { tag: '@resilience' },
    async ({ page }) => {
      const baseline = await timedStep('cross_j_no_market.ensure_baseline', () =>
        ensureE2EBaseline(page, {
          apiBaseUrl: API_BASE_URL,
          requireMarketMaker: false,
          requireHubMesh: true,
          minHubCount: 3,
        }),
      );
      const hubId = getPrimaryHubId(baseline);
      const primaryHubApiBaseUrl = getPrimaryHubApiBaseUrl(baseline, hubId);
      const primaryHubName = getPrimaryHubName(baseline, hubId);
      const targetHub = await timedStep('cross_j_no_market.resolve_rpc2_hub', () =>
        getSecondaryHubInfo(page, hubId, primaryHubName, primaryHubApiBaseUrl),
      );

      await timedStep('cross_j_no_market.goto', () =>
        gotoApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 1200 }),
      );
      const mnemonic = Wallet.createRandom().mnemonic!.phrase;
      const source = await timedStep('cross_j_no_market.create_runtime', () =>
        createRuntimeIdentityViaStore(page, 'cross-no-market', mnemonic),
      );
      await timedStep('cross_j_no_market.default_jurisdictions', () =>
        waitForDefaultJurisdictionReplicas(page, 'cross-no-market'),
      );
      const target = await timedStep('cross_j_no_market.import_rpc2_sibling', () =>
        importRpc2SiblingEntity(page, mnemonic, 'cross-no-market'),
      );
      await timedStep('cross_j_no_market.connect_primary', () =>
        connectRuntimeToHubWithCredit(page, source, hubId, '10000', SWAP_TOKENS),
      );
      await timedStep('cross_j_no_market.connect_rpc2', () =>
        ensureDirectHubAccount(page, target, targetHub.entityId, SWAP_TOKENS, 150_000),
      );

      await timedStep('cross_j_no_market.install_silent_relay', () =>
        installSilentRelayWebSocket(page, { currentPage: true }),
      );
      await timedStep('cross_j_no_market.open_swap', async () => {
        await openSwapWorkspace(page);
        await selectSourceChainInSwap(page, source.entityId);
        await selectCounterpartyInSwap(page, hubId);
        await selectCrossRoute(page, target.entityId);
        await configureTokens(page, USDT, USDT);
      });

      const orderbook = page.getByTestId('swap-orderbook').first();
      const panel = orderbook.locator('.orderbook-panel').first();
      await expect(
        orderbook,
        'cross route must keep the right-side orderbook mounted when stream is silent',
      ).toBeVisible({ timeout: 20_000 });
      await expect(panel, 'cross no-market state must still render the orderbook panel').toBeVisible({
        timeout: 20_000,
      });
      await expect
        .poll(async () => String((await panel.getAttribute('data-pair-id')) || ''), {
          timeout: 10_000,
          intervals: [100, 250, 500],
          message: 'silent cross route must subscribe to a cross venue id',
        })
        .toMatch(/^cross:/);
      await expect
        .poll(async () => hasSilentRelayMarketSubscribe(page, ['cross:']), {
          timeout: 10_000,
          intervals: [100, 250, 500],
          message: 'cross orderbook must actually send market_subscribe before terminal no-market is accepted',
        })
        .toBe(true);
      await expect
        .poll(async () => String((await panel.getAttribute('data-source-status')) || ''), {
          timeout: 12_000,
          intervals: [250, 500, 1000],
          message: 'silent cross relay must resolve to no-market instead of hanging in syncing',
        })
        .toBe('no-market');
      await expect(orderbook.getByTestId('orderbook-source-status').first()).toContainText(/No market/i, {
        timeout: 5_000,
      });
      await expect(orderbook.getByTestId('orderbook-source-status').first()).not.toContainText(/syncing|loading/i, {
        timeout: 5_000,
      });
      const recommendation = page.getByTestId('swap-route-recommendation').first();
      await expect(
        recommendation,
        'terminal no-market direct cross route should show manual route candidates',
      ).toBeVisible({ timeout: 10_000 });
      await expect
        .poll(async () => await page.getByTestId('swap-route-recommendation-row').count(), {
          timeout: 5_000,
          intervals: [100, 250, 500],
        })
        .toBeGreaterThan(0);
      await expect
        .poll(
          async () => ({
            asks: await orderbook.getByTestId('orderbook-ask-row').count(),
            bids: await orderbook.getByTestId('orderbook-bid-row').count(),
          }),
          {
            timeout: 5_000,
            intervals: [100, 250, 500],
          },
        )
        .toEqual({ asks: 0, bids: 0 });
    },
  );

  test(
    'Tron sibling inherits rebalance policy and auto-collateralizes USDC after faucet',
    { tag: '@functional' },
    async ({ page }) => {
      const baseline = await timedStep('cross_j_tron_rebalance.ensure_baseline', () =>
        ensureE2EBaseline(page, {
          apiBaseUrl: API_BASE_URL,
          requireMarketMaker: false,
          requireHubMesh: true,
          minHubCount: 3,
        }),
      );
      const hubId = getPrimaryHubId(baseline);
      const primaryHubApiBaseUrl = getPrimaryHubApiBaseUrl(baseline, hubId);
      const primaryHubName = getPrimaryHubName(baseline, hubId);
      const targetHub = await timedStep('cross_j_tron_rebalance.resolve_rpc2_hub', () =>
        getSecondaryHubInfo(page, hubId, primaryHubName, primaryHubApiBaseUrl),
      );

      await timedStep('cross_j_tron_rebalance.goto', () =>
        gotoApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 1200 }),
      );
      const mnemonic = Wallet.createRandom().mnemonic!.phrase;
      await timedStep('cross_j_tron_rebalance.create_runtime', () =>
        createRuntimeIdentityViaStore(page, 'cross-tron-rebalance', mnemonic),
      );
      await timedStep('cross_j_tron_rebalance.default_jurisdictions', () =>
        waitForDefaultJurisdictionReplicas(page, 'cross-tron-rebalance'),
      );
      const target = await timedStep('cross_j_tron_rebalance.import_rpc2_sibling', () =>
        importRpc2SiblingEntity(page, mnemonic, 'cross-tron-rebalance'),
      );
      expect(
        /tron|rpc2/i.test(target.jurisdictionName),
        `target sibling must be in Tron/rpc2 jurisdiction, got ${target.jurisdictionName}`,
      ).toBe(true);

      await timedStep('cross_j_tron_rebalance.connect_rpc2', () =>
        ensureDirectHubAccount(page, target, targetHub.entityId, SWAP_TOKENS, 150_000),
      );
      const policySnapshot = await timedStep('cross_j_tron_rebalance.wait_policy', () =>
        waitForRebalancePolicy(page, target, targetHub.entityId, USDC),
      );
      expect(policySnapshot.jurisdiction).toMatch(/tron|rpc2/i);
      expect(BigInt(policySnapshot.policy?.r2cRequestSoftLimit || '0')).toBe(DEFAULT_USDC_REBALANCE_SOFT_LIMIT);

      await timedStep('cross_j_tron_rebalance.faucet_usdc_over_soft_limit', () =>
        faucetOffchain(page, primaryHubApiBaseUrl, target.entityId, targetHub.entityId, USDC, '700'),
      );
      const secured = await timedStep('cross_j_tron_rebalance.wait_secured', () =>
        waitForRebalanceSecured(page, target, targetHub.entityId, USDC),
      );
      expect(
        BigInt(secured.collateral),
        `Tron USDC collateral must be positive: ${JSON.stringify(secured)}`,
      ).toBeGreaterThan(0n);
      expect(BigInt(secured.uncollateralized), `Tron USDC debt must be secured: ${JSON.stringify(secured)}`).toBe(0n);
      expect(
        secured.lastFinalizedJHeight,
        `Tron jwatch must finalize AccountSettled: ${JSON.stringify(secured)}`,
      ).toBeGreaterThan(0);
    },
  );

  test(
    'cross swap one-click prepares missing target account and inbound credit',
    { tag: '@functional' },
    async ({ page }) => {
      const browserConsole = attachBrowserConsoleGuard(page);
      page.on('console', message => {
        if (message.text().includes('[INFO][p2p] ingress.entity_inputs')) {
          console.log(`[E2E-P2P] ${message.text()}`);
        }
      });
      const baseline = await timedStep('cross_j_auto_setup.ensure_baseline', () =>
        ensureE2EBaseline(page, {
          apiBaseUrl: API_BASE_URL,
          requireMarketMaker: false,
          requireHubMesh: true,
          minHubCount: 3,
        }),
      );
      const hubId = getPrimaryHubId(baseline);
      const primaryHubApiBaseUrl = getPrimaryHubApiBaseUrl(baseline, hubId);
      const primaryHubName = getPrimaryHubName(baseline, hubId);
      const targetHub = await timedStep('cross_j_auto_setup.resolve_rpc2_hub', () =>
        getSecondaryHubInfo(page, hubId, primaryHubName, primaryHubApiBaseUrl),
      );

      await timedStep('cross_j_auto_setup.goto', () =>
        gotoApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 1200 }),
      );
      const mnemonic = Wallet.createRandom().mnemonic!.phrase;
      const source = await timedStep('cross_j_auto_setup.create_runtime', () =>
        createRuntimeIdentityViaStore(page, 'cross-auto-setup', mnemonic),
      );
      await timedStep('cross_j_auto_setup.default_jurisdictions', () =>
        waitForDefaultJurisdictionReplicas(page, 'cross-auto-setup'),
      );
      const target = await timedStep('cross_j_auto_setup.import_rpc2_sibling', () =>
        importRpc2SiblingEntity(page, mnemonic, 'cross-auto-setup'),
      );
      await timedStep('cross_j_auto_setup.connect_primary', () =>
        connectRuntimeToHubWithCredit(page, source, hubId, '10000', SWAP_TOKENS),
      );
      await timedStep('cross_j_auto_setup.faucet_source_weth', () =>
        faucetOffchain(page, primaryHubApiBaseUrl, source.entityId, hubId, WETH, '1'),
      );
      await timedStep('cross_j_auto_setup.wait_source_weth', () =>
        waitForOutCapAtLeast(page, source.entityId, hubId, WETH, 1n * 10n ** 16n),
      );
      await timedStep('cross_j_auto_setup.install_synthetic_relay', () =>
        installSilentRelayWebSocket(page, {
          currentPage: true,
          marketSnapshots: [
            {
              bids: [{ price: '24900000', size: 1000 }],
              asks: [{ price: '25100000', size: 1000 }],
            },
          ],
        }),
      );

      await page.evaluate(() => {
        const view = window as CrossRuntimeWindow & { __crossJFrameTrace?: unknown[]; __crossJClickAt?: number };
        const browserProcess = (
          globalThis as typeof globalThis & {
            process?: { env?: Record<string, string | undefined> };
          }
        ).process;
        if (browserProcess?.env) {
          browserProcess.env.XLN_P2P_INGRESS_PROFILE = '1';
        }
        const longTasks: Array<{ startTime: number; duration: number; name: string }> = [];
        (view as typeof view & { __crossJLongTasks?: typeof longTasks }).__crossJLongTasks = longTasks;
        if (typeof PerformanceObserver === 'function') {
          const observer = new PerformanceObserver(list => {
            for (const entry of list.getEntries()) {
              longTasks.push({
                startTime: Math.round(entry.startTime),
                duration: Math.round(entry.duration),
                name: entry.name,
              });
            }
          });
          observer.observe({ entryTypes: ['longtask'] });
        }
        const env = view.isolatedEnv;
        const runtimeModule = view.__xln?.instance;
        if (!env || typeof runtimeModule?.registerRuntimeFrameCommitCallback !== 'function') {
          throw new Error('cross-j Runtime frame trace API missing');
        }
        view.__crossJFrameTrace = [];
        runtimeModule.registerRuntimeFrameCommitCallback(env, ({ height, runtimeInput }: any) => {
          const activeEnv = view.isolatedEnv;
          const effectiveTxs = (input: any) =>
            Array.from(input?.entityTxs || []).flatMap((tx: any) =>
              tx?.type === 'consensusOutput' || tx?.type === 'runtimeOutput'
                ? Array.from(tx?.data?.entityTxs || [])
                : [tx],
            );
          const accountInputs = (input: any) =>
            effectiveTxs(input).flatMap((tx: any) => {
              if (tx?.type !== 'accountInput') return [];
              const data = tx.data || {};
              return [
                {
                  entityId: String(input.entityId || ''),
                  runtimeId: String(input.runtimeId || ''),
                  sourceRuntimeFrame: input.sourceRuntimeFrame || null,
                  kind: String(data.kind || ''),
                  ackHeight: Number(data.ack?.height ?? -1),
                  proposalHeight: Number(data.proposal?.frame?.height ?? -1),
                  accountTxTypes: Array.from(data.proposal?.frame?.accountTxs || []).map((accountTx: any) =>
                    String(accountTx?.type || ''),
                  ),
                },
              ];
            });
          view.__crossJFrameTrace!.push({
            height,
            wallAfterClickMs: view.__crossJClickAt ? Date.now() - view.__crossJClickAt : null,
            inputEntityTxTypes: Array.from(runtimeInput?.entityInputs || []).map((input: any) => ({
              entityId: String(input?.entityId || ''),
              txTypes: effectiveTxs(input).map((tx: any) => String(tx?.type || '')),
            })),
            crossRoutes: Array.from(activeEnv?.eReplicas?.values?.() || []).flatMap((replica: any) =>
              Array.from(replica?.state?.crossJurisdictionSwaps?.values?.() || []).map((route: any) => ({
                entityId: String(replica?.state?.entityId || replica?.entityId || ''),
                orderId: String(route?.orderId || ''),
                status: String(route?.status || ''),
              })),
            ),
            inputAccountInputs: Array.from(runtimeInput?.entityInputs || []).flatMap(accountInputs),
            inputReliableReceipts: Array.from(runtimeInput?.reliableReceipts || []).map((receipt: any) => ({
              kind: String(receipt?.body?.identity?.kind || ''),
              height: Number(receipt?.body?.identity?.height ?? -1),
              coverage: String(receipt?.body?.coverage || ''),
              receiverRuntimeId: String(receipt?.body?.receiverRuntimeId || ''),
            })),
            pendingOutputAccountInputs: Array.from(activeEnv?.pendingNetworkOutputs || []).flatMap(accountInputs),
          });
        });
      });

      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.start');
      await timedStep('cross_j_auto_setup.submit_one_click_swap', () =>
        placeCrossOrder(page, {
          source,
          hubId,
          targetEntityId: target.entityId,
          side: 'sell',
          amount: '0.01',
          price: '2490.0000',
          clickBookSide: 'bid',
          expectedClickFromTokenId: WETH,
          expectedClickToTokenId: USDC,
          expectSetupConsent: true,
        }),
      );
      const { profile } = (await cdp.send('Profiler.stop')) as {
        profile: {
          nodes: Array<{
            id: number;
            callFrame: { functionName: string; url: string; lineNumber: number };
            children?: number[];
          }>;
          samples?: number[];
          timeDeltas?: number[];
        };
      };
      await cdp.detach();
      const cpuByNode = new Map<number, number>();
      for (const [index, nodeId] of (profile.samples ?? []).entries()) {
        cpuByNode.set(nodeId, (cpuByNode.get(nodeId) ?? 0) + Number(profile.timeDeltas?.[index] ?? 0) / 1000);
      }
      const nodeById = new Map(profile.nodes.map(node => [node.id, node]));
      const parentById = new Map<number, number>();
      for (const node of profile.nodes) {
        for (const childId of node.children ?? []) parentById.set(childId, node.id);
      }
      const inclusiveCpuByNode = new Map<number, number>();
      for (const [index, sampleNodeId] of (profile.samples ?? []).entries()) {
        const sampleMs = Number(profile.timeDeltas?.[index] ?? 0) / 1000;
        let nodeId: number | undefined = sampleNodeId;
        while (nodeId !== undefined) {
          inclusiveCpuByNode.set(nodeId, (inclusiveCpuByNode.get(nodeId) ?? 0) + sampleMs);
          nodeId = parentById.get(nodeId);
        }
      }
      const cpuTop = [...cpuByNode]
        .map(([nodeId, selfMs]) => ({ node: nodeById.get(nodeId), selfMs: Math.round(selfMs) }))
        .filter(row => row.node && row.node.callFrame.functionName !== '(idle)')
        .sort((left, right) => right.selfMs - left.selfMs)
        .slice(0, 20)
        .map(row => ({
          functionName: row.node!.callFrame.functionName,
          selfMs: row.selfMs,
          url: row.node!.callFrame.url,
          lineNumber: row.node!.callFrame.lineNumber + 1,
        }));
      const longTasks = await page.evaluate(
        () =>
          (
            window as CrossRuntimeWindow & {
              __crossJLongTasks?: Array<{ startTime: number; duration: number; name: string }>;
            }
          ).__crossJLongTasks ?? [],
      );
      console.log(`[E2E-CROSS-J-CPU] ${JSON.stringify(cpuTop)}`);
      const inclusiveCpuTop = [...inclusiveCpuByNode]
        .map(([nodeId, inclusiveMs]) => ({ node: nodeById.get(nodeId), inclusiveMs: Math.round(inclusiveMs) }))
        .filter(row => row.node && !['(root)', '(idle)', '(program)'].includes(row.node.callFrame.functionName))
        .sort((left, right) => right.inclusiveMs - left.inclusiveMs)
        .slice(0, 40)
        .map(row => ({
          functionName: row.node!.callFrame.functionName,
          inclusiveMs: row.inclusiveMs,
          url: row.node!.callFrame.url,
          lineNumber: row.node!.callFrame.lineNumber + 1,
        }));
      console.log(`[E2E-CROSS-J-CPU-INCLUSIVE] ${JSON.stringify(inclusiveCpuTop)}`);
      console.log(`[E2E-CROSS-J-LONG-TASKS] ${JSON.stringify(longTasks.slice(-30))}`);
      const frameTrace = await page.evaluate(
        () => (window as CrossRuntimeWindow & { __crossJFrameTrace?: unknown[] }).__crossJFrameTrace ?? [],
      );
      console.log(`[E2E-CROSS-J-FRAMES] ${JSON.stringify(frameTrace)}`);

      await timedStep('cross_j_auto_setup.wait_target_account', () =>
        waitForAccountReady(page, target, targetHub.entityId, [USDC], 90_000),
      );
      const expectedTargetAmount = 24_900_000n;
      await expect
        .poll(
          async () =>
            page.evaluate(
              ({ entityId, hubId, tokenId }) => {
                const env = (window as CrossRuntimeWindow).isolatedEnv;
                const owner = String(entityId).toLowerCase();
                const counterparty = String(hubId).toLowerCase();
                const replica = Array.from(env?.eReplicas?.values?.() || []).find(
                  (candidate: any) =>
                    String(candidate?.state?.entityId || candidate?.entityId || '').toLowerCase() === owner,
                );
                const account = replica?.state?.accounts?.get?.(counterparty);
                const delta = account?.deltas?.get?.(tokenId);
                if (!account || !delta) return null;
                const ownerIsLeft = owner === String(account.leftEntity || '').toLowerCase();
                return {
                  peerCreditLimit: String(ownerIsLeft ? delta.rightCreditLimit : delta.leftCreditLimit),
                  inboundHold: String(ownerIsLeft ? delta.rightHold : delta.leftHold),
                };
              },
              {
                entityId: target.entityId,
                hubId: targetHub.entityId,
                tokenId: USDC,
              },
            ),
          {
            timeout: 30_000,
            intervals: [250, 500, 1000],
            message: 'one-click cross swap must grant and lock only the exact target USDC amount',
          },
        )
        .toEqual({
          peerCreditLimit: expectedTargetAmount.toString(),
          inboundHold: expectedTargetAmount.toString(),
        });
      expect(
        await inCap(page, target.entityId, targetHub.entityId, USDC),
        'the exact target credit is fully reserved by the cross-j pull',
      ).toBe(0n);
      expectBrowserConsoleClean(browserConsole, 'cross_j_auto_setup');
    },
  );

  test(
    'cross WETH/USDC ignores non-takeable orderbook side before filling the takeable side',
    { tag: '@resilience' },
    async ({ page }) => {
      const baseline = await timedStep('cross_j_wrong_side.ensure_baseline', () =>
        ensureE2EBaseline(page, {
          apiBaseUrl: API_BASE_URL,
          requireMarketMaker: false,
          requireHubMesh: true,
          minHubCount: 3,
        }),
      );
      const hubId = getPrimaryHubId(baseline);
      const primaryHubApiBaseUrl = getPrimaryHubApiBaseUrl(baseline, hubId);
      const primaryHubName = getPrimaryHubName(baseline, hubId);
      const targetHub = await timedStep('cross_j_wrong_side.resolve_rpc2_hub', () =>
        getSecondaryHubInfo(page, hubId, primaryHubName, primaryHubApiBaseUrl),
      );

      await timedStep('cross_j_wrong_side.goto', () =>
        gotoApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 1200 }),
      );
      const mnemonic = Wallet.createRandom().mnemonic!.phrase;
      const source = await timedStep('cross_j_wrong_side.create_runtime', () =>
        createRuntimeIdentityViaStore(page, 'cross-wrong-side', mnemonic),
      );
      await timedStep('cross_j_wrong_side.default_jurisdictions', () =>
        waitForDefaultJurisdictionReplicas(page, 'cross-wrong-side'),
      );
      const target = await timedStep('cross_j_wrong_side.import_rpc2_sibling', () =>
        importRpc2SiblingEntity(page, mnemonic, 'cross-wrong-side'),
      );
      await timedStep('cross_j_wrong_side.connect_primary', () =>
        connectRuntimeToHubWithCredit(page, source, hubId, '10000', SWAP_TOKENS),
      );
      await timedStep('cross_j_wrong_side.connect_rpc2', () =>
        ensureDirectHubAccount(page, target, targetHub.entityId, SWAP_TOKENS, 150_000),
      );
      await timedStep('cross_j_wrong_side.faucet_source_weth', () =>
        faucetOffchain(page, primaryHubApiBaseUrl, source.entityId, hubId, WETH, '1'),
      );
      await timedStep('cross_j_wrong_side.wait_source_weth', () =>
        waitForOutCapAtLeast(page, source.entityId, hubId, WETH, 1n * 10n ** 16n),
      );

      await timedStep('cross_j_wrong_side.install_synthetic_relay', () =>
        installSilentRelayWebSocket(page, {
          currentPage: true,
          marketSnapshots: [
            {
              bids: [{ price: '24900000', size: 1000 }],
              asks: [{ price: '25100000', size: 1000 }],
            },
          ],
        }),
      );
      await timedStep('cross_j_wrong_side.open_swap', async () => {
        await openSwapWorkspace(page);
        await selectSourceChainInSwap(page, source.entityId);
        await selectCounterpartyInSwap(page, hubId);
        await configurePair(page, 'sell');
        await selectCrossRoute(page, target.entityId);
      });

      await expectCrossOrderbookReady(page);
      await expectSwapTokens(page, WETH, USDC);
      await expectDirectCrossOrderbookReady(page);
      await expectCrossOrderbookReady(page);
      await expectSwapTokens(page, WETH, USDC);
      await expect(visibleOrderbookRow(page, 'ask'), 'synthetic cross book must show a non-takeable ask').toBeVisible({
        timeout: 10_000,
      });
      await expect(visibleOrderbookRow(page, 'bid'), 'synthetic cross book must show a takeable bid').toBeVisible({
        timeout: 10_000,
      });

      await expectCrossNonTakeableClickNoop(page, 'ask', WETH, USDC);
      await clickCrossOrderbookLevel(page, 'bid', WETH, USDC);
    },
  );

  test(
    'cross WETH/USDT displays prices as stable quote per WETH for Tron source',
    { tag: '@functional' },
    async ({ page }) => {
      const baseline = await timedStep('cross_j_stable_quote.ensure_baseline', () =>
        ensureE2EBaseline(page, {
          apiBaseUrl: API_BASE_URL,
          requireMarketMaker: false,
          requireHubMesh: true,
          minHubCount: 3,
        }),
      );
      const testnetHubId = getPrimaryHubId(baseline);
      const primaryHubApiBaseUrl = getPrimaryHubApiBaseUrl(baseline, testnetHubId);
      const primaryHubName = getPrimaryHubName(baseline, testnetHubId);
      const tronHub = await timedStep('cross_j_stable_quote.resolve_rpc2_hub', () =>
        getSecondaryHubInfo(page, testnetHubId, primaryHubName, primaryHubApiBaseUrl),
      );

      await timedStep('cross_j_stable_quote.goto', () =>
        gotoApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 1200 }),
      );
      const mnemonic = Wallet.createRandom().mnemonic!.phrase;
      const testnetEntity = await timedStep('cross_j_stable_quote.create_runtime', () =>
        createRuntimeIdentityViaStore(page, 'cross-stable-quote', mnemonic),
      );
      await timedStep('cross_j_stable_quote.default_jurisdictions', () =>
        waitForDefaultJurisdictionReplicas(page, 'cross-stable-quote'),
      );
      const tronEntity = await timedStep('cross_j_stable_quote.import_rpc2_sibling', () =>
        importRpc2SiblingEntity(page, mnemonic, 'cross-stable-quote'),
      );
      await timedStep('cross_j_stable_quote.connect_testnet', () =>
        connectRuntimeToHubWithCredit(page, testnetEntity, testnetHubId, '10000', SWAP_TOKENS),
      );
      await timedStep('cross_j_stable_quote.connect_tron', () =>
        ensureDirectHubAccount(page, tronEntity, tronHub.entityId, SWAP_TOKENS, 150_000),
      );

      await timedStep('cross_j_stable_quote.install_synthetic_relay', () =>
        installSilentRelayWebSocket(page, {
          currentPage: true,
          marketSnapshots: [
            {
              bids: [{ price: '25000000', size: 1000 }],
              asks: [{ price: '25100000', size: 1000 }],
            },
          ],
        }),
      );
      await timedStep('cross_j_stable_quote.open_swap', async () => {
        await openSwapWorkspace(page);
        await selectSourceChainInSwap(page, tronEntity.entityId);
        await selectCounterpartyInSwap(page, tronHub.entityId);
        await configureTokens(page, WETH, USDT);
        await selectCrossRoute(page, testnetEntity.entityId);
      });

      await expectCrossOrderbookReady(page, {
        titlePattern: /WETH\s*\(Tron\)\s*-\s*USDT\s*\(Testnet\)/,
        pairIdPattern: /^cross:stack:31338:[^/]+:2\/stack:31337:[^/]+:3$/,
      });
      const tokenOptions = await page.evaluate(() => {
        const optionTexts = (selector: string) =>
          Array.from(document.querySelectorAll(`${selector} option`))
            .map(option => String((option as HTMLOptionElement).textContent || '').trim())
            .filter(Boolean);
        return {
          from: optionTexts('[data-testid="swap-from-token-select"]'),
          to: optionTexts('[data-testid="swap-to-token-select"]'),
        };
      });
      expect(tokenOptions.from, 'Tron source token list must expose Tron-only assets').toEqual(
        expect.arrayContaining(['TRX (Tron)', 'SUN (Tron)']),
      );
      expect(
        tokenOptions.to.some(label => /^(TRX|SUN)(?:\s|\(|$)/.test(label)),
        'Testnet target token list must not leak Tron-only assets',
      ).toBe(false);
      await expect(
        page.getByTestId('orderbook-bid-row').first().locator('.price'),
        'cross WETH/USDT price must be displayed as USDT per WETH, not inverted WETH per USDT',
      ).toHaveText('2500.0000', { timeout: 10_000 });
      await expectSwapTokens(page, WETH, USDT);

      const dropdownPairLabel = await selectOrderbookPairByLabel(page, /USDT\s*\(Testnet\)\s*-\s*USDT\s*\(Tron\)/i);
      expect(dropdownPairLabel).toMatch(/USDT\s*\(Testnet\)\s*-\s*USDT\s*\(Tron\)/i);
      const marketSection = page.getByTestId('swap-market-section').first();
      await expect
        .poll(
          async () => ({
            mode: String((await marketSection.getAttribute('data-last-orderbook-pair-select-mode')) || ''),
            commit: String((await marketSection.getAttribute('data-last-orderbook-pair-select-commit')) || ''),
            route: String((await marketSection.getAttribute('data-last-orderbook-pair-select-route')) || ''),
            value: String((await marketSection.getAttribute('data-last-orderbook-pair-select-value')) || ''),
          }),
          {
            timeout: 5_000,
            intervals: [50, 100, 200],
            message: 'cross orderbook dropdown must commit the selected cross pair',
          },
        )
        .toMatchObject({ mode: 'cross', commit: 'cross-committed' });
      await expectSwapTokens(page, USDT, USDT);
      const panel = page.getByTestId('swap-orderbook').first().locator('.orderbook-panel').first();
      await expect
        .poll(async () => String((await panel.getAttribute('data-pair-id')) || ''), {
          timeout: 10_000,
          intervals: [100, 250, 500],
          message: 'cross orderbook dropdown must switch the subscribed venue id',
        })
        .toMatch(/^cross:stack:31337:[^/]+:3\/stack:31338:[^/]+:3$/);
      await expectSwapAssetRoute(page, USDT, 'Tron', USDT, 'Testnet');

      await timedStep('cross_j_stable_quote.reverse_same_symbol_asset_identity', async () => {
        await page.getByTestId('swap-flip-tokens').first().click();
      });
      await expectSwapAssetRoute(page, USDT, 'Testnet', USDT, 'Tron');
      await expectCrossOrderbookReady(page, {
        titlePattern: /USDT\s*\(Testnet\)\s*-\s*USDT\s*\(Tron\)/,
        pairIdPattern: /^cross:stack:31337:[^/]+:3\/stack:31338:[^/]+:3$/,
      });

      await timedStep('cross_j_stable_quote.restore_original_cross_direction', async () => {
        await page.getByTestId('swap-flip-tokens').first().click();
      });
      await expectSwapAssetRoute(page, USDT, 'Tron', USDT, 'Testnet');

      await timedStep('cross_j_stable_quote.configure_reverse_stable_source', async () => {
        await configureTokens(page, USDT, WETH);
        await selectCrossRoute(page, testnetEntity.entityId);
      });
      await expectCrossOrderbookReady(page, {
        titlePattern: /WETH\s*\(Testnet\)\s*-\s*USDT\s*\(Tron\)/,
        pairIdPattern: /^cross:stack:31337:[^/]+:2\/stack:31338:[^/]+:3$/,
      });
      await expect(
        page.getByTestId('orderbook-bid-row').first().locator('.price'),
        'cross USDT/WETH must still display stable quote per WETH, not inverted WETH per USDT',
      ).toHaveText('2500.0000', { timeout: 10_000 });
      await expectSwapTokens(page, USDT, WETH);
    },
  );

  test(
    'two users can place full, partial, and disputed cross-j swaps through the shared swap builder',
    { tag: '@resilience' },
    async ({ browser, page }) => {
      let aliceContext: BrowserContext | null = null;
      let bobContext: BrowserContext | null = null;

      try {
        const baseline = await timedStep('cross_j_swap.ensure_baseline', () =>
          ensureE2EBaseline(page, {
            apiBaseUrl: API_BASE_URL,
            requireMarketMaker: false,
            requireHubMesh: true,
            minHubCount: 3,
          }),
        );
        const hubId = getPrimaryHubId(baseline);
        const primaryHubApiBaseUrl = getPrimaryHubApiBaseUrl(baseline, hubId);
        const primaryHubName = getPrimaryHubName(baseline, hubId);
        const primaryHubRuntimeSeed = getIsolatedHubRuntimeSeed(primaryHubName);
        const targetHub = await timedStep('cross_j_swap.resolve_rpc2_hub', () =>
          getSecondaryHubInfo(page, hubId, primaryHubName, primaryHubApiBaseUrl),
        );
        const targetHubId = targetHub.entityId;

        aliceContext = await browser.newContext({ ignoreHTTPSErrors: true });
        bobContext = await browser.newContext({ ignoreHTTPSErrors: true });
        const alicePage = await aliceContext.newPage();
        const bobPage = await bobContext.newPage();

        await Promise.all([
          timedStep('cross_j_swap.alice.goto', () =>
            gotoApp(alicePage, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 1200 }),
          ),
          timedStep('cross_j_swap.bob.goto', () =>
            gotoApp(bobPage, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 1200 }),
          ),
        ]);

        // Cross-j tests reset the hub mesh aggressively. Reusing demo mnemonics
        // reuses runtimeId/entityId, so a fresh browser can accidentally pair a
        // local restored account with a reset hub or receive stale relay frames.
        // New mnemonics keep every run in a distinct bilateral namespace.
        const aliceMnemonic = Wallet.createRandom().mnemonic!.phrase;
        const bobMnemonic = Wallet.createRandom().mnemonic!.phrase;
        const alice = await timedStep('cross_j_swap.alice.create_runtime', () =>
          createRuntimeIdentityViaStore(alicePage, 'alice-cross', aliceMnemonic),
        );
        const bob = await timedStep('cross_j_swap.bob.create_runtime', () =>
          createRuntimeIdentityViaStore(bobPage, 'bob-cross', bobMnemonic),
        );
        await Promise.all([
          timedStep('cross_j_swap.alice.default_jurisdictions', () =>
            waitForDefaultJurisdictionReplicas(alicePage, 'alice'),
          ),
          timedStep('cross_j_swap.bob.default_jurisdictions', () => waitForDefaultJurisdictionReplicas(bobPage, 'bob')),
        ]);

        const [aliceRpc2, bobRpc2] = await Promise.all([
          timedStep('cross_j_swap.alice.import_rpc2_sibling', () =>
            importRpc2SiblingEntity(alicePage, aliceMnemonic, 'alice'),
          ),
          timedStep('cross_j_swap.bob.import_rpc2_sibling', () => importRpc2SiblingEntity(bobPage, bobMnemonic, 'bob')),
        ]);

        await Promise.all([
          timedStep('cross_j_swap.alice.connect_primary', () =>
            connectRuntimeToHubWithCredit(alicePage, alice, hubId, '10000', SWAP_TOKENS),
          ),
          timedStep('cross_j_swap.bob.connect_primary', () =>
            connectRuntimeToHubWithCredit(bobPage, bob, hubId, '10000', SWAP_TOKENS),
          ),
        ]);
        await Promise.all([
          timedStep('cross_j_swap.alice.connect_rpc2', () =>
            ensureDirectHubAccount(alicePage, aliceRpc2, targetHubId, SWAP_TOKENS, 150_000),
          ),
          timedStep('cross_j_swap.bob.connect_rpc2', () =>
            ensureDirectHubAccount(bobPage, bobRpc2, targetHubId, SWAP_TOKENS, 150_000),
          ),
        ]);

        await Promise.all([
          faucetOffchain(alicePage, primaryHubApiBaseUrl, alice.entityId, hubId, WETH, '1'),
          faucetOffchain(alicePage, primaryHubApiBaseUrl, alice.entityId, hubId, USDT, '100'),
          faucetOffchain(bobPage, primaryHubApiBaseUrl, bobRpc2.entityId, targetHubId, USDC, '200'),
          faucetOffchain(bobPage, primaryHubApiBaseUrl, bobRpc2.entityId, targetHubId, USDT, '100'),
        ]);
        await Promise.all([
          waitForOutCapAtLeast(alicePage, alice.entityId, hubId, WETH, tokenAmount(WETH, 3n) / 100n),
          waitForOutCapAtLeast(alicePage, alice.entityId, hubId, USDT, tokenAmount(USDT, 25n)),
          waitForOutCapAtLeast(bobPage, bobRpc2.entityId, targetHubId, USDC, tokenAmount(USDC, 78n)),
          waitForOutCapAtLeast(bobPage, bobRpc2.entityId, targetHubId, USDT, tokenAmount(USDT, 25n)),
        ]);

        const aliceUsdtOrderId = await timedStep('cross_j_swap.usdt.alice_eth_to_tron_offer', () =>
          placeCrossOrder(alicePage, {
            source: alice,
            hubId,
            targetEntityId: aliceRpc2.entityId,
            side: 'sell',
            fromTokenId: USDT,
            toTokenId: USDT,
            amount: '25',
            price: '1',
          }),
        );
        const bobUsdtOrderId = await timedStep('cross_j_swap.usdt.bob_tron_to_eth_offer', () =>
          placeCrossOrder(bobPage, {
            source: bobRpc2,
            hubId: targetHubId,
            targetEntityId: bob.entityId,
            side: 'sell',
            fromTokenId: USDT,
            toTokenId: USDT,
            clickBookSide: 'ask',
            expectedClickFromTokenId: USDT,
            expectedClickToTokenId: USDT,
            amount: '25',
            price: '1',
          }),
        );
        await Promise.all([
          waitForCrossPullFlow(alicePage, alice, aliceRpc2, hubId, targetHubId, {
            sourceRouteId: aliceUsdtOrderId,
            targetRouteId: aliceUsdtOrderId,
          }),
          waitForCrossPullFlow(bobPage, bobRpc2, bob, targetHubId, hubId, {
            sourceRouteId: bobUsdtOrderId,
            targetRouteId: bobUsdtOrderId,
          }),
        ]);
        await Promise.all([
          waitForCrossOffersCleared(alicePage, alice, hubId, 'Alice USDT/USDT', { orderId: aliceUsdtOrderId }),
          waitForCrossOffersCleared(bobPage, bobRpc2, targetHubId, 'Bob USDT/USDT', { orderId: bobUsdtOrderId }),
        ]);

        const aliceFullOrderId = await timedStep('cross_j_swap.full.alice_offer', () =>
          placeCrossOrder(alicePage, {
            source: alice,
            hubId,
            targetEntityId: aliceRpc2.entityId,
            side: 'sell',
            checkMultihopDeferred: true,
            amount: '0.03',
            price: '2500',
          }),
        );
        const bobFullOrderId = await timedStep('cross_j_swap.full.bob_offer', () =>
          placeCrossOrder(bobPage, {
            source: bobRpc2,
            hubId: targetHubId,
            targetEntityId: bob.entityId,
            side: 'buy',
            clickBookSide: 'ask',
            amount: '78',
            price: '2600',
          }),
        );

        await Promise.all([
          waitForCrossPullFlow(alicePage, alice, aliceRpc2, hubId, targetHubId, {
            sourceRouteId: aliceFullOrderId,
            targetRouteId: aliceFullOrderId,
          }),
          waitForCrossPullFlow(bobPage, bobRpc2, bob, targetHubId, hubId, {
            sourceRouteId: bobFullOrderId,
            targetRouteId: bobFullOrderId,
          }),
        ]);

        await Promise.all([
          waitForCrossOffersCleared(alicePage, alice, hubId, 'Alice full', { orderId: aliceFullOrderId }),
          waitForCrossOffersCleared(bobPage, bobRpc2, targetHubId, 'Bob full', { orderId: bobFullOrderId }),
        ]);
        const bobFullResolve = await timedStep('cross_j_swap.full.bob_price_improvement', () =>
          waitForLatestCrossResolveSnapshot(bobPage, bobRpc2.entityId, targetHubId, 1),
        );
        expect(bobFullResolve.fillRatio, 'Bob source-savings fill must consume the full target ratio').toBe(65_535);
        expect(bobFullResolve.cancelRemainder, 'Bob source-savings terminal fill must remove the terminal order').toBe(
          true,
        );
        expect(
          bobFullResolve.executionGiveAmount,
          'Bob spends the improved execution source, not his 78 USDC limit',
        ).toBe(tokenAmount(USDC, 75n).toString());
        expect(bobFullResolve.executionWantAmount, 'Bob receives exactly the committed 0.03 WETH target').toBe(
          (tokenAmount(WETH, 3n) / 100n).toString(),
        );

        await Promise.all([
          waitForOutCapAtLeast(alicePage, aliceRpc2.entityId, targetHubId, USDC, tokenAmount(USDC, 25n)),
          waitForOutCapAtLeast(bobPage, bob.entityId, hubId, WETH, tokenAmount(WETH, 1n) / 100n),
        ]);
        const aliceReverseOrderId = await timedStep('cross_j_swap.reverse.alice_offer', () =>
          placeCrossOrder(alicePage, {
            source: aliceRpc2,
            hubId: targetHubId,
            targetEntityId: alice.entityId,
            side: 'buy',
            amount: '25',
            price: '2500',
          }),
        );
        const bobReverseOrderId = await timedStep('cross_j_swap.reverse.bob_offer', () =>
          placeCrossOrder(bobPage, {
            source: bob,
            hubId,
            targetEntityId: bobRpc2.entityId,
            side: 'sell',
            clickBookSide: 'bid',
            amount: '0.01',
            price: '2500',
          }),
        );
        await Promise.all([
          waitForCrossPullFlow(alicePage, aliceRpc2, alice, targetHubId, hubId, {
            sourceRouteId: aliceReverseOrderId,
            targetRouteId: aliceReverseOrderId,
          }),
          waitForCrossPullFlow(bobPage, bob, bobRpc2, hubId, targetHubId, {
            sourceRouteId: bobReverseOrderId,
            targetRouteId: bobReverseOrderId,
          }),
        ]);
        await Promise.all([
          waitForCrossOffersCleared(alicePage, aliceRpc2, targetHubId, 'Alice reverse', {
            orderId: aliceReverseOrderId,
          }),
          waitForCrossOffersCleared(bobPage, bob, hubId, 'Bob reverse', { orderId: bobReverseOrderId }),
        ]);

        await Promise.all([
          faucetOffchain(alicePage, primaryHubApiBaseUrl, alice.entityId, hubId, WETH, '1'),
          faucetOffchain(bobPage, primaryHubApiBaseUrl, bobRpc2.entityId, targetHubId, USDC, '100'),
        ]);
        await Promise.all([
          waitForOutCapAtLeast(alicePage, alice.entityId, hubId, WETH, tokenAmount(WETH, 6n) / 100n),
          waitForOutCapAtLeast(bobPage, bobRpc2.entityId, targetHubId, USDC, tokenAmount(USDC, 75n)),
        ]);

        const alicePartialOrderId = await timedStep('cross_j_swap.partial.alice_offer', () =>
          placeCrossOrder(alicePage, {
            source: alice,
            hubId,
            targetEntityId: aliceRpc2.entityId,
            side: 'sell',
            amount: '0.04',
            price: '2500',
          }),
        );
        const bobPartialFirstOrderId = await timedStep('cross_j_swap.partial.bob_offer', () =>
          placeCrossOrder(bobPage, {
            source: bobRpc2,
            hubId: targetHubId,
            targetEntityId: bob.entityId,
            side: 'buy',
            clickBookSide: 'ask',
            amount: '25',
            price: '2500',
          }),
        );

        const [aliceFirstPartial] = await Promise.all([
          timedStep('cross_j_swap.partial.alice_pending_fill', () =>
            waitForCrossPendingFill(alicePage, alice, hubId, 'Alice partial', { routeId: alicePartialOrderId }),
          ),
          timedStep('cross_j_swap.partial.bob_first_cleared', () =>
            waitForCrossOffersCleared(bobPage, bobRpc2, targetHubId, 'Bob first partial counter-order', {
              orderId: bobPartialFirstOrderId,
            }),
          ),
        ]);

        const bobPartialSecondOrderId = await timedStep('cross_j_swap.partial.bob_second_offer', () =>
          placeCrossOrder(bobPage, {
            source: bobRpc2,
            hubId: targetHubId,
            targetEntityId: bob.entityId,
            side: 'buy',
            clickBookSide: 'ask',
            amount: '25',
            price: '2500',
          }),
        );

        const aliceSecondPartial = await timedStep('cross_j_swap.partial.alice_second_pending_fill', () =>
          waitForCrossPendingFill(alicePage, alice, hubId, 'Alice second partial', {
            routeId: aliceFirstPartial.routeId,
            minFillSeq: aliceFirstPartial.fillSeq + 1,
            minRatioExclusive: aliceFirstPartial.ratio,
          }),
        );
        expect(aliceSecondPartial.routeId).toBe(aliceFirstPartial.routeId);
        expect(aliceSecondPartial.ratio).toBeGreaterThan(aliceFirstPartial.ratio);

        await timedStep('cross_j_swap.partial.bob_second_cleared', () =>
          waitForCrossOffersCleared(bobPage, bobRpc2, targetHubId, 'Bob second partial counter-order', {
            orderId: bobPartialSecondOrderId,
          }),
        );

        await timedStep('cross_j_swap.partial.alice_cancel_clear_button', async () => {
          const beforeClear = await readCrossState(alicePage, alice, hubId);
          expect(beforeClear.pulls, 'Alice partial source pull must be locked before Clear + Close').toBeGreaterThan(0);
          const clearButton = alicePage.getByTestId('cross-swap-clear').first();
          await expect(clearButton).toBeVisible({ timeout: 20_000 });
          await clearButton.click({ force: true });
          await flushRuntime(alicePage, 5);
        });

        await Promise.all([
          timedStep('cross_j_swap.partial.alice_source_claimed', () =>
            waitForCrossRouteStatus(
              alicePage,
              alice,
              hubId,
              aliceSecondPartial.routeId,
              ['source_claimed', 'settled'],
              'Alice source clear',
            ),
          ),
          timedStep('cross_j_swap.partial.alice_target_settled', () =>
            waitForCrossRouteStatus(
              alicePage,
              aliceRpc2,
              targetHubId,
              aliceSecondPartial.routeId,
              ['settled'],
              'Alice target clear',
            ),
          ),
        ]);
        await timedStep('cross_j_swap.partial.alice_remainder_removed', () =>
          waitForCrossOffersCleared(alicePage, alice, hubId, 'Alice partial cancel-clear', {
            orderId: aliceSecondPartial.routeId,
          }),
        );
        await timedStep('cross_j_swap.partial.alice_source_remainder_released', () =>
          expect
            .poll(
              async () => {
                await flushRuntime(alicePage, 3);
                const state = await readCrossState(alicePage, alice, hubId);
                return {
                  pulls: state.pulls,
                  hasPendingFrame: state.hasPendingFrame,
                  mempoolTxs: state.mempoolTxs,
                };
              },
              {
                timeout: 45_000,
                intervals: [250, 500, 1000],
                message: 'Alice partial Clear + Close must release the source pull remainder',
              },
            )
            .toMatchObject({ pulls: 0, hasPendingFrame: false, mempoolTxs: [] }),
        );
        await timedStep('cross_j_swap.partial.alice_target_remainder_released', () =>
          expect
            .poll(
              async () => {
                await flushRuntime(alicePage, 3);
                const state = await readCrossState(alicePage, aliceRpc2, targetHubId);
                return {
                  pulls: state.pulls,
                  hasPendingFrame: state.hasPendingFrame,
                  mempoolTxs: state.mempoolTxs,
                };
              },
              {
                timeout: 45_000,
                intervals: [250, 500, 1000],
                message: 'Alice partial Clear + Close must release the target pull remainder',
              },
            )
            .toMatchObject({ pulls: 0, hasPendingFrame: false, mempoolTxs: [] }),
        );

        const aliceDisputeOrderId = await timedStep('cross_j_swap.dispute.alice_offer', () =>
          placeCrossOrder(alicePage, {
            source: alice,
            hubId,
            targetEntityId: aliceRpc2.entityId,
            side: 'sell',
            amount: '0.04',
            price: '2500',
          }),
        );
        const bobDisputeOrderId = await timedStep('cross_j_swap.dispute.bob_offer', () =>
          placeCrossOrder(bobPage, {
            source: bobRpc2,
            hubId: targetHubId,
            targetEntityId: bob.entityId,
            side: 'buy',
            clickBookSide: 'ask',
            amount: '25',
            price: '2500',
          }),
        );

        const [aliceDisputePartial] = await Promise.all([
          timedStep('cross_j_swap.dispute.alice_pending_fill', () =>
            waitForCrossPendingFill(alicePage, alice, hubId, 'Alice dispute route', { routeId: aliceDisputeOrderId }),
          ),
          timedStep('cross_j_swap.dispute.bob_cleared', () =>
            waitForCrossOffersCleared(bobPage, bobRpc2, targetHubId, 'Bob dispute counter-order', {
              orderId: bobDisputeOrderId,
            }),
          ),
        ]);

        // Bob can disappear after submitting the counter-order. Dispute salvage is driven by
        // Alice/source+target sibling state and must not require the counterparty browser.
        await bobContext.close();
        bobContext = null;

        await timedStep('cross_j_swap.dispute.target_route_ready', () =>
          waitForCrossRouteMaterialized(
            alicePage,
            aliceRpc2,
            targetHubId,
            aliceDisputePartial.routeId,
            'Alice target dispute sibling',
          ),
        );

        await timedStep('cross_j_swap.dispute.source_args', () =>
          triggerSourceDisputeArguments(alicePage, alice, hubId, aliceDisputePartial.routeId, primaryHubRuntimeSeed),
        );
        await timedStep('cross_j_swap.dispute.source_routed', () =>
          waitForCrossDisputeRouted(alicePage, alice, hubId, aliceDisputePartial.routeId),
        );
        await timedStep('cross_j_swap.dispute.target_salvage', () =>
          waitForCrossSalvageQueued(alicePage, aliceRpc2, targetHubId, aliceDisputePartial.routeId),
        );
      } finally {
        await Promise.all([
          aliceContext ? aliceContext.close().catch(() => {}) : Promise.resolve(),
          bobContext ? bobContext.close().catch(() => {}) : Promise.resolve(),
        ]);
      }
    },
  );
});

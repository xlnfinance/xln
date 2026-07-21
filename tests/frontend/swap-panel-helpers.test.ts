import { describe, expect, test } from 'bun:test';

import {
  buildSwapPanelRuntimeView,
  buildCrossSwapRuntimeInputPlan,
  buildCrossTargetSetupTxs,
  buildCrossSwapSetupSteps,
  crossOrderbookPairLabel,
  entityInitials,
  firstAvailableHubId,
  formatEntityNetworkLabel,
  getTokenMapValue,
  jurisdictionBadgeText,
  normalizeJurisdictionDisplayName,
  nonNegative,
  parseCrossAssetKey,
  resolveHubIdCandidate,
  sameOrderbookPairLabel,
  tokenNetworkLabel,
} from '../../frontend/src/lib/components/Entity/swap-panel-helpers';

const tokenSymbol = (tokenId: number): string => {
  if (tokenId === 1) return 'WETH';
  if (tokenId === 2) return 'USDC';
  return `T${tokenId}`;
};

describe('swap panel helpers', () => {
  test('builds a read-only runtime projection for swap display data', () => {
    const hubId = '0xHubA';
    const userId = '0xUserA';
    const book = { bids: [], asks: [] };
    const frame = {
      gossip: {
        profiles: new Map([[
          hubId,
          {
            entityId: hubId,
            name: 'H1',
            metadata: { isHub: true, jurisdiction: { name: 'Tron' } },
          },
        ]]),
      },
      eReplicas: new Map([
        [`${userId}:0xSignerA`, {
          entityId: userId,
          signerId: '0xSignerA',
          state: {
            entityId: userId,
            accounts: new Map(),
            config: { jurisdiction: { name: 'Testnet' } },
          },
        }],
        [`${userId}:0xSignerB`, {
          entityId: userId,
          signerId: '0xSignerB',
          state: {
            entityId: userId,
            accounts: new Map(),
            config: { jurisdiction: { name: 'Testnet' } },
          },
        }],
        [`${hubId}:0xSignerH`, {
          entityId: hubId,
          signerId: '0xSignerH',
          state: {
            entityId: hubId,
            accounts: new Map(),
            orderbookExt: { books: new Map([['1/2', book]]) },
            config: { jurisdiction: { name: 'Tron' } },
          },
        }],
      ]),
    };

    const view = buildSwapPanelRuntimeView(frame as never);

    expect(view.entityNames.get(hubId.toLowerCase())).toBe('H1');
    expect(view.isHubEntity(hubId)).toBe(true);
    expect(view.getHubProfile(hubId)?.name).toBe('H1');
    expect(view.localReplicas.map((replica) => replica.entityId)).toEqual([userId, hubId]);
    expect(view.getPairBook(hubId, '1/2')).toBe(book);
    expect(view.getPairBook(userId, '1/2')).toBeNull();
  });

  test('builds swap projection from runtime-view fields without Env shape', () => {
    const hubId = '0xHubProjection';
    const userId = '0xUserProjection';
    const book = { bids: [], asks: [] };
    const view = buildSwapPanelRuntimeView({
      profiles: [{
        entityId: hubId,
        name: 'H projection',
        metadata: { isHub: true, jurisdiction: { name: 'Testnet' } },
      }],
      entityNames: new Map([[userId, 'User projection']]),
      replicas: new Map([
        [`${userId}:0xSignerProjection`, {
          entityId: userId,
          signerId: '0xSignerProjection',
          state: {
            entityId: userId,
            accounts: new Map(),
            config: { jurisdiction: { name: 'Testnet' } },
          },
        }],
        [`${hubId}:0xSignerProjection`, {
          entityId: hubId,
          signerId: '0xSignerProjection',
          state: {
            entityId: hubId,
            accounts: new Map(),
            orderbookExt: { books: new Map([['1/2', book]]) },
            config: { jurisdiction: { name: 'Testnet' } },
          },
        }],
      ]),
    });

    expect(view.entityNames.get(hubId.toLowerCase())).toBe('H projection');
    expect(view.entityNames.get(userId.toLowerCase())).toBe('User projection');
    expect(view.isHubEntity(hubId)).toBe(true);
    expect(view.localReplicaEntries.map((entry) => entry.entityId)).toEqual([
      userId.toLowerCase(),
      hubId.toLowerCase(),
    ]);
    expect(view.getPairBook(hubId, '1/2')).toBe(book);
  });

  test('preserves jurisdiction labels and strips repeated suffixes', () => {
    expect(normalizeJurisdictionDisplayName('arrakis')).toBe('arrakis');
    expect(normalizeJurisdictionDisplayName('Arrakis (shared anvil)')).toBe('Arrakis (shared anvil)');
    expect(normalizeJurisdictionDisplayName('Wakanda')).toBe('Wakanda');
    expect(normalizeJurisdictionDisplayName('Base Sepolia')).toBe('Base Sepolia');

    expect(formatEntityNetworkLabel('Hub Alpha (arrakis)', 'arrakis')).toBe('Hub Alpha (arrakis)');
    expect(formatEntityNetworkLabel('Hub Alpha Testnet', 'Testnet')).toBe('Hub Alpha (Testnet)');
    expect(formatEntityNetworkLabel('', '')).toBe('Unknown');
  });

  test('resolves known and advertised hub candidates deterministically', () => {
    const knownHubIds = ['0xHubA', '0xHubB'];
    const advertised = new Set(['0xhubc']);
    const isHub = (entityId: string): boolean => advertised.has(entityId.toLowerCase());

    expect(resolveHubIdCandidate(' 0xhuba ', knownHubIds, isHub)).toBe('0xHubA');
    expect(resolveHubIdCandidate('0xHubC', knownHubIds, isHub)).toBe('0xhubc');
    expect(resolveHubIdCandidate('0xUnknown', knownHubIds, isHub)).toBe('');
    expect(firstAvailableHubId(knownHubIds, ['0xUnknown', '0xHubC'], isHub)).toBe('0xhubc');
    expect(firstAvailableHubId(knownHubIds, ['0xUnknown'], isHub)).toBe('0xHubA');
  });

  test('parses cross-asset keys and formats pair labels with injected symbols', () => {
    expect(parseCrossAssetKey('chain-a:2')).toEqual({ jurisdictionRef: 'chain-a', tokenId: 2 });
    expect(parseCrossAssetKey('chain-a:0')).toBeNull();
    expect(parseCrossAssetKey(':2')).toBeNull();
    expect(parseCrossAssetKey('chain-a:two')).toBeNull();

    expect(tokenNetworkLabel(1, 'wakanda', tokenSymbol)).toBe('WETH (wakanda)');
    expect(sameOrderbookPairLabel(1, 2, 'Base Sepolia', tokenSymbol)).toBe('WETH-USDC (Base Sepolia)');
    expect(crossOrderbookPairLabel(1, 'arrakis', 2, 'Base Sepolia', tokenSymbol)).toBe('WETH (arrakis) - USDC (Base Sepolia)');
  });

  test('formats compact identity markers and token maps', () => {
    expect(entityInitials('0xabcdef', 'Grace Tron')).toBe('GR');
    expect(entityInitials('0xabcdef')).toBe('0X');
    expect(jurisdictionBadgeText('Base Sepolia')).toBe('BS');
    expect(jurisdictionBadgeText('arrakis')).toBe('AR');
    expect(jurisdictionBadgeText('')).toBe('J');

    expect(getTokenMapValue(new Map<number, string>([[1, 'number-key']]), 1)).toBe('number-key');
    expect(getTokenMapValue(new Map<string, string>([['2', 'string-key']]), 2)).toBe('string-key');
    expect(getTokenMapValue(undefined, 2)).toBeUndefined();
    expect(nonNegative(-1n)).toBe(0n);
    expect(nonNegative(2n)).toBe(2n);
  });

  test('builds cross-swap setup consent steps only for missing preparation', () => {
    expect(buildCrossSwapSetupSteps({
      routeMode: 'same',
      targetAccountReady: false,
      canOpenTargetAccount: true,
      needsCreditLimit: true,
      targetHubLabel: 'H1',
      targetJurisdictionLabel: 'Tron',
      creditLimitLabel: '10,000 USDC',
      creditIncreaseLabel: '+10,000 USDC',
      tokenSymbol: 'USDC',
    })).toEqual([]);

    expect(buildCrossSwapSetupSteps({
      routeMode: 'cross',
      targetAccountReady: true,
      canOpenTargetAccount: false,
      needsCreditLimit: false,
      targetHubLabel: 'H1',
      targetJurisdictionLabel: 'Tron',
      creditLimitLabel: '',
      creditIncreaseLabel: '',
      tokenSymbol: 'USDC',
    })).toEqual([]);

    expect(buildCrossSwapSetupSteps({
      routeMode: 'cross',
      targetAccountReady: false,
      canOpenTargetAccount: false,
      needsCreditLimit: true,
      targetHubLabel: 'H1',
      targetJurisdictionLabel: 'Tron',
      creditLimitLabel: '10,000 USDC',
      creditIncreaseLabel: '+10,000 USDC',
      tokenSymbol: 'USDC',
    })).toEqual([]);

    expect(buildCrossSwapSetupSteps({
      routeMode: 'cross',
      targetAccountReady: false,
      canOpenTargetAccount: true,
      needsCreditLimit: true,
      targetHubLabel: 'H1',
      targetJurisdictionLabel: 'Tron',
      creditLimitLabel: '10,000 USDC',
      creditIncreaseLabel: '+10,000 USDC',
      tokenSymbol: 'USDC',
    })).toEqual([
      {
        id: 'target-account',
        label: 'Create target account',
        detail: 'Open Tron account with H1.',
      },
      {
        id: 'target-credit',
        label: 'Set inbound credit limit',
        detail: 'Set inbound USDC credit to 10,000 USDC (+10,000 USDC).',
      },
    ]);
  });

  test('builds target setup txs for one-click cross swaps', () => {
    expect(buildCrossTargetSetupTxs({
      shouldOpenAccount: true,
      shouldExtendCredit: true,
      targetHubEntityId: '0xhub',
      tokenId: 1,
      requiredCreditLimit: 10_000n,
    })).toEqual([{
      type: 'openAccount',
      data: {
        targetEntityId: '0xhub',
        tokenId: 1,
        creditAmount: 10_000n,
      },
    }]);

    expect(buildCrossTargetSetupTxs({
      shouldOpenAccount: false,
      shouldExtendCredit: true,
      targetHubEntityId: '0xhub',
      tokenId: 1,
      requiredCreditLimit: 250n,
    })).toEqual([{
      type: 'extendCredit',
      data: {
        counterpartyEntityId: '0xhub',
        tokenId: 1,
        amount: 250n,
      },
    }]);

    expect(buildCrossTargetSetupTxs({
      shouldOpenAccount: false,
      shouldExtendCredit: false,
      targetHubEntityId: '0xhub',
      tokenId: 1,
      requiredCreditLimit: 250n,
    })).toEqual([]);

    expect(() => buildCrossTargetSetupTxs({
      shouldOpenAccount: true,
      shouldExtendCredit: false,
      targetHubEntityId: '0xhub',
      tokenId: 1,
      requiredCreditLimit: 0n,
    })).toThrow('positive inbound credit limit');
  });

  test('builds one RuntimeInput for one-click cross swap setup and request', () => {
    const route = {
      orderId: 'order-1',
      makerEntityId: '0xsource',
      hubEntityId: '0xbookhub',
      source: { entityId: '0xsource', counterpartyEntityId: '0xsourcehub', tokenId: 1, amount: 100n },
      target: { entityId: '0xtargethub', counterpartyEntityId: '0xtarget', tokenId: 2, amount: 200n },
    } as never;

    const plan = buildCrossSwapRuntimeInputPlan({
      sourceEntityId: '0xSOURCE',
      sourceSignerId: '0xSourceSigner',
      route,
      targetEntityId: '0xTARGET',
      targetSignerId: '0xTargetSigner',
      targetHubEntityId: '0xTargetHub',
      tokenId: 2,
      requiredCreditLimit: 10_000n,
      shouldOpenTargetAccount: true,
      shouldExtendTargetCredit: true,
    });

    expect(plan.input.entityInputs).toEqual([
      {
        entityId: '0xtarget',
        signerId: '0xTargetSigner',
        entityTxs: [{
          type: 'openAccount',
          data: {
            targetEntityId: '0xTargetHub',
            tokenId: 2,
            creditAmount: 10_000n,
          },
        }],
      },
      {
        entityId: '0xsource',
        signerId: '0xSourceSigner',
        entityTxs: [{
          type: 'requestCrossJurisdictionSwap',
          data: { route },
        }],
      },
    ]);
  });

  test('SwapPanel uses ordered RuntimeInput plans for cross swap setup', () => {
    const source = Bun.file('frontend/src/lib/components/Entity/SwapPanel.svelte');
    return source.text().then((text) => {
      expect(text).toContain('buildCrossSwapRuntimeInputPlan');
      expect(text).toContain('crossInputPlan.targetSetupTxs.length > 0');
      expect(text).toContain('await submitRuntimeInput(crossInputPlan.input)');
      expect(text).not.toContain('crossCommandEnv');
      expect(text).not.toContain('submitRuntimeInput(crossCommandEnv, runtimeInput)');
      expect(text).not.toContain('await submitRuntimeInput(nextEnv, crossInputPlan.requestInput)');
      expect(text).not.toContain('buildCrossTargetSetupTxs');
    });
  });

  test('SwapPanel reads through injected runtime projection instead of owning Env reads', async () => {
    const [panel, workspace, tabs] = await Promise.all([
      Bun.file('frontend/src/lib/components/Entity/SwapPanel.svelte').text(),
      Bun.file('frontend/src/lib/components/Entity/AccountWorkspaceView.svelte').text(),
      Bun.file('frontend/src/lib/components/Entity/EntityPanelTabs.svelte').text(),
    ]);

    expect(panel).toContain('export let runtimeView: SwapPanelRuntimeView | null = null');
    expect(panel).toContain('export let env: Env | null = null');
    expect(panel).not.toContain('export let env: Env | EnvSnapshot');
    expect(panel).toContain('swapRuntimeView = runtimeView ?? buildSwapPanelRuntimeView(activeFrame)');
    expect(workspace).toContain('export let swapRuntimeView: SwapPanelRuntimeView | null = null');
    expect(workspace).toContain('{#if activeEnv || swapRuntimeView}');
    expect(workspace).toContain('runtimeView={swapRuntimeView}');
    expect(tabs).toContain('swapRuntimeView = buildSwapPanelRuntimeView({');
    expect(tabs).toContain('profiles: panelProfiles');
    expect(tabs).toContain('entityNames: panelView.entityNames');
    expect(tabs).toContain('replicas: activeReplicas');
  });

  test('SwapPanel remote swap actions submit through projection-backed command paths', async () => {
    const panel = await Bun.file('frontend/src/lib/components/Entity/SwapPanel.svelte').text();
    const placeStart = panel.indexOf('async function placeSwapOffer()');
    const cancelStart = panel.indexOf('async function cancelSwapOffer(');
    const clearStart = panel.indexOf('async function requestCrossClear(');
    const formatStart = panel.indexOf('// Format BigInt for display');
    expect(placeStart).toBeGreaterThan(0);
    expect(cancelStart).toBeGreaterThan(placeStart);
    expect(clearStart).toBeGreaterThan(cancelStart);
    expect(formatStart).toBeGreaterThan(clearStart);

    const resolverSlice = panel.slice(
      panel.indexOf('function resolveProjectedSignerId('),
      panel.indexOf('function getTokenDecimals('),
    );
    const placeSlice = panel.slice(placeStart, cancelStart);
    const cancelSlice = panel.slice(cancelStart, clearStart);
    const clearSlice = panel.slice(clearStart, formatStart);

    expect(resolverSlice).toContain('function resolveSwapLogicalClock(');
    expect(resolverSlice).toContain('sourceReplica?.state?.timestamp ?? runtimeEnv?.timestamp');
    expect(resolverSlice).toContain('sourceReplica?.state?.height ?? runtimeEnv?.height');
    expect(resolverSlice).toContain('resolveProjectedSignerId(entityId)');
    expect(resolverSlice).not.toContain("throw new Error('XLN environment not ready')");
    expect(placeSlice).toContain('resolveSwapLogicalClock(currentReplica)');
    expect(placeSlice).toContain('await submitRuntimeInput(crossInputPlan.input)');
    expect(placeSlice).toContain('await submitEntityInputs([{');
    expect(placeSlice).toContain('await prewarmCounterpartyProfiles(runtimeEnv, [targetRoute.targetHubEntityId])');
    expect(placeSlice).not.toContain("throw new Error('XLN environment not ready')");
    expect(placeSlice).not.toContain('env.timestamp');
    expect(placeSlice).not.toContain('env.height');
    expect(cancelSlice).toContain('await submitEntityInputs([{');
    expect(cancelSlice).not.toContain("throw new Error('XLN environment not ready')");
    expect(clearSlice).toContain('await submitEntityInputs([{');
    expect(clearSlice).not.toContain("throw new Error('XLN environment not ready')");
  });

  test('SwapPanel does not poll stale DOM over programmatic book amount selection', () => {
    const source = Bun.file('frontend/src/lib/components/Entity/SwapPanel.svelte');
    return source.text().then((text) => {
      const panelSyncStart = text.indexOf('function handleSwapPanelAmountSync');
      expect(panelSyncStart).toBeGreaterThan(0);
      expect(text).toContain("event.target.dataset['testid'] === 'swap-order-amount'");
      expect(text).not.toContain('function syncOrderAmountContainerAction');
      expect(text).not.toContain('function syncOrderAmountInputFromContainer');
      expect(text).not.toContain('window.setInterval(sync, 100)');
      expect(text).not.toContain("querySelector<HTMLInputElement>('[data-testid=\"swap-order-amount\"]')");
    });
  });

  test('SwapPanel preserves a pinned orderbook level when token sync is idempotent', () => {
    const source = Bun.file('frontend/src/lib/components/Entity/SwapPanel.svelte');
    return source.text().then((text) => {
      const setTokensStart = text.indexOf('function setSwapTokens');
      const nextFunctionStart = text.indexOf('function buildReverseCrossRouteSelection');
      expect(setTokensStart).toBeGreaterThan(0);
      expect(nextFunctionStart).toBeGreaterThan(setTokensStart);
      const setTokensSource = text.slice(setTokensStart, nextFunctionStart);
      expect(setTokensSource).toContain('const previousGiveTokenId = String(giveTokenId);');
      expect(setTokensSource).toContain('const previousWantTokenId = String(wantTokenId);');
      expect(setTokensSource).toContain('const tokensChanged = previousGiveTokenId !== nextGiveTokenId || previousWantTokenId !== nextWantTokenId;');
      expect(setTokensSource).toContain('if (tokensChanged) selectedOrderLevel = null;');
      expect(setTokensSource).not.toContain('wantTokenId = String(nextWantToken);\n    selectedOrderLevel = null;');
    });
  });
});

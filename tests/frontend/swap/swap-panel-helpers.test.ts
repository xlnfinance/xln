import { describe, expect, test } from 'bun:test';

import {
  buildSwapPanelRuntimeView,
  buildCrossSwapSetupSteps,
  crossOrderbookPairLabel,
  entityInitials,
  firstAvailableHubId,
  formatEntityNetworkLabel,
  jurisdictionBadgeText,
  normalizeJurisdictionDisplayName,
  orderbookLotsDisplayScale,
  parseCrossAssetKey,
  resolveHubIdCandidate,
  sameOrderbookPairLabel,
  tokenNetworkLabel,
} from '../../../frontend/src/lib/components/Entity/swap/swap-panel-helpers';

const tokenSymbol = (tokenId: number): string => {
  if (tokenId === 1) return 'WETH';
  if (tokenId === 2) return 'USDC';
  return `T${tokenId}`;
};

describe('swap panel helpers', () => {
  test('displays canonical orderbook lots in human token units for every decimal domain', () => {
    expect(orderbookLotsDisplayScale(6)).toBe(1_000_000);
    expect(orderbookLotsDisplayScale(18)).toBe(1_000_000);
    expect(orderbookLotsDisplayScale(2)).toBe(100);
    expect(() => orderbookLotsDisplayScale(-1)).toThrow('SWAP_TOKEN_DECIMALS_INVALID');
  });

  test('builds a read-only runtime projection for swap display data', () => {
    const hubId = '0xHubA';
    const userId = '0xUserA';
    const book = { bids: [], asks: [] };
    const frame = {
      gossip: {
        profiles: new Map([
          [
            hubId,
            {
              entityId: hubId,
              name: 'H1',
              metadata: { isHub: true, jurisdiction: { name: 'Tron' } },
            },
          ],
        ]),
      },
      state: { eReplicas: new Map([
        [
          `${userId}:0xSignerA`,
          {
            entityId: userId,
            signerId: '0xSignerA',
            state: {
              entityId: userId,
              accounts: new Map(),
              config: { jurisdiction: { name: 'Testnet' } },
            },
          },
        ],
        [
          `${userId}:0xSignerB`,
          {
            entityId: userId,
            signerId: '0xSignerB',
            state: {
              entityId: userId,
              accounts: new Map(),
              config: { jurisdiction: { name: 'Testnet' } },
            },
          },
        ],
        [
          `${hubId}:0xSignerH`,
          {
            entityId: hubId,
            signerId: '0xSignerH',
            state: {
              entityId: hubId,
              accounts: new Map(),
              orderbookExt: { books: new Map([['1/2', book]]) },
              config: { jurisdiction: { name: 'Tron' } },
            },
          },
        ],
      ]) },
    };

    const view = buildSwapPanelRuntimeView(frame as never);

    expect(view.entityNames.get(hubId.toLowerCase())).toBe('H1');
    expect(view.isHubEntity(hubId)).toBe(true);
    expect(view.getHubProfile(hubId)?.name).toBe('H1');
    expect(view.localReplicas.map(replica => replica.entityId)).toEqual([userId, hubId]);
    expect(view.getPairBook(hubId, '1/2')).toBe(book);
    expect(view.getPairBook(userId, '1/2')).toBeNull();
  });

  test('builds swap projection from runtime-view fields without RuntimeReplica shape', () => {
    const hubId = '0xHubProjection';
    const userId = '0xUserProjection';
    const book = { bids: [], asks: [] };
    const view = buildSwapPanelRuntimeView({
      profiles: [
        {
          entityId: hubId,
          name: 'H projection',
          metadata: { isHub: true, jurisdiction: { name: 'Testnet' } },
        },
      ],
      entityNames: new Map([[userId, 'User projection']]),
      replicas: new Map([
        [
          `${userId}:0xSignerProjection`,
          {
            entityId: userId,
            signerId: '0xSignerProjection',
            state: {
              entityId: userId,
              accounts: new Map(),
              config: { jurisdiction: { name: 'Testnet' } },
            },
          },
        ],
        [
          `${hubId}:0xSignerProjection`,
          {
            entityId: hubId,
            signerId: '0xSignerProjection',
            state: {
              entityId: hubId,
              accounts: new Map(),
              orderbookExt: { books: new Map([['1/2', book]]) },
              config: { jurisdiction: { name: 'Testnet' } },
            },
          },
        ],
      ]),
    });

    expect(view.entityNames.get(hubId.toLowerCase())).toBe('H projection');
    expect(view.entityNames.get(userId.toLowerCase())).toBe('User projection');
    expect(view.isHubEntity(hubId)).toBe(true);
    expect(view.localReplicaEntries.map(entry => entry.entityId)).toEqual([userId.toLowerCase(), hubId.toLowerCase()]);
    expect(view.getPairBook(hubId, '1/2')).toBe(book);
  });

  test('uses live signed network profiles for relay routing without replacing committed replicas', () => {
    const hubId = '0xHubProjection';
    const committedReplica = {
      entityId: '0xUserProjection',
      signerId: '0xSignerProjection',
      state: {
        entityId: '0xUserProjection',
        accounts: new Map(),
      },
    };
    const view = buildSwapPanelRuntimeView({
      profiles: [
        {
          entityId: hubId,
          name: 'H projection',
          relays: [],
          metadata: { isHub: true, jurisdiction: { name: 'Testnet' } },
        },
      ],
      networkProfiles: [
        {
          entityId: hubId,
          name: 'H live',
          relays: ['ws://127.0.0.1:20262/relay'],
          metadata: { isHub: true, jurisdiction: { name: 'Testnet' } },
        },
      ],
      replicas: new Map([['0xUserProjection:0xSignerProjection', committedReplica]]),
    });

    expect(view.getHubProfile(hubId)?.relays).toEqual(['ws://127.0.0.1:20262/relay']);
    expect(view.localReplicas).toEqual([committedReplica]);
  });

  test('committed user role vetoes a stale live Hub advertisement', () => {
    const entityId = '0xRoleBoundEntity';
    const view = buildSwapPanelRuntimeView({
      profiles: [],
      networkProfiles: [{
        entityId,
        name: 'Stale Hub',
        relays: ['ws://127.0.0.1:20262/relay'],
        metadata: { isHub: true, jurisdiction: { name: 'Testnet' } },
      }],
      replicas: new Map([[`${entityId}:0xSigner`, {
        entityId,
        signerId: '0xSigner',
        state: {
          entityId,
          profile: { name: 'Committed User', isHub: false },
          accounts: new Map(),
        },
      }]]),
    });

    expect(view.getHubProfile(entityId)).toBe(null);
    expect(view.profiles[0]?.metadata.isHub).toBe(false);
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
    expect(crossOrderbookPairLabel(1, 'arrakis', 2, 'Base Sepolia', tokenSymbol)).toBe(
      'WETH (arrakis) - USDC (Base Sepolia)',
    );
  });

  test('formats compact identity markers', () => {
    expect(entityInitials('0xabcdef', 'Grace Tron')).toBe('GR');
    expect(entityInitials('0xabcdef')).toBe('0X');
    expect(jurisdictionBadgeText('Base Sepolia')).toBe('BS');
    expect(jurisdictionBadgeText('arrakis')).toBe('AR');
    expect(jurisdictionBadgeText('')).toBe('J');
  });

  test('builds cross-swap setup consent steps only for missing preparation', () => {
    expect(
      buildCrossSwapSetupSteps({
        routeMode: 'same',
        targetAccountReady: false,
        canOpenTargetAccount: true,
        needsCreditLimit: true,
        targetHubLabel: 'H1',
        targetJurisdictionLabel: 'Tron',
        creditLimitLabel: '10,000 USDC',
        creditIncreaseLabel: '+10,000 USDC',
        tokenSymbol: 'USDC',
      }),
    ).toEqual([]);

    expect(
      buildCrossSwapSetupSteps({
        routeMode: 'cross',
        targetAccountReady: true,
        canOpenTargetAccount: false,
        needsCreditLimit: false,
        targetHubLabel: 'H1',
        targetJurisdictionLabel: 'Tron',
        creditLimitLabel: '',
        creditIncreaseLabel: '',
        tokenSymbol: 'USDC',
      }),
    ).toEqual([]);

    expect(
      buildCrossSwapSetupSteps({
        routeMode: 'cross',
        targetAccountReady: false,
        canOpenTargetAccount: false,
        needsCreditLimit: true,
        targetHubLabel: 'H1',
        targetJurisdictionLabel: 'Tron',
        creditLimitLabel: '10,000 USDC',
        creditIncreaseLabel: '+10,000 USDC',
        tokenSymbol: 'USDC',
      }),
    ).toEqual([]);

    expect(
      buildCrossSwapSetupSteps({
        routeMode: 'cross',
        targetAccountReady: false,
        canOpenTargetAccount: true,
        needsCreditLimit: true,
        targetHubLabel: 'H1',
        targetJurisdictionLabel: 'Tron',
        creditLimitLabel: '10,000 USDC',
        creditIncreaseLabel: '+10,000 USDC',
        tokenSymbol: 'USDC',
      }),
    ).toEqual([
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

  test('SwapPanel submits the exact Runtime-owned command plan before cross intent', () => {
    const source = Bun.file('frontend/src/lib/components/Entity/swap/SwapPanel.svelte');
    return source.text().then(text => {
      expect(text).toContain('activeXlnFunctions.planSwapCommand');
      expect(text).toContain('if (commandPlan.targetSetupInput)');
      expect(text).toContain('await submitRuntimeInput(commandPlan.targetSetupInput)');
      expect(text).toContain('await submitActiveCrossJurisdictionIntent(commandPlan.crossJurisdictionIntent, {');
      expect(text).toContain('waitForTargetReady: commandPlan.targetSetupInput !== null');
      expect(text).not.toContain('activeXlnFunctions.deriveDelta');
      expect(text).not.toContain('10_000n * 10n ** decimals');
      expect(text).not.toContain('crossCommandEnv');
      expect(text).not.toContain('submitRuntimeInput(crossCommandEnv, runtimeInput)');
      expect(text).not.toContain('await submitRuntimeInput(nextEnv, crossInputPlan.requestInput)');
      expect(text).not.toContain('buildCrossTargetSetupTxs');
    });
  });

  test('SwapPanel reads through injected runtime projection instead of owning RuntimeReplica reads', async () => {
    const [panel, workspace, tabs] = await Promise.all([
      Bun.file('frontend/src/lib/components/Entity/swap/SwapPanel.svelte').text(),
      Bun.file('frontend/src/lib/components/Entity/workspace/AccountWorkspaceView.svelte').text(),
      Bun.file('frontend/src/lib/components/Entity/workspace/shell/EntityPanelTabs.svelte').text(),
    ]);

    expect(panel).toContain('export let runtimeView: SwapPanelRuntimeView | null = null');
    expect(panel).toContain('export let env: RuntimeReplica | null = null');
    expect(panel).not.toContain('export let env: RuntimeReplica | EnvSnapshot');
    expect(panel).toContain('swapRuntimeView = runtimeView ?? buildSwapPanelRuntimeView(activeFrame)');
    expect(panel).toContain('readRuntimeEntityProjectionFrame(entityId)');
    expect(panel).toContain("buildEntityPanelView(null, entityId, '', '', frame).replica");
    expect(workspace).toContain('export let swapRuntimeView: SwapPanelRuntimeView | null = null');
    expect(workspace).toContain('{#if activeEnv || swapRuntimeView}');
    expect(workspace).toContain('runtimeView={swapRuntimeView}');
    expect(workspace).toContain('{runtimeHeight}');
    expect(tabs).toContain('swapRuntimeView = buildSwapPanelRuntimeView({');
    expect(tabs).toContain('profiles: panelProfiles');
    expect(tabs).toContain('networkProfiles: getGossipProfiles(actionRuntimeEnv)');
    expect(tabs).toContain('entityNames: panelView.entityNames');
    expect(tabs).toContain('replicas: activeReplicas');
  });

  test('SwapPanel remote swap actions submit through projection-backed command paths', async () => {
    const panel = await Bun.file('frontend/src/lib/components/Entity/swap/SwapPanel.svelte').text();
    const placeStart = panel.indexOf('async function placeSwapOffer()');
    const cancelStart = panel.indexOf('async function cancelSwapOffer(');
    const clearStart = panel.indexOf('async function requestCrossClear(');
    const formatStart = panel.indexOf('function formatAmount(');
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
    expect(resolverSlice).toContain('sourceReplica?.state?.timestamp ?? runtimeEnv?.state.timestamp');
    expect(resolverSlice).toContain('sourceReplica?.state?.height ?? runtimeEnv?.state.height');
    expect(resolverSlice).toContain('resolveProjectedSignerId(entityId)');
    expect(resolverSlice).not.toContain("throw new Error('XLN environment not ready')");
    expect(placeSlice).toContain('resolveSwapLogicalClock(committedSourceReplica)');
    expect(placeSlice).toContain('readCommittedEntityReplica(sourceEntityId)');
    expect(placeSlice).toContain('activeXlnFunctions.planSwapCommand({');
    expect(placeSlice).toContain('await submitRuntimeInput(commandPlan.targetSetupInput)');
    expect(placeSlice).toContain('await submitActiveCrossJurisdictionIntent(commandPlan.crossJurisdictionIntent, {');
    expect(placeSlice).toContain('waitForTargetReady: commandPlan.targetSetupInput !== null');
    expect(placeSlice).toContain('await prewarmCounterpartyProfiles(runtimeEnv, [targetRoute.targetHubEntityId])');
    expect(placeSlice).not.toContain("throw new Error('XLN environment not ready')");
    expect(placeSlice).not.toContain('env.timestamp');
    expect(placeSlice).not.toContain('env.height');
    expect(cancelSlice).toContain('await submitEntityInputs(');
    expect(cancelSlice).toContain("type: 'proposeCancelSwap'");
    expect(cancelSlice).not.toContain("throw new Error('XLN environment not ready')");
    expect(clearSlice).toContain('await submitEntityInputs(');
    expect(clearSlice).toContain("type: 'requestCrossJurisdictionClear'");
    expect(clearSlice).not.toContain("throw new Error('XLN environment not ready')");
  });

  test('SwapPanel keeps amount state only in the parent and parses that source directly', async () => {
    const [panel, ticket] = await Promise.all([
      Bun.file('frontend/src/lib/components/Entity/swap/SwapPanel.svelte').text(),
      Bun.file('frontend/src/lib/components/Entity/swap/SwapTicket.svelte').text(),
    ]);

    expect(panel).toContain('$: giveAmount = parseDecimalAmountToBigInt(orderAmountInput, giveTokenDecimals);');
    expect(panel).toContain('function handleOrderAmountInput(value: string): void');
    expect(panel).toContain('orderAmountInput = autoSelection.amountInput;');
    expect(panel).toContain('function computeOrderAmountSelection(percent: number)');
    expect(panel).toMatch(/orderbookSnapshot;\s+orderbookPairId;\s+activeBookHubId;/);
    expect(panel).not.toContain('liveOrderAmountInput');
    expect(panel).not.toContain('routedOrderAmountInput');
    expect(panel).not.toContain('handleSwapPanelAmountSync');
    expect(panel).not.toContain('orderAmountRevision');
    expect(panel).not.toContain('orderAmountInputElement');
    expect(ticket).toContain('value={orderAmountInput}');
    expect(ticket).not.toContain('bind:value={orderAmountInput}');
  });

  test('SwapTicket makes cross-network online and manual-close risk impossible to omit', async () => {
    const ticket = await Bun.file('frontend/src/lib/components/Entity/swap/SwapTicket.svelte').text();
    expect(ticket).toContain("{#if swapRouteMode === 'cross'}");
    expect(ticket).toContain('data-testid="cross-j-safety-banner"');
    expect(ticket).toContain('Stay online for this cross-network swap');
    expect(ticket).toContain('cancel the remaining order manually');
    expect(ticket).toContain('65,535 steps');
  });

  test('SwapPanel preserves a pinned orderbook level when token sync is idempotent', () => {
    const source = Bun.file('frontend/src/lib/components/Entity/swap/SwapPanel.svelte');
    return source.text().then(text => {
      const setTokensStart = text.indexOf('function setSwapTokens');
      const nextFunctionStart = text.indexOf('function buildReverseCrossRouteSelection');
      expect(setTokensStart).toBeGreaterThan(0);
      expect(nextFunctionStart).toBeGreaterThan(setTokensStart);
      const setTokensSource = text.slice(setTokensStart, nextFunctionStart);
      expect(setTokensSource).toContain('const previousGiveTokenId = String(giveTokenId);');
      expect(setTokensSource).toContain('const previousWantTokenId = String(wantTokenId);');
      expect(setTokensSource).toContain(
        'const tokensChanged = previousGiveTokenId !== nextGiveTokenId || previousWantTokenId !== nextWantTokenId;',
      );
      expect(setTokensSource).toContain('if (tokensChanged) selectedOrderLevel = null;');
      expect(setTokensSource).not.toContain('wantTokenId = String(nextWantToken);\n    selectedOrderLevel = null;');
    });
  });
});

import { expectCrossActivity } from './cross-activity';
import { readMarketRoutes } from './cross-market';
import { expectBilateralCommit } from './cross-account';
import { expect, test, type Page } from '@playwright/test';
import { formatUnits } from 'ethers';
import type { RuntimeAdapterViewFrame, RuntimeReplica, XLNModule } from '../../core/api/public/runtime-module';
import type { RuntimeAdapter } from '../../core/api/runtime-adapter/types';
import { getCrossJurisdictionRouteRemainingAmounts } from '../../core/extensions/cross-j/orderbook';
import { requantizeRemainingSwapAtPriceForDimensions } from '../../core/swapbook';
import { safeStringify } from '../../core/protocol/serialization';
import { selectMarketMakerCrossRoutes } from '../../core/scripts/operations/hlt/cross/cross-boundary';
import { enterStack, fundFromHub, reopenStack } from './stack';

type DebugWindow = Window & {
  __xln?: { env: () => RuntimeReplica | null; adapter: () => RuntimeAdapter | null; xln: () => Promise<XLNModule> };
};
type CrossParties = {
  sourceEntityId: string;
  sourceHubId: string;
  targetEntityId: string;
  targetHubId: string;
  receiveTokenId: number;
};

async function readOppositeMarket(parties: Pick<CrossParties, 'sourceHubId' | 'targetHubId'>, hubLabel: string) {
  const routes = await readMarketRoutes(parties.targetHubId, hubLabel);
  return selectMarketMakerCrossRoutes(routes, parties.targetHubId, parties.sourceHubId).map(route => ({
    orderId: route.orderId,
    status: route.status,
    venueId: route.venueId,
    priceTicks: route.priceTicks,
    source: route.source,
    target: route.target,
    filledSource: route.filledSourceAmount,
    filledTarget: route.filledTargetAmount,
    remaining: getCrossJurisdictionRouteRemainingAmounts(route),
  }));
}

/** Observe committed account balances and route state. No setup or financial mutation bypasses the UI. */
const readCross = (page: Page, parties: CrossParties, atHeight?: number) =>
  page.evaluate(
    async ({ ids, atHeight }) => {
      const debug = (window as DebugWindow).__xln;
      const runtime = debug?.env();
      const adapter = debug?.adapter();
      if (!debug || !runtime || !adapter) throw new Error('Wallet runtime diagnostics unavailable');
      const xln = await debug.xln();
      const readLeg = async (entityId: string, counterpartyEntityId: string, tokenId: number) => {
        const account = await adapter.read<
          NonNullable<RuntimeAdapterViewFrame['activeEntity']>['accounts']['items'][number]
        >(`entity/${entityId}/account/${counterpartyEntityId}`, atHeight === undefined ? undefined : { atHeight });
        const delta = account.state.deltas.get(tokenId);
        const isLeft = xln.isLeftEntity(entityId, counterpartyEntityId);
        const derived = delta ? xln.deriveDelta(delta, isLeft) : null;
        const policy = account.shadow.rebalance.policy.get(tokenId);
        const tariff = account.state.rebalanceFeePolicies?.get(tokenId)?.[isLeft ? 'right' : 'left'];
        if (!policy || !tariff) throw new Error(`Committed collateral policy unavailable: ${entityId}:${tokenId}`);
        const capacity = xln.readAccountCapacity({
          account: account.state,
          ownerEntityId: entityId,
          counterpartyEntityId,
          tokenId,
        });
        const core = await adapter.read<NonNullable<RuntimeAdapterViewFrame['activeEntity']>['core']>(
          `entity/${entityId}`,
          atHeight === undefined ? undefined : { atHeight },
        );
        const routes = [...(core.crossJurisdictionSwaps?.values() ?? [])]
          .filter(
            route =>
              route.source.entityId === ids.sourceEntityId && route.target.counterpartyEntityId === ids.targetEntityId,
          )
          .map(route => ({
            orderId: route.orderId,
            status: route.status,
            filledSource: String(route.filledSourceAmount ?? 0n),
            filledTarget: String(route.filledTargetAmount ?? 0n),
          }));
        return {
          height: account.currentHeight,
          root: account.currentFrame.accountStateRoot,
          // Funding can be rebalanced on-chain. Count the canonical owned collateral
          // and receivable, never undrawn credit or signed Δ alone for the right owner.
          balance: derived ? (derived.outCollateral + derived.outPeerCredit).toString() : '0',
          uncollateralized: derived?.outPeerCredit.toString() ?? '0',
          debt: derived?.inOwnCredit.toString() ?? '0',
          collateral: delta?.collateral.toString() ?? '0',
          ondelta: delta?.ondelta.toString() ?? '0',
          offdelta: delta?.offdelta.toString() ?? '0',
          incoming: capacity.inCapacity.toString(),
          credit: capacity.peerCreditLimit.toString(),
          pending: Boolean(account.pendingFrame),
          mempool: account.mempoolCount,
          pulls: account.state.pulls?.size ?? 0,
          rebalancePolicy: {
            r2cRequestSoftLimit: policy.r2cRequestSoftLimit.toString(),
            hardLimit: policy.hardLimit.toString(),
            maxAcceptableFee: policy.maxAcceptableFee.toString(),
          },
          feePolicy: {
            policyVersion: tariff.policyVersion,
            baseFee: tariff.baseFee.toString(),
            gasFee: tariff.gasFee.toString(),
            liquidityFeeBps: tariff.liquidityFeeBps.toString(),
          },
          routes,
        };
      };
      return {
        source: await readLeg(ids.sourceEntityId, ids.sourceHubId, 1),
        target: await readLeg(ids.targetEntityId, ids.targetHubId, ids.receiveTokenId),
      };
    },
    { ids: parties, atHeight },
  );

/** Persisted WAL and signed bilateral frames prove recovery without using current roots as a historical oracle. */
const readCrossRecoveryProof = (page: Page, parties: CrossParties, orderId: string, atHeight?: number) =>
  page.evaluate(
    async ({ parties: ids, orderId, atHeight }) => {
      const debug = (window as DebugWindow).__xln;
      const env = debug?.env();
      const adapter = debug?.adapter();
      if (!debug || !env || !adapter) throw new Error('Cross recovery storage unavailable');
      const xln = await debug.xln();
      const height = atHeight ?? (await xln.getPersistedLatestHeight(env));
      const frame = await xln.readPersistedStorageFrameRecord(env, height);
      if (!frame?.frameHash) throw new Error(`Cross recovery WAL frame missing: ${height}`);
      const preparations: { height: number; entityId: string; frameHash: string; orderId: string }[] = [];
      for (let cursor = 1; cursor <= height; cursor++) {
        const accepted = await xln.readPersistedStorageFrameRecord(env, cursor);
        if (!accepted?.frameHash) throw new Error(`Cross accepted WAL frame missing: ${cursor}`);
        for (const input of accepted.runtimeInput.entityInputs)
          for (const tx of input.entityTxs ?? []) {
            if (tx.type === 'prepareCrossJurisdictionSwap' && tx.data.route.orderId === orderId) {
              preparations.push({ height: cursor, entityId: input.entityId, frameHash: accepted.frameHash, orderId });
            }
          }
      }
      const accounts = [];
      for (const [entityId, hubId] of [
        [ids.sourceEntityId, ids.sourceHubId],
        [ids.targetEntityId, ids.targetHubId],
      ] as const) {
        const account = await adapter.read<
          NonNullable<RuntimeAdapterViewFrame['activeEntity']>['accounts']['items'][number]
        >(`entity/${entityId}/account/${hubId}`, { atHeight: height });
        const frames = await xln.readPersistedAccountFrameHistory(env, entityId, hubId, account.currentHeight, {
          maxAccountHeight: account.currentHeight,
        });
        const pullIds = new Set(
          frames.flatMap(signed =>
            signed.accountTxs.flatMap(tx =>
              tx.type === 'cross_pull_lock' && tx.data.crossJurisdictionRoute.orderId === orderId
                ? [tx.data.pullId]
                : [],
            ),
          ),
        );
        const executions = frames.flatMap(signed =>
          signed.accountTxs.flatMap(tx =>
            (tx.type === 'cross_pull_lock' || tx.type === 'cross_pull_close') && pullIds.has(tx.data.pullId)
              ? [
                  {
                    height: signed.height,
                    stateHash: signed.stateHash,
                    root: signed.accountStateRoot,
                    type: tx.type,
                    pullId: tx.data.pullId,
                  },
                ]
              : [],
          ),
        );
        accounts.push({
          entityId,
          hubId,
          height: account.currentHeight,
          root: account.currentFrame.accountStateRoot,
          executions,
        });
      }
      return {
        runtimeId: adapter.runtimeId,
        frame: { height, frameHash: frame.frameHash, postStateHash: frame.postStateHash },
        preparations,
        accounts,
      };
    },
    { parties, orderId, atHeight },
  );

// The maker's committed projection is read through a privileged runtime
// connection, whose address comes from a runtime import manifest that only the
// local-prod-smoke stand writes, at <XLN_RDB_ROOT>/prod-mesh. The dev stack
// keeps neither that layout nor a lasting manifest, so on any other stand this
// test states what it needs rather than failing for the wrong reason.
test.skip(
  !process.env['XLN_RDB_ROOT'],
  'needs the local-prod-smoke stand: XLN_RDB_ROOT with a prod-mesh runtime import manifest',
);

for (const scenario of [
  {
    receiveTokenId: 3,
    giveAmount: 50_000_000n,
    funding: '100',
    title: 'cross-network swap prepares target incoming capacity before both bilateral legs commit',
  },
  {
    receiveTokenId: 1,
    giveAmount: 300_000_000n,
    funding: '300',
    title: 'cross-network same-asset swap prepares target capacity and commits both legs',
  },
])
  test(scenario.title, { tag: '@functional' }, async ({ page }) => {
    test.setTimeout(50_000);
    const errors: string[] = [];
    const authErrors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() !== 'error' && message.type() !== 'warning') return;
      console.log(`BROWSER_${message.type()}: ${message.text().slice(0, 500)}`);
      if (/MAC.*(?:INVALID|FAIL|MISMATCH)|(?:INVALID|FAIL|MISMATCH).*MAC|WS_MESSAGE_AUTH/i.test(message.text()))
        authErrors.push(message.text());
    });
    const wallet = await enterStack(page);
    const sourceEntityId = (await page.getByTestId('home-entity-id').textContent())?.trim();
    if (!sourceEntityId) throw new Error('Primary wallet Entity unavailable');
    const setup = await page.evaluate(() => {
      const runtime = (window as DebugWindow).__xln?.env();
      if (!runtime) throw new Error('Wallet runtime diagnostics unavailable');
      return {
        networks: [...runtime.state.jReplicas.keys()],
        owners: [...runtime.state.eReplicas.values()].map(replica => ({
          entityId: replica.entityId,
          jurisdiction: replica.state.config.jurisdiction?.name,
        })),
      };
    });
    expect(setup.networks).toHaveLength(2);
    console.log(
      `CROSS_SETUP networks=${setup.networks.join(',')} ownedEntities=${setup.owners.map(owner => `${owner.entityId}@${owner.jurisdiction}`).join(',')}`,
    );
    // Keep the real 300-USDC case within the public faucet's 100/request policy.
    for (let funded = 0; funded < Number(scenario.funding); funded += 100) await fundFromHub(page, '100');
    await page.getByTestId('account-row').first().click();
    const sourceHubId = new URL(page.url()).pathname.split('/accounts/')[1];
    if (!sourceHubId || !/^0x[0-9a-f]{64}$/.test(sourceHubId)) throw new Error('Primary hub Account unavailable');
    await page.getByTestId('back').click();
    await page.getByTestId('wallet-tutorial').click();
    await page.getByTestId('tour-chapter').selectOption('cross');
    await expect(page.getByTestId('tour-result')).toContainText('source debit AND destination credit');
    const across = page.getByRole('button', { name: 'Across networks', exact: true });
    await expect(across).toBeEnabled({ timeout: 5_000 });
    await across.click();
    const target = page.locator('.kv').filter({ hasText: 'Your other account' }).locator('select');
    await expect(target).toBeVisible();
    expect(new Set(setup.owners.map(owner => owner.jurisdiction))).toEqual(new Set(setup.networks));
    const targetEntityId = await target.inputValue();
    expect(targetEntityId).not.toBe(sourceEntityId);
    await page.getByTestId('swap-give').fill('100');
    await page.getByTestId('swap-want').fill('0.03');
    const sourceHubLabel = (await page.locator('.hop.me').innerText()).trim();
    const targetHub = page.locator('.kv').filter({ hasText: 'Hub there' }).locator('select');
    await targetHub.selectOption({ label: sourceHubLabel });
    const targetHubId = await targetHub.inputValue();
    const market = await readOppositeMarket({ sourceHubId, targetHubId }, sourceHubLabel);
    console.log(`CROSS_OPPOSITE_MARKET ${safeStringify(market)}`);
    const maker = market.find(
      route =>
        route.status === 'resting' &&
        route.target.tokenId === 1 &&
        route.source.tokenId === scenario.receiveTokenId &&
        route.remaining.targetRemaining > scenario.giveAmount &&
        route.remaining.sourceRemaining > 0n,
    );
    if (!maker) throw new Error(`No executable cross-token USDC opposite quote: ${safeStringify(market)}`);
    const receiveTokenId = maker.source.tokenId;
    const receiveToken = await page.evaluate(async tokenId => {
      const debug = (window as DebugWindow).__xln;
      if (!debug) throw new Error('Wallet runtime diagnostics unavailable');
      return (await debug.xln()).getTokenInfo(tokenId);
    }, receiveTokenId);
    if (!receiveToken) throw new Error(`Receive token unavailable: ${receiveTokenId}`);
    if (maker.priceTicks === undefined) throw new Error(`Resting cross quote has no price: ${maker.orderId}`);
    // Use the live maker's exact execution quantum, as swap-command-plan does.
    // A complete user order takes only part of this larger resting MM order.
    const take = requantizeRemainingSwapAtPriceForDimensions(1, receiveTokenId, scenario.giveAmount, maker.priceTicks, {
      giveTokenDecimals: 6,
      wantTokenDecimals: receiveToken.decimals,
    });
    if (!take)
      throw new Error(
        `Resting cross quote cannot execute within ${scenario.giveAmount} source units: ${maker.orderId}`,
      );
    expect(take.effectiveGive).toBeGreaterThan(0n);
    expect(take.effectiveGive).toBeLessThanOrEqual(scenario.giveAmount);
    expect(take.effectiveGive).toBeLessThan(maker.remaining.targetRemaining);
    expect(take.effectiveWant).toBeGreaterThan(0n);
    expect(take.effectiveWant).toBeLessThan(maker.remaining.sourceRemaining);
    await page.getByTestId('swap-want').locator('..').getByRole('button').click();
    await expect(page.getByRole('option', { name: new RegExp(`^${receiveToken.symbol}`) })).toBeVisible({
      timeout: 5_000,
    });
    await page.getByRole('option', { name: new RegExp(`^${receiveToken.symbol}`) }).click();
    await page.getByTestId('swap-give').fill(formatUnits(take.effectiveGive, 6));
    await page.getByTestId('swap-want').fill(formatUnits(take.effectiveWant, receiveToken.decimals));
    if (receiveTokenId === 1) {
      await page.getByRole('button', { name: 'Same network', exact: true }).click();
      await expect(page.getByTestId('swap-want')).toHaveValue('');
      await page.getByTestId('swap-want').fill(formatUnits(take.effectiveWant, receiveToken.decimals));
      await expect(page.getByTestId('swap-submit')).toBeDisabled();
      await expect(page.getByText('Choose two different tokens', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Across networks', exact: true }).click();
      await expect(page.getByTestId('swap-want')).toHaveValue('');
      await page.getByTestId('swap-want').fill(formatUnits(take.effectiveWant, receiveToken.decimals));
      await expect(page.getByTestId('swap-submit')).toBeEnabled();
    }
    const parties = { sourceEntityId, sourceHubId, targetEntityId, targetHubId, receiveTokenId };
    const feeDisclosure = page.getByTestId('swap-receive-fees');
    await expect(feeDisclosure).toContainText(
      'no committed collateral fee policy available. This does not mean zero fees.',
    );
    // Current Swap submits target capacity setup with the order. Drafting must
    // not open an Account or grant credit before the user presses Swap.
    const before = await page.evaluate(async ids => {
      const debug = (window as DebugWindow).__xln;
      const env = debug?.env();
      if (!debug || !env) throw new Error('Wallet diagnostics unavailable');
      const xln = await debug.xln();
      const source = [...env.state.eReplicas.values()].find(replica => replica.entityId === ids.sourceEntityId);
      const target = [...env.state.eReplicas.values()].find(replica => replica.entityId === ids.targetEntityId);
      const account = source?.state.accounts.get(ids.sourceHubId);
      const delta = account?.state.deltas.get(1);
      if (!source || !target || !delta) throw new Error('Funded source or target owner missing');
      const derived = xln.deriveDelta(delta, xln.isLeftEntity(ids.sourceEntityId, ids.sourceHubId));
      return {
        source: { balance: String(derived.outCollateral + derived.outPeerCredit), debt: String(derived.inOwnCredit) },
        targetAccountPresent: target.state.accounts.has(ids.targetHubId),
        routes: [source, target].map(replica => [...(replica.state.crossJurisdictionSwaps?.keys() ?? [])]),
      };
    }, parties);
    expect(BigInt(before.source.balance)).toBeGreaterThanOrEqual(take.effectiveGive);
    expect(BigInt(before.source.balance)).toBeLessThanOrEqual(BigInt(scenario.funding) * 1_000_000n);
    expect(before.source.debt).toBe('0');
    expect(before.targetAccountPresent).toBe(false);
    expect(before.routes).toEqual([[], []]);
    const submit = page.getByTestId('swap-submit');
    await expect(submit).toBeEnabled();
    await expect(
      page.getByText(`Placing this order also prepares incoming capacity with ${sourceHubLabel}.`, { exact: false }),
    ).toBeVisible();
    await expect(feeDisclosure).toContainText(
      `Gross receive: ${formatUnits(take.effectiveWant, receiveToken.decimals)} ${receiveToken.symbol}`,
    );
    await expect(feeDisclosure).toContainText('If your account automatically requests collateral after receiving');
    await expect(feeDisclosure).toContainText(
      'The final fee and net amount depend on your account policy and balance at that time.',
    );
    const preSwapDisclosure = await feeDisclosure.innerText();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(feeDisclosure).toBeVisible();
    await expect(page.locator('.toasts')).toHaveCount(0, { timeout: 6_000 });
    const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(mobileOverflow).toBeLessThanOrEqual(1);
    const mobileFeeBox = await feeDisclosure.boundingBox();
    const mobileSubmitBox = await submit.boundingBox();
    if (!mobileFeeBox || !mobileSubmitBox) throw new Error('Mobile receive fees or Swap control has no layout box');
    expect(mobileSubmitBox.y).toBeGreaterThanOrEqual(mobileFeeBox.y + mobileFeeBox.height);
    await page.screenshot({ path: '/tmp/xln-cross-receive-fees-mobile.png', fullPage: true });
    await page.setViewportSize({ width: 1280, height: 860 });
    await page.screenshot({ path: '/tmp/xln-cross-receive-fees-desktop.png', fullPage: true });
    await submit.click();
    await expect(page.getByTestId('swap-give')).toHaveValue('', { timeout: 15_000 });
    // A new unsent draft renders the now-committed receiving tariff. Submission
    // clears the old ticket; do not race its transient fee disclosure.
    await page.getByTestId('swap-give').fill('1');
    await page.getByTestId('swap-want').fill('1');
    await expect(page.getByTestId('swap-rebalance-tariff')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('swap-rebalance-tariff')).toContainText(
      `0.1 ${receiveToken.symbol} base + 0 ${receiveToken.symbol} gas + 1 bps`,
    );
    const disclosedPolicyVersion = await page.getByTestId('swap-rebalance-tariff').getAttribute('data-policy-version');
    let observedProgress = '';
    await expect
      .poll(
        async () => {
          const state = await readCross(page, parties);
          const progress = safeStringify([state.source.routes, state.target.routes]);
          if (progress !== observedProgress) {
            console.log(`CROSS_ROUTE_PROGRESS ${safeStringify(state)}`);
            observedProgress = progress;
          }
          return {
            source: state.source.routes.map(route => route.status),
            target: state.target.routes.map(route => route.status),
          };
        },
        { timeout: 15_000 },
      )
      .toEqual({ source: ['settled'], target: ['settled'] });
    await expect
      .poll(
        async () => {
          const state = await readCross(page, parties);
          return [state.source, state.target].map(leg => ({
            pending: leg.pending,
            mempool: leg.mempool,
            pulls: leg.pulls,
          }));
        },
        { timeout: 10_000 },
      )
      .toEqual([
        { pending: false, mempool: 0, pulls: 0 },
        { pending: false, mempool: 0, pulls: 0 },
      ]);
    const after = await readCross(page, parties);
    const completedRoute = after.source.routes[0];
    if (!completedRoute) throw new Error('Committed cross route missing');
    const recoveryBefore = await readCrossRecoveryProof(page, parties, completedRoute.orderId);
    const intentHeight = recoveryBefore.preparations[0]?.height;
    if (intentHeight === undefined || intentHeight < 2) throw new Error('Cross intent WAL boundary missing');
    // Read the actual persisted state immediately before the paired intent,
    // after bilateral target setup. Never infer it from today's balance.
    const prepared = await readCross(page, parties, intentHeight - 1);
    expect(prepared.source.balance).toBe(before.source.balance);
    expect(prepared.target.balance).toBe('0');
    expect(prepared.target.incoming).toBe(take.effectiveWant.toString());
    expect(prepared.target.credit).toBe(take.effectiveWant.toString());
    expect(prepared.target.rebalancePolicy.r2cRequestSoftLimit).not.toBe(prepared.target.rebalancePolicy.hardLimit);
    expect(prepared.source.routes).toEqual([]);
    expect(prepared.target.routes).toEqual([]);
    expect(prepared.target.feePolicy).toEqual({
      policyVersion: Number(disclosedPolicyVersion),
      baseFee: '100000',
      gasFee: '0',
      liquidityFeeBps: '1',
    });
    expect(take.effectiveWant).toBeLessThan(BigInt(prepared.target.rebalancePolicy.r2cRequestSoftLimit));
    const sourceDebit = BigInt(before.source.balance) - BigInt(after.source.balance);
    const targetReceived = BigInt(after.target.balance) - BigInt(prepared.target.balance);
    const feeEvidence = await page.evaluate(
      async ids => {
        const debug = (window as DebugWindow).__xln;
        const runtime = debug?.env();
        if (!debug || !runtime) throw new Error('Wallet runtime diagnostics unavailable');
        const frames = await (
          await debug.xln()
        ).readPersistedAccountFrameHistory(runtime, ids.targetEntityId, ids.targetHubId, ids.afterHeight, {
          maxAccountHeight: ids.afterHeight,
        });
        return frames
          .filter(frame => frame.height > ids.preparedHeight)
          .flatMap(frame =>
            frame.accountTxs
              .filter(tx => tx.type === 'request_collateral')
              .map(tx => ({
                height: frame.height,
                stateHash: frame.stateHash,
                root: frame.accountStateRoot,
                tokenId: tx.data.tokenId,
                feeTokenId: tx.data.feeTokenId ?? tx.data.tokenId,
                amount: tx.data.amount.toString(),
                fee: tx.data.feeAmount.toString(),
                policyVersion: tx.data.policyVersion,
              })),
          );
      },
      { ...parties, preparedHeight: prepared.target.height, afterHeight: after.target.height },
    );
    // checkAutoRebalance triggers on outPeerCredit, not the gross owned balance.
    // This real partial fill remains below the committed automatic threshold:
    // no collateral request and no prepaid fee are permitted in these frames.
    expect(after.target.rebalancePolicy).toEqual(prepared.target.rebalancePolicy);
    expect(after.target.feePolicy).toEqual(prepared.target.feePolicy);
    expect(after.target.uncollateralized).toBe(take.effectiveWant.toString());
    expect(BigInt(after.target.uncollateralized)).toBeLessThan(
      BigInt(after.target.rebalancePolicy.r2cRequestSoftLimit),
    );
    expect(feeEvidence).toEqual([]);
    const collateralFeePaid = feeEvidence.reduce((sum, fee) => sum + BigInt(fee.fee), 0n);
    expect(collateralFeePaid).toBe(0n);
    expect(after.source.debt).toBe('0');
    expect(after.target.debt).toBe('0');
    expect(sourceDebit).toBe(take.effectiveGive);
    expect(after.source.routes[0]?.filledSource).toBe(take.effectiveGive.toString());
    expect(after.source.routes[0]?.filledTarget).toBe(take.effectiveWant.toString());
    expect(targetReceived + collateralFeePaid).toBe(take.effectiveWant);
    expect(after.source.root).not.toBe(prepared.source.root);
    expect(after.target.root).not.toBe(prepared.target.root);
    expect(after.target.credit).toBe(prepared.target.credit);
    expect(after.source.routes).toEqual(after.target.routes);
    const bilateral = await Promise.all([
      expectBilateralCommit(page, sourceHubLabel, { entityId: sourceEntityId, hubId: sourceHubId, tokenId: 1 }),
      expectBilateralCommit(page, sourceHubLabel, {
        entityId: targetEntityId,
        hubId: targetHubId,
        tokenId: receiveTokenId,
      }),
    ]);
    // Open the actual receiving Account only after proving the trade. Filling a
    // new draft must not send it, and navigation makes no draft-preservation claim.
    await page.getByTestId('swap-give').fill('1');
    await page.getByTestId('swap-want').fill('1');
    await expect(feeDisclosure.getByRole('link')).toHaveAttribute('href', `/accounts/${targetHubId}`);
    await feeDisclosure.getByRole('link').click();
    await expect(page).toHaveURL(new RegExp(`/accounts/${targetHubId}$`));
    await expect(page.getByTestId('account-manage')).toBeEnabled();
    await page.getByTestId('account-manage').click();
    const collateralSettings = page.getByRole('dialog', { name: `Manage · ${sourceHubLabel}`, exact: true });
    await expect(collateralSettings).toBeVisible();
    await expect(collateralSettings.getByTestId('manage-tab-collateral')).toHaveAttribute('aria-selected', 'true');
    await expect(collateralSettings.locator('.mode-card.active .t')).toHaveText(receiveToken.symbol);
    const afterSettings = await readCross(page, parties);
    // J finality may move the same owned value into collateral while browsing.
    // Navigation must preserve balances, debt, permanent credit and the exact trade.
    for (const side of ['source', 'target'] as const) {
      expect(afterSettings[side].balance).toBe(after[side].balance);
      expect(afterSettings[side].debt).toBe(after[side].debt);
      expect(afterSettings[side].credit).toBe(after[side].credit);
      expect(afterSettings[side].routes).toEqual(after[side].routes);
    }
    const accountUrl = page.url();
    expect(recoveryBefore.runtimeId).toBe(wallet.runtimeId);
    expect(recoveryBefore.preparations.map(input => input.entityId)).toEqual([targetEntityId, sourceEntityId]);
    expect(new Set(recoveryBefore.preparations.map(input => input.frameHash)).size).toBe(1);
    for (const account of recoveryBefore.accounts) {
      expect(account.executions.map(execution => execution.type)).toEqual(['cross_pull_lock', 'cross_pull_close']);
    }
    await page.reload({ waitUntil: 'domcontentloaded' });
    await reopenStack(page, wallet);
    const recoveredHistory = await readCrossRecoveryProof(
      page,
      parties,
      completedRoute.orderId,
      recoveryBefore.frame.height,
    );
    expect(recoveredHistory).toEqual(recoveryBefore);
    await expect
      .poll(
        async () => {
          const state = await readCross(page, parties);
          return [state.source, state.target].map(leg => ({
            pending: leg.pending,
            mempool: leg.mempool,
            pulls: leg.pulls,
          }));
        },
        { timeout: 10_000 },
      )
      .toEqual([
        { pending: false, mempool: 0, pulls: 0 },
        { pending: false, mempool: 0, pulls: 0 },
      ]);
    const afterRecovery = await readCross(page, parties);
    for (const side of ['source', 'target'] as const) {
      expect(afterRecovery[side].balance).toBe(afterSettings[side].balance);
      expect(afterRecovery[side].debt).toBe(afterSettings[side].debt);
      expect(afterRecovery[side].credit).toBe(afterSettings[side].credit);
      expect(afterRecovery[side].routes).toEqual(afterSettings[side].routes);
      expect(afterRecovery[side].rebalancePolicy).toEqual(afterSettings[side].rebalancePolicy);
      expect(afterRecovery[side].feePolicy).toEqual(afterSettings[side].feePolicy);
    }
    const recoveryCurrent = await readCrossRecoveryProof(page, parties, completedRoute.orderId);
    expect(recoveryCurrent.frame.height).toBeGreaterThanOrEqual(recoveryBefore.frame.height);
    expect(recoveryCurrent.runtimeId).toBe(recoveryBefore.runtimeId);
    expect(recoveryCurrent.preparations).toEqual(recoveryBefore.preparations);
    expect(recoveryCurrent.accounts.map(account => account.executions)).toEqual(
      recoveryBefore.accounts.map(account => account.executions),
    );
    const activity = await expectCrossActivity(page, {
      entityId: sourceEntityId,
      orderId: completedRoute.orderId,
      status: completedRoute.status,
    });
    const evidence = safeStringify(
      {
        scope: 'two local EVM jurisdictions; not native TVM',
        activity,
        parties,
        maker,
        take,
        faucetRequested: (BigInt(scenario.funding) * 1_000_000n).toString(),
        faucetNetAfterRebalance: before.source.balance,
        faucetDifference: (BigInt(scenario.funding) * 1_000_000n - BigInt(before.source.balance)).toString(),
        before,
        prepared,
        after,
        afterSettings,
        afterRecovery,
        bilateral,
        recoveryBefore,
        recoveredHistory,
        recoveryCurrent,
        sourceDebit,
        targetReceived,
        feeEvidence,
        collateralFeePaid,
        noCollateralRequestReason: 'uncollateralized peer credit remains below the committed automatic threshold',
        preSwapDisclosure,
        disclosedPolicyVersion,
        collateralSettings: { accountUrl, token: receiveToken.symbol },
        mobileOverflow,
        mobileLayout: { fee: mobileFeeBox, submit: mobileSubmitBox },
      },
      2,
    );
    await test.info().attach('cross-swap-committed-balances', { body: evidence, contentType: 'application/json' });
    console.log(`CROSS_SWAP_COMMITTED ${evidence}`);
    expect(errors).toEqual([]);
    expect(authErrors).toEqual([]);
  });

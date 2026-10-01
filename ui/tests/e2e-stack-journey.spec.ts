import { readMarketRoutes } from './cross-market';
import { expect, test, type Page } from '@playwright/test';
import { formatUnits, JsonRpcProvider, parseUnits, ZeroHash } from 'ethers';
import type { RuntimeAdapterViewFrame, RuntimeReplica, XLNModule } from '../../core/api/public/runtime-module';
import type { RuntimeAdapter } from '../../core/api/runtime-adapter/types';
import { getCrossJurisdictionRouteRemainingAmounts } from '../../core/extensions/cross-j/orderbook';
import { requantizeRemainingSwapAtPriceForDimensions } from '../../core/orderbook';
import { computeAccountKey } from '../../core/jurisdiction/adapter/events/contract-codec';
import { safeStringify } from '../../core/protocol/serialization';
import { selectMarketMakerCrossRoutes } from '../../core/scripts/operations/hlt/cross/cross-boundary';
import { LOCAL_TEST_STACK_BASES } from '../../core/scripts/e2e/harness/local-test-port-lease';
import { Depository__factory } from '../../jurisdictions/typechain-types/factories/Depository.sol/Depository__factory';
import { enterStack, readWalletCheckpoint, reopenStack } from './stack';
import { readCommittedPayment } from './payment-evidence';

type DebugWindow = Window & { __xln?: { adapter: () => RuntimeAdapter | null; env: () => RuntimeReplica | null; xln: () => Promise<XLNModule> } };
const WAIT = { timeout: 15_000, intervals: [100, 250, 500] };
const home = (page: Page) => page.getByTestId('nav-home').locator('visible=true').first().click();

function privateChain(baseURL: string | undefined) {
  const rpc = process.env['XLN_UI_DISPUTE_PRIVATE_RPC'];
  const origin = process.env['XLN_UI_DISPUTE_PRIVATE_ORIGIN'];
  if (!rpc || !origin || baseURL !== origin) throw new Error('JOURNEY_ISOLATED_STAND_REQUIRED');
  const url = new URL(rpc); const port = Number(url.port);
  if (url.hostname !== '127.0.0.1' || !LOCAL_TEST_STACK_BASES.some(base => base === port) || origin !== `http://127.0.0.1:${port + 2}`) throw new Error('JOURNEY_PRIVATE_CLOCK_ENDPOINT_INVALID');
  return new JsonRpcProvider(rpc, 31337, { staticNetwork: true, cacheTimeout: -1 });
}

/** Money and actual live queues belong to one unchanged committed frame. Diagnostics never submit money. */
const snapshot = (page: Page, entityId: string, hubId: string) => page.evaluate(async ({ entityId, hubId }) => {
  const debug = (window as DebugWindow).__xln; const adapter = debug?.adapter();
  if (!debug || !adapter) throw new Error('Journey diagnostics unavailable');
  const xln = await debug.xln();
  const frame = await adapter.read<RuntimeAdapterViewFrame>('view-frame', { entityId, accountsLimit: 100 });
  const active = frame.activeEntity; const env = debug.env();
  if (!active || frame.activeEntityId !== entityId || active.accounts.nextCursor !== null || !env?.infrastructure) throw new Error('Journey complete owner view unavailable');
  const account = active.accounts.items.find(row => row.state.leftEntity === hubId || row.state.rightEntity === hubId);
  if (!account || !active.core.config.jurisdiction) throw new Error('Journey Account/jurisdiction unavailable');
  if (env.infrastructure.stateMutationInFlight || env.infrastructure.processingPromise || env.state.height !== frame.height) return null;
  // No await below: historical Account views cannot establish a live queue drain.
  const entities = [...env.state.eReplicas.values()]; const accounts = entities.flatMap(replica => [...replica.state.accounts.values()]);
  const submit = entities.find(replica => replica.entityId === entityId)?.jSubmitState;
  const sent = active.core.jBatchState?.sentBatch;
  const tokens = [1, 2, 3].map(tokenId => {
    const delta = account.state.deltas.get(tokenId);
    const derived = delta ? xln.deriveDelta(delta, xln.isLeftEntity(entityId, hubId)) : null;
    return { tokenId, reserve: String(active.core.reserves.get(tokenId) ?? 0n), owned: String(derived ? derived.outCollateral + derived.outPeerCredit - derived.inOwnCredit : 0n), collateral: String(delta?.collateral ?? 0n), offdelta: String(delta?.offdelta ?? 0n) };
  });
  return { disputeConfig: account.state.disputeConfig, height: frame.height, accountHeight: account.currentHeight, root: account.currentFrame.accountStateRoot, status: account.status, dispute: account.activeDispute ?? null, jNonce: account.state.jNonce, depository: active.core.config.jurisdiction.depositoryAddress, tokens,
    chainTimeWait: submit?.lastResultOutcome === 'transientFailure' && submit.lastFailure?.adapterFailure?.code === 'DISPUTE_FINALIZATION_AWAITING_CHAIN_TIME',
    sentBatch: sent ? { hash: sent.batchHash, nonce: sent.entityNonce, generation: active.core.jBatchState!.broadcastCount, notBefore: sent.batch.disputeFinalizations.map(row => row.submitNotBeforeTimestamp) } : null,
    otherHubs: frame.entities.filter(row => row.isHub && row.entityId !== hubId && row.jurisdiction?.name === active.core.config.jurisdiction?.name).map(row => ({ id: row.entityId, label: row.label })),
    routes: [...(active.core.crossJurisdictionSwaps?.values() ?? [])].map(route => ({ orderId: route.orderId, status: route.status, filledSource: String(route.filledSourceAmount ?? 0n), filledTarget: String(route.filledTargetAmount ?? 0n) })),
    queues: { runtimeEntityInputs: env.runtimeMempool.entityInputs.length, runtimeTxs: env.runtimeMempool.runtimeTxs.length, runtimeJInputs: env.runtimeMempool.jInputs?.length ?? 0,
      pendingOutputs: env.pendingOutputs?.length ?? 0, pendingNetworkOutputs: env.pendingNetworkOutputs?.length ?? 0, networkInbox: env.networkInbox?.length ?? 0, pendingCommittedJOutbox: env.infrastructure.pendingCommittedJOutbox?.length ?? 0,
      entityMempool: entities.reduce((sum, row) => sum + row.mempool.length, 0), entityCandidates: entities.filter(row => row.proposal || row.lockedFrame || row.candidate).length,
      accountMempool: accounts.reduce((sum, row) => sum + row.mempool.length, 0), pendingAccounts: accounts.filter(row => row.pendingFrame || row.pendingAccountInput).length,
      jDraftOperations: entities.reduce((sum, row) => sum + (row.state.jBatchState ? Object.values(row.state.jBatchState.batch).filter(Array.isArray).reduce((n, ops) => n + ops.length, 0) : 0), 0),
      jSentBatches: entities.filter(row => row.state.jBatchState?.sentBatch).length, jRecoveryBatches: entities.reduce((sum, row) => sum + (row.state.jBatchState?.recoveryBatches?.length ?? 0), 0),
      locks: accounts.reduce((sum, row) => sum + row.state.locks.size, 0), pulls: accounts.reduce((sum, row) => sum + (row.state.pulls?.size ?? 0), 0), offers: accounts.reduce((sum, row) => sum + row.state.swapOffers.size, 0) } };
}, { entityId, hubId });

/** Capture only delivery evidence before context closes; no seeds or Runtime input payloads. */
const capturePendingDelivery = (page: Page) => page.evaluate(async () => {
  const debug = (window as DebugWindow).__xln; const env = debug?.env();
  if (!debug || !env?.infrastructure) throw new Error('Journey outbox evidence unavailable');
  const xln = await debug.xln(); const infra = env.infrastructure; const p2p = infra.p2p;
  const outputs = structuredClone(env.pendingNetworkOutputs ?? []); const height = env.state.height;
  const readiness = outputs.map(output => ({ runtimeId: output.runtimeId, entityId: output.entityId, canDeliver: output.runtimeId ? p2p?.canDeliver(output.runtimeId) : null, directCanDeliver: output.runtimeId ? infra.canDeliverEntityInputs?.(output.runtimeId) : null, verifiedRoute: p2p?.getVerifiedRuntimeRoute(output.entityId), profile: env.gossip.getProfile(output.entityId) }));
  const transport = { entityInputsReady: infra.entityInputsReady, connected: p2p?.isConnected(), peers: p2p?.getDirectPeerState(), queues: p2p?.getQueueState() };
  const accounts = [...env.state.eReplicas.values()].flatMap(replica => [...replica.state.accounts.values()].map(account => ({ entityId: replica.entityId, left: account.state.leftEntity, right: account.state.rightEntity, status: account.status, height: account.currentHeight, root: account.currentFrame.accountStateRoot, pendingFrame: account.pendingFrame, pendingAccountInput: account.pendingAccountInput })));
  const frames = [];
  for (const source of new Set([height, ...outputs.map(output => output.sourceRuntimeFrame?.height).filter((value): value is number => value !== undefined)])) {
    const frame = await xln.readPersistedStorageFrameRecord(env, source);
    if (!frame) throw new Error(`Journey outbox source WAL unavailable: ${source}`);
    const payloads = await xln.readPersistedStorageFramePayloads(env, frame, { includeRuntimeMachine: false });
    frames.push({ height: source, timestamp: frame.timestamp, frameHash: frame.frameHash, runtimeOutputs: payloads.runtimeOutputs, runtimeTxTypes: frame.runtimeInput.runtimeTxs?.map(tx => tx.type), entityInputTypes: frame.runtimeInput.entityInputs.map(input => ({ entityId: input.entityId, types: input.entityTxs?.map(tx => tx.type) })) });
  }
  return xln.safeStringify({ runtimeId: env.runtimeId, height, outputs, readiness, transport, accounts, frames });
});

async function settled(page: Page, owner: string, hub: string) {
  let value = await snapshot(page, owner, hub);
  try { await expect.poll(async () => { value = await snapshot(page, owner, hub); return value !== null && Object.values(value.queues).every(n => n === 0); }, WAIT).toBe(true); }
  catch (error) {
    try { await test.info().attach('journey-pending-delivery', { body: await capturePendingDelivery(page), contentType: 'application/json' }); }
    catch (diagnosticError) { throw new AggregateError([error, diagnosticError], 'Journey queue failure and evidence capture failure'); }
    throw error;
  }
  if (!value) throw new Error('Journey committed snapshot unavailable');
  return value;
}
type Snapshot = Awaited<ReturnType<typeof settled>>;
function token(state: Snapshot, id: number) {
  const found = state.tokens.find(row => row.tokenId === id);
  if (!found) throw new Error(`Journey token unavailable: ${id}`);
  return found;
}
async function creditReceive(page: Page) {
  const spectrum = page.getByTestId('receive-spectrum');
  await expect(spectrum).toBeVisible(WAIT); await expect(page.getByTestId('swap-submit')).toBeDisabled();
  await spectrum.getByRole('button', { name: 'Accept it as credit instead', exact: true }).click();
  await expect(page.getByTestId('receive-spectrum-confirm')).toHaveText('Extend credit limit');
  await page.getByTestId('receive-spectrum-confirm').click();
  await expect(spectrum).toHaveCount(0, WAIT); await expect(page.getByTestId('swap-submit')).toBeEnabled(WAIT);
}
async function moveReserve(page: Page, hub: string, amount: bigint) {
  await home(page); await page.getByTestId('home-move').click();
  await page.getByTestId('move-from-reserve').click(); await page.getByTestId('move-to-account').click();
  await page.getByTestId('move-target-hub').selectOption(hub); await page.getByTestId('move-amount').fill(formatUnits(amount, 6));
  await expect(page.getByTestId('move-now')).toBeEnabled(WAIT); await page.getByTestId('move-now').click();
  await expect(page.getByTestId('home-total')).toBeVisible(WAIT);
}
async function oppositeQuote(label: string, sourceHub: string, targetHub: string, decimals: number) {
  const routes = await readMarketRoutes(targetHub, label);
  const maker = selectMarketMakerCrossRoutes(routes, targetHub, sourceHub).find(route => route.status === 'resting' && route.target.tokenId === 1 && route.source.tokenId === 3 && getCrossJurisdictionRouteRemainingAmounts(route).targetRemaining > 20_000_000n);
  if (!maker || maker.priceTicks === undefined) throw new Error('Journey executable cross USDC/USDT quote unavailable');
  const take = requantizeRemainingSwapAtPriceForDimensions(1, 3, 20_000_000n, maker.priceTicks, { giveTokenDecimals: 6, wantTokenDecimals: decimals });
  if (!take || take.effectiveGive <= 0n || take.effectiveWant <= 0n || take.effectiveWant >= getCrossJurisdictionRouteRemainingAmounts(maker).sourceRemaining) throw new Error('Journey cross quote has insufficient liquidity');
  return take;
}

// Same private-chain requirement as the dispute finality test, plus the
// maker-side manifest the cross-network leg reads.
test.skip(
  !process.env['XLN_UI_DISPUTE_PRIVATE_RPC'] || !process.env['XLN_UI_DISPUTE_PRIVATE_ORIGIN'],
  'needs a private dispute stand: XLN_UI_DISPUTE_PRIVATE_RPC and XLN_UI_DISPUTE_PRIVATE_ORIGIN',
);

test('one wallet funds 100, pays, swaps on both networks, disputes and moves recovered reserve to another hub', { tag: '@functional' }, async ({ page, baseURL }, info) => {
  test.setTimeout(60_000);
  const provider = privateChain(baseURL); const errors: string[] = []; const faucets: string[] = []; const evidence: Record<string, unknown> = {};
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { const path = new URL(request.url()).pathname; if (request.method() === 'POST' && path.startsWith('/api/faucet/')) faucets.push(path); });
  async function phase(name: string, run: () => Promise<void>) { const start = Date.now(); try { await test.step(name, run); } finally { console.log(`JOURNEY_PHASE ${name} ms=${Date.now() - start}`); } }
  try {
    const bootStarted = Date.now();
    const wallet = await enterStack(page);
    console.log(`JOURNEY_PHASE boot ms=${Date.now() - bootStarted}`);
    await page.getByTestId('account-row').first().click();
    const hub = new URL(page.url()).pathname.split('/accounts/')[1];
    if (!hub || !/^0x[0-9a-f]{64}$/.test(hub)) throw new Error('Journey primary hub unavailable');
    const initial = await settled(page, wallet.entityId, hub);
    expect(initial.tokens.every(row => row.reserve === '0' && row.owned === '0')).toBe(true);
    await phase('fund-100-and-collateralize', async () => {
      await page.getByTestId('nav-manage').locator('visible=true').first().click(); await page.getByTestId('manage-assets').click();
      for (const [kind, amount] of [['gas', '0.1'], ['reserve', '100']] as const) {
        await page.getByTestId('faucet-amount').fill(amount);
        const response = page.waitForResponse(row => new URL(row.url()).pathname === `/api/faucet/${kind}` && row.request().method() === 'POST');
        await page.getByTestId(`faucet-${kind}`).click(); const result = await response;
        expect(result.ok(), await result.text()).toBe(true); await expect(page.getByTestId(`faucet-${kind}`)).toBeEnabled(WAIT);
      }
      await expect.poll(async () => token(await settled(page, wallet.entityId, hub), 1).reserve, WAIT).toBe('100000000');
      await moveReserve(page, hub, 100_000_000n);
      await expect.poll(async () => token(await settled(page, wallet.entityId, hub), 1), WAIT).toMatchObject({ reserve: '0', owned: '100000000', collateral: '100000000', offdelta: '0' });
    });
    let expectedUsdc = 100_000_000n;
    await phase('pay-25', async () => {
      const checkpoint = await readWalletCheckpoint(page);
      await page.getByTestId('home-pay').click(); await page.getByTestId('pay-to').fill('H2'); await page.getByTestId('pay-amount').fill('25');
      await expect(page.getByTestId('pay-submit')).toBeEnabled(WAIT); await page.getByTestId('pay-submit').click();
      await expect(page.getByTestId('receipt-kicker')).toHaveText('Paid', WAIT);
      const payment = await readCommittedPayment(page, wallet.entityId, checkpoint.frame.height);
      expect(payment.amount).toBe('25000000'); expect(BigInt(payment.senderAmount)).toBe(25_000_000n + BigInt(payment.fee));
      expectedUsdc -= BigInt(payment.senderAmount);
      await page.getByTestId('receipt-done').click();
      expect(token(await settled(page, wallet.entityId, hub), 1).owned).toBe(String(expectedUsdc)); evidence.payment = payment;
    });
    let expectedWeth = 0n;
    await phase('same-network-swap', async () => {
      const before = await settled(page, wallet.entityId, hub);
      await page.getByTestId('home-swap').click(); const book = page.getByTestId('orderbook').locator('visible=true').first();
      await expect(book).toHaveAttribute('data-status', 'live', WAIT); await book.locator('.bk-row.ask').last().click();
      const give = parseUnits(await page.getByTestId('swap-give').inputValue(), 6); const want = parseUnits(await page.getByTestId('swap-want').inputValue(), 18);
      expect(give).toBeGreaterThan(15_000_000n);
      await page.getByTestId('swap-give').fill('15'); await page.getByTestId('swap-want').fill(formatUnits(want * 15_000_000n / give, 18));
      await creditReceive(page); await page.getByTestId('swap-submit').click();
      await expect.poll(async () => BigInt(token(await settled(page, wallet.entityId, hub), 2).owned), WAIT).toBeGreaterThan(0n);
      const after = await settled(page, wallet.entityId, hub);
      const fills = await page.evaluate(async ({ owner, hub, before, after }) => {
        const debug = (window as DebugWindow).__xln; const env = debug?.env();
        if (!debug || !env) throw new Error('Journey signed swap frames unavailable');
        const frames = await (await debug.xln()).readPersistedAccountFrameHistory(env, owner, hub, after, { maxAccountHeight: after });
        return frames.filter(frame => frame.height > before).flatMap(frame => frame.accountTxs.flatMap(tx => {
          if (tx.type !== 'swap_resolve') return [];
          if (tx.data.executionGiveAmount === undefined || tx.data.executionWantAmount === undefined) throw new Error('Journey exact signed swap execution missing');
          return [{ root: frame.accountStateRoot, give: String(tx.data.executionGiveAmount), want: String(tx.data.executionWantAmount), fee: String(tx.data.feeAmount ?? 0n), feeTokenId: tx.data.feeTokenId ?? 2 }];
        }));
      }, { owner: wallet.entityId, hub, before: before.accountHeight, after: after.accountHeight });
      expect(fills).toHaveLength(1); const fill = fills[0]; if (!fill) throw new Error('Journey signed fill missing');
      expect(fill.feeTokenId).toBe(2); expect(BigInt(fill.give)).toBeGreaterThan(0n); expect(BigInt(fill.give)).toBeLessThanOrEqual(15_000_000n);
      expectedUsdc -= BigInt(fill.give); expectedWeth = BigInt(fill.want) - BigInt(fill.fee);
      expect(token(after, 1).owned).toBe(String(expectedUsdc)); expect(token(after, 2).owned).toBe(String(expectedWeth)); evidence.sameSwap = fills;
    });
    let targetOwner = ''; let targetHub = ''; let expectedUsdt = 0n;
    await phase('cross-network-swap', async () => {
      await page.getByRole('button', { name: 'Across networks', exact: true }).click();
      targetOwner = await page.locator('.kv').filter({ hasText: 'Your other account' }).locator('select').inputValue(); expect(targetOwner).not.toBe(wallet.entityId);
      // This source label remains visible even before the new ticket has a quantizable price.
      const label = (await page.getByRole('button', { name: /^Up to .* with / }).innerText({ timeout: 5_000 })).split(' with ').at(-1);
      if (!label) throw new Error('Journey source hub label unavailable');
      const selection = page.locator('.kv').filter({ hasText: 'Hub there' }).locator('select');
      await selection.selectOption({ label }); targetHub = await selection.inputValue();
      const receiveToken = await page.evaluate(async () => { const debug = (window as DebugWindow).__xln; if (!debug) throw new Error('Journey tokens unavailable'); return (await debug.xln()).getTokenInfo(3); });
      if (!receiveToken) throw new Error('Journey receive token unavailable');
      const take = await oppositeQuote(label, hub, targetHub, receiveToken.decimals);
      await page.getByTestId('swap-want').locator('..').getByRole('button').click(); await page.getByRole('option', { name: new RegExp(`^${receiveToken.symbol}`) }).click();
      await page.getByTestId('swap-give').fill(formatUnits(take.effectiveGive, 6)); await page.getByTestId('swap-want').fill(formatUnits(take.effectiveWant, receiveToken.decimals));
      await page.getByRole('button', { name: `Open incoming account with ${label}`, exact: true }).click(); await creditReceive(page);
      expect(token(await settled(page, targetOwner, targetHub), 3).owned).toBe('0'); await page.getByTestId('swap-submit').click();
      await expect.poll(async () => (await settled(page, wallet.entityId, hub)).routes.map(route => route.status), WAIT).toEqual(['settled']);
      const source = await settled(page, wallet.entityId, hub); const target = await settled(page, targetOwner, targetHub);
      expect(target.routes).toEqual(source.routes); expect(source.routes[0]).toMatchObject({ filledSource: String(take.effectiveGive), filledTarget: String(take.effectiveWant) });
      expectedUsdc -= take.effectiveGive; expectedUsdt = take.effectiveWant;
      expect(token(source, 1).owned).toBe(String(expectedUsdc)); expect(token(source, 2).owned).toBe(String(expectedWeth));
      expect(token(target, 3).owned).toBe(String(expectedUsdt)); evidence.crossSwap = { take, source, target };
    });
    await phase('dispute-finality-and-recovered-reserve', async () => {
      await home(page); await page.getByTestId('account-row').first().click(); expect(new URL(page.url()).pathname).toBe(`/accounts/${hub}`);
      const before = await settled(page, wallet.entityId, hub); const contract = Depository__factory.connect(before.depository, provider); const fromBlock = await provider.getBlockNumber();
      await page.getByTestId('account-manage').click(); await page.getByTestId('manage-tab-dispute').click();
      await page.getByTestId('dispute-prepare').click(); await page.getByTestId('dispute-prepare-confirm').click();
      await home(page); await expect(page.getByTestId('pending-batch')).toContainText('Dispute start', WAIT); await page.getByTestId('batch-broadcast').click();
      await expect.poll(async () => { const value = await snapshot(page, wallet.entityId, hub); return Boolean(value?.dispute?.observedOnChain || value?.status === 'disputed'); }, WAIT).toBe(true);
      const started = await snapshot(page, wallet.entityId, hub);
      const starts = await contract.queryFilter(contract.filters.DisputeStarted(wallet.entityId, hub), fromBlock);
      expect(starts).toHaveLength(1); const start = starts[0]; if (!start) throw new Error('Journey signed dispute start missing');
      expect(start.args.leftResponseSeconds).toBe(BigInt(before.disputeConfig.leftResponseSeconds));
      expect(start.args.rightResponseSeconds).toBe(BigInt(before.disputeConfig.rightResponseSeconds));
      expect(start.args.disputeTimeout).toBe(start.args.disputeStartTimestamp + start.args.leftResponseSeconds + start.args.rightResponseSeconds);
      const deadline = Number(start.args.disputeTimeout) + 1;
      // Only the isolated chain advances; all transport authentication clocks stay real.
      // H1 may legally accept the initial proof before T; the starter must wait for T.
      // This journey verifies the exact payout from either real protocol finalizer.
      const beforeDeadlineBlock = await provider.getBlock('latest');
      expect(beforeDeadlineBlock?.timestamp).toBeLessThan(Number(start.args.disputeTimeout));
      expect(deadline, 'Journey requires ANVIL_GENESIS_TIMESTAMP at least three days in the past').toBeLessThan(Math.floor(Date.now() / 1000));
      await provider.send('evm_setNextBlockTimestamp', [deadline]); await provider.send('evm_mine', []);
      const deadlineBlock = await provider.getBlock('latest');
      expect(deadlineBlock?.timestamp).toBe(deadline);
      await expect.poll(async () => { const value = await snapshot(page, wallet.entityId, hub); return value ? [value.dispute, value.status, token(value, 1).reserve, token(value, 2).reserve] : null; }, WAIT).toEqual([null, 'disputed', String(expectedUsdc), String(expectedWeth)]);
      const after = await settled(page, wallet.entityId, hub); expect(BigInt(after.jNonce)).toBe(start.args.nonce + 1n);
      expect(after.tokens.every(row => row.collateral === '0' && row.offdelta === '0' && row.owned === '0')).toBe(true);
      const finalizations = (await Promise.all([contract.queryFilter(contract.filters.DisputeFinalized(wallet.entityId, hub), fromBlock), contract.queryFilter(contract.filters.DisputeFinalized(hub, wallet.entityId), fromBlock)])).flat();
      expect(finalizations).toHaveLength(1); const finalization = finalizations[0]; if (!finalization) throw new Error('Journey finalization receipt missing');
      const receipt = await finalization.getTransactionReceipt(); expect(receipt.status).toBe(1);
      const finalizer = finalization.args.sender.toLowerCase() === wallet.entityId.toLowerCase() ? 'starter-after-timeout' : 'counterparty-accepts-initial-proof';
      const finalBlock = await finalization.getBlock();
      if (finalizer === 'starter-after-timeout') expect(finalBlock.timestamp).toBeGreaterThanOrEqual(Number(start.args.disputeTimeout));
      expect(finalization.args.finalProofbodyHash).toBe(start.args.proofbodyHash); expect(finalization.args.nonce).toBe(start.args.nonce);
      expect((await contract._accounts(computeAccountKey(wallet.entityId, hub))).disputeHash).toBe(ZeroHash);
      for (const [id, expected] of [[1, expectedUsdc], [2, expectedWeth]] as const) {
        expect(await contract._reserves(wallet.entityId, id)).toBe(expected);
        const payouts = await contract.queryFilter(contract.filters.ReserveUpdated(wallet.entityId, id), receipt.blockNumber, receipt.blockNumber);
        expect(payouts.filter(event => event.transactionHash === receipt.hash).map(event => event.args.newBalance)).toEqual([expected]);
      }
      evidence.dispute = { before, started, after, finalizer, finalTimestamp: finalBlock.timestamp, beforeDeadlineBlock: { number: beforeDeadlineBlock?.number, timestamp: beforeDeadlineBlock?.timestamp }, deadlineBlock: { number: deadlineBlock?.number, timestamp: deadlineBlock?.timestamp }, startTx: start.transactionHash, finalTx: receipt.hash };
    });
    await phase('move-recovered-reserve-to-second-hub', async () => {
      const second = (await settled(page, wallet.entityId, hub)).otherHubs.find(row => row.label === 'H2');
      if (!second) throw new Error('Journey second hub on the same jurisdiction unavailable');
      await home(page); await page.getByRole('button', { name: 'Connect another account', exact: true }).click({ timeout: 5000 });
      const sheet = page.getByRole('dialog', { name: 'Open account', exact: true });
      await sheet.getByPlaceholder('or paste an entity id, 0x…').fill(second.id);
      const secondHub = await sheet.getByPlaceholder('or paste an entity id, 0x…').inputValue(); expect(secondHub).not.toBe(hub);
      await sheet.getByRole('button', { name: 'Propose account', exact: true }).click(); await expect(page.getByTestId('account-row')).toHaveCount(2, WAIT);
      const before = await settled(page, wallet.entityId, secondHub);
      expect(token(before, 1).reserve).toBe(String(expectedUsdc)); expect(token(before, 1).owned).toBe('0');
      await moveReserve(page, secondHub, expectedUsdc);
      await expect.poll(async () => token(await settled(page, wallet.entityId, secondHub), 1), WAIT).toMatchObject({ reserve: '0', owned: String(expectedUsdc), collateral: String(expectedUsdc), offdelta: '0' });
      expect(token(await settled(page, wallet.entityId, secondHub), 2).reserve).toBe(String(expectedWeth));
      expect(token(await settled(page, targetOwner, targetHub), 3).owned).toBe(String(expectedUsdt)); evidence.exit = await settled(page, wallet.entityId, secondHub);
      const checkpoint = await readWalletCheckpoint(page);
      await page.reload({ waitUntil: 'domcontentloaded' }); await reopenStack(page, wallet);
      const restored = await readWalletCheckpoint(page, checkpoint.frame.height);
      expect(restored.frame).toEqual(checkpoint.frame); expect(restored.accounts).toEqual(checkpoint.accounts);
      const current = await settled(page, wallet.entityId, secondHub); const target = await settled(page, targetOwner, targetHub);
      expect(token(current, 1).owned).toBe(String(expectedUsdc)); expect(token(current, 2).reserve).toBe(String(expectedWeth)); expect(token(target, 3).owned).toBe(String(expectedUsdt));
      evidence.recovery = { checkpoint, restored, current, target };
    });
    expect(faucets).toEqual(['/api/faucet/gas', '/api/faucet/reserve']); expect(errors).toEqual([]);
    await info.attach('same-wallet-economic-journey', { body: safeStringify({ runtimeId: wallet.runtimeId, entityId: wallet.entityId, faucets, expectedUsdc, expectedWeth, expectedUsdt, evidence }), contentType: 'application/json' });
  } finally { provider.destroy(); }
});

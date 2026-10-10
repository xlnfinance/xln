import { expect, test, type Page } from '@playwright/test';
import { ZeroHash } from 'ethers';
import { Depository__factory } from '../../jurisdictions/typechain-types/factories/Depository.sol/Depository__factory';
import { safeStringify } from '../../core/protocol/serialization';
import type { RuntimeAdapterViewFrame, RuntimeReplica, XLNModule } from '../../core/api/public/runtime-module';
import type { RuntimeAdapter } from '../../core/api/runtime-adapter/types';
import { privateChain, chainMoney, externalUsdc } from './dispute-chain';
import { enterStack } from './stack';

type DebugWindow = Window & { __xln?: { adapter: () => RuntimeAdapter | null; env: () => RuntimeReplica | null; xln: () => Promise<XLNModule>; store: { getState: () => { activeEntityId: string | null } } } };
const AMOUNT = 100_000_000n;
const WAIT = { timeout: 15_000, intervals: [100, 250, 500] };
const readState = (page: Page, hubId: string) => page.evaluate(async counterpartyId => {
  const debug = (window as DebugWindow).__xln;
  if (!debug) throw new Error('Wallet diagnostics unavailable');
  const adapter = debug.adapter();
  const entityId = debug.store.getState().activeEntityId;
  if (!adapter || !entityId) throw new Error('Dispute owner unavailable');
  const frame = await adapter.read<RuntimeAdapterViewFrame>('view-frame', { entityId });
  const active = frame.activeEntity;
  if (!active || frame.activeEntityId !== entityId) throw new Error('Dispute Entity unavailable');
  const account = await adapter.read<NonNullable<RuntimeAdapterViewFrame['activeEntity']>['accounts']['items'][number]>(`entity/${entityId}/account/${counterpartyId}`, { atHeight: frame.height });
  const delta = account.state.deltas.get(1);
  const jurisdiction = active.core.config.jurisdiction;
  if (!delta || !jurisdiction) throw new Error('Dispute USDC/J domain unavailable');
  const xln = await debug.xln();
  const derived = xln.deriveDelta(delta, xln.isLeftEntity(entityId, counterpartyId));
  const batch = active.core.jBatchState;
  return { entityId, signerId: active.core.signerId, height: frame.height, timestamp: active.core.timestamp, depository: jurisdiction.depositoryAddress, lastFinalizedJHeight: active.core.lastFinalizedJHeight,
    disputeConfig: account.state.disputeConfig, accountHeight: account.currentHeight, accountRoot: account.currentFrame.accountStateRoot, status: account.status,
    reserve: (active.core.reserves.get(1) ?? 0n).toString(), collateral: delta.collateral.toString(), ondelta: delta.ondelta.toString(), offdelta: delta.offdelta.toString(),
    ownValue: (derived.outCollateral + derived.outPeerCredit - derived.inOwnCredit).toString(), jNonce: account.state.jNonce,
    pending: Boolean(account.pendingFrame), mempool: account.mempoolCount, dispute: account.activeDispute ?? null,
    sentBatch: batch?.sentBatch ? { txHash: batch.sentBatch.txHash, batchHash: batch.sentBatch.batchHash, nonce: batch.sentBatch.entityNonce, lastFailure: batch.sentBatch.lastFailure, terminalFailure: batch.sentBatch.terminalFailure } : null,
    batch: { operations: batch ? Object.values(batch.batch).filter(Array.isArray).reduce((sum, rows) => sum + rows.length, 0) : 0, sent: Boolean(batch?.sentBatch), finalizations: batch?.batch.disputeFinalizations.length ?? 0 },
  };
}, hubId);

const readDisputeJournal = (page: Page, afterHeight: number, hubId: string) => page.evaluate(async ({ afterHeight, hubId }) => {
  const debug = (window as DebugWindow).__xln;
  if (!debug) throw new Error('Wallet diagnostics unavailable');
  const env = debug.env();
  const entityId = debug.store.getState().activeEntityId;
  if (!env || !entityId) throw new Error('Dispute journal owner unavailable');
  const xln = await debug.xln();
  const latest = await xln.getPersistedLatestHeight(env);
  const finalizeInputs: { height: number; timestamp: number; description: string | undefined }[] = [];
  const deadlineWakes: { height: number; timestamp: number; frameHash: string; dueAt: number }[] = [];
  const submissions: { height: number; timestamp: number; attemptId: string; batchHash: string; entityNonce: number; txHash: string | undefined }[] = [];
  for (let height = afterHeight + 1; height <= latest; height++) {
    // Accepted financial commands belong to canonical WAL, not the Activity log projection.
    const frame = await xln.readPersistedStorageFrameRecord(env, height);
    if (!frame) throw new Error(`DISPUTE_ACCEPTED_WAL_FRAME_MISSING:${height}`);
    for (const tx of frame.runtimeInput.runtimeTxs ?? []) if (tx.type === 'recordJSubmitResult' && tx.data.entityId === entityId && tx.data.outcome === 'submitted') submissions.push({ height, timestamp: frame.timestamp, attemptId: tx.data.attemptId, batchHash: tx.data.batchHash, entityNonce: tx.data.entityNonce, txHash: tx.data.txHash });
    for (const input of frame.runtimeInput.entityInputs) if (input.entityId === entityId) {
      for (const tx of input.entityTxs ?? []) {
        if (tx.type === 'disputeFinalize' && tx.data.counterpartyEntityId === hubId) finalizeInputs.push({ height, timestamp: frame.timestamp, description: tx.data.description });
        if (tx.type === 'scheduledWake' && tx.data.jobs.some(job => job.kind === 'hook' && job.id === `dispute-deadline:${hubId}`)) {
          if (!frame.frameHash) throw new Error(`DISPUTE_WAKE_FRAME_HASH_MISSING:${height}`);
          deadlineWakes.push({ height, timestamp: frame.timestamp, frameHash: frame.frameHash, dueAt: tx.data.dueAt });
        }
      }
    }
  }
  return { finalizeInputs, deadlineWakes, submissions };
}, { afterHeight, hubId });
async function faucet(page: Page, kind: 'gas' | 'reserve', amount: string): Promise<void> {
  await page.getByTestId('faucet-amount').fill(amount);
  const response = page.waitForResponse(res => new URL(res.url()).pathname === `/api/faucet/${kind}` && res.request().method() === 'POST');
  await page.getByTestId(`faucet-${kind}`).click();
  const result = await response;
  expect(result.ok(), await result.text()).toBe(true);
  await expect(page.getByTestId(`faucet-${kind}`)).toBeEnabled(WAIT);
}

async function fundCollateral(page: Page, hubId: string): Promise<void> {
  await page.getByTestId('nav-manage').locator('visible=true').first().click();
  await page.getByTestId('manage-assets').click();
  await faucet(page, 'gas', '0.1');
  await faucet(page, 'reserve', '100');
  await expect.poll(async () => (await readState(page, hubId)).reserve, WAIT).toBe(AMOUNT.toString());
  await page.getByTestId('nav-home').locator('visible=true').first().click();
  await page.getByTestId('home-move').click();
  await page.getByTestId('move-from-reserve').click();
  await page.getByTestId('move-to-account').click();
  await page.getByTestId('move-amount').fill('100');
  await page.getByTestId('move-now').click();
  await expect(page.getByTestId('home-total')).toBeVisible(WAIT);
  await expect.poll(async () => {
    const s = await readState(page, hubId);
    return [s.reserve, s.collateral, s.ownValue, s.pending, s.mempool, s.batch];
  }, WAIT).toEqual(['0', AMOUNT.toString(), AMOUNT.toString(), false, 0, { operations: 0, sent: false, finalizations: 0 }]);
}

async function manageDispute(page: Page): Promise<void> {
  await page.getByTestId('account-manage').click();
  await page.getByTestId('manage-tab-dispute').click();
}

async function broadcast(page: Page, operation: string): Promise<void> {
  await page.getByTestId('nav-home').locator('visible=true').first().click();
  await expect(page.getByTestId('pending-batch')).toContainText(operation, WAIT);
  await page.getByTestId('batch-broadcast').click();
  await expect(page.getByTestId('pending-batch')).toHaveCount(0, WAIT);
}

async function finishSubmission(page: Page, hubId: string): Promise<void> {
  await page.getByTestId('nav-home').locator('visible=true').first().click();
  // The canonical deadline scheduler may already have broadcast the UI request.
  // Only a remaining draft needs another user signature; receipt checks stay identical.
  await expect.poll(async () => {
    const s = await readState(page, hubId);
    return s.batch.finalizations > 0 || s.batch.sent || s.dispute === null;
  }, WAIT).toBe(true);
  const state = await readState(page, hubId);
  if (state.batch.finalizations > 0 && !state.batch.sent) await broadcast(page, 'Dispute finalize');
}

// The signed dispute window is waited out by moving a private chain's clock,
// so this needs a stand nobody else shares: its own anvil on a leased local
// port with the wallet served two ports above it. The local production smoke
// wallet gate provides both endpoints and owns the chain for the entire test.
test.skip(
  !process.env['XLN_UI_DISPUTE_PRIVATE_RPC'] || !process.env['XLN_UI_DISPUTE_PRIVATE_ORIGIN'],
  'needs a private dispute stand: XLN_UI_DISPUTE_PRIVATE_RPC and XLN_UI_DISPUTE_PRIVATE_ORIGIN',
);

test('UI dispute prevents early finalization, then releases exactly 100 USDC after its signed window', { tag: '@functional' }, async ({ page, baseURL }, testInfo) => {
  test.setTimeout(60_000);
  const provider = privateChain(baseURL);
  const errors: string[] = [];
  let diagnosticHub: string | undefined;
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') console.log(`DISPUTE_BROWSER_ERROR ${message.text()}`);
  });
  try {
    await page.clock.install();
    const wallet = await enterStack(page);
    await page.getByTestId('account-row').first().click();
    const hubId = new URL(page.url()).pathname.split('/accounts/')[1];
    if (!hubId || !/^0x[0-9a-f]{64}$/.test(hubId)) throw new Error('Dispute hub Account unavailable');
    diagnosticHub = hubId;
    await fundCollateral(page, hubId);
    const funded = await readState(page, hubId);
    const contract = Depository__factory.connect(funded.depository, provider);
    const initialBlock = await provider.getBlockNumber();
    const fundedChain = await chainMoney(contract, wallet.entityId, hubId);
    expect(fundedChain.reserve).toBe('0');
    expect(fundedChain.collateral).toBe(AMOUNT.toString());
    expect(fundedChain.ondelta).toBe(funded.ondelta);
    await page.getByTestId('wallet-tutorial').click();
    await page.getByTestId('tour-chapter').selectOption('dispute');
    await manageDispute(page);
    await page.getByTestId('dispute-prepare').click();
    await page.getByTestId('dispute-prepare-confirm').click();
    await broadcast(page, 'Dispute start');
    await expect.poll(async () => (await readState(page, hubId)).dispute?.observedOnChain, WAIT).toBe(true);
    const started = await readState(page, hubId);
    const active = started.dispute;
    if (!active) throw new Error('Observed dispute disappeared');
    expect(active.startedByLeft).toBe(wallet.entityId < hubId);
    const starts = await contract.queryFilter(contract.filters.DisputeStarted(wallet.entityId, hubId), initialBlock);
    expect(starts).toHaveLength(1);
    const start = starts[0];
    if (!start) throw new Error('DisputeStarted receipt unavailable');
    expect((await start.getTransactionReceipt()).gasUsed).toBeLessThanOrEqual(5_000_000n);
    expect(start.args.proofbodyHash).toBe(active.initialProofbodyHash);
    expect(Number(start.args.nonce)).toBe(active.initialNonce);
    expect(Number(start.args.disputeTimeout)).toBe(active.disputeTimeout);
    // The receipt must use the bilateral windows committed before the dispute.
    const leftWindow = BigInt(funded.disputeConfig.leftResponseSeconds);
    const rightWindow = BigInt(funded.disputeConfig.rightResponseSeconds);
    expect(start.args.leftResponseSeconds).toBe(leftWindow);
    expect(start.args.rightResponseSeconds).toBe(rightWindow);
    expect(start.args.disputeTimeout).toBe(start.args.disputeStartTimestamp + leftWindow + rightWindow);
    expect(active.observedBlockNumber).toBe(start.blockNumber);
    expect((await start.getTransactionReceipt()).status).toBe(1);
    const startedChain = await chainMoney(contract, wallet.entityId, hubId);
    expect(startedChain.disputeHash).not.toBe(ZeroHash);
    expect(startedChain.reserve).toBe(fundedChain.reserve);
    await page.getByTestId('account-row').first().click();
    await expect(page.getByTestId('account-dispute-state')).toContainText('on-chain', WAIT);
    await manageDispute(page);
    await expect(page.getByTestId('dispute-finalize')).toBeDisabled();
    await expect(page.getByTestId('dispute-finalize')).toHaveText('Waiting for challenge window');
    const rejected = await readState(page, hubId);
    expect(rejected.dispute).toEqual(active);
    expect(rejected.batch).toEqual(started.batch);
    expect(rejected.reserve).toBe(started.reserve);
    expect(rejected.accountRoot).toBe(started.accountRoot);
    expect(await chainMoney(contract, wallet.entityId, hubId)).toEqual(startedChain);
    expect(await contract.queryFilter(contract.filters.DisputeFinalized(wallet.entityId, hubId), initialBlock)).toHaveLength(0);
    const rejectedJournal = await readDisputeJournal(page, started.height, hubId);
    expect(rejectedJournal.finalizeInputs).toHaveLength(0);
    expect(rejectedJournal.submissions).toHaveLength(0);
    await testInfo.attach('early-finalize-prevention', { body: safeStringify({ started, rejected, startedChain, acceptedWal: rejectedJournal }), contentType: 'application/json' });
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
    // The real host clock is performance.timeOrigin + performance.now(), not Date.
    // Advancing elapsed time runs the existing deadline hook; its canonical output
    // finalizes the UI-started dispute without another financial input from the test.
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    const deadline = active.disputeTimeout + 1;
    await provider.send('evm_setNextBlockTimestamp', [deadline]);
    await provider.send('evm_mine', []);
    const block = await provider.getBlock('latest');
    if (!block) throw new Error('Private deadline block unavailable');
    expect(block.timestamp).toBeGreaterThan(active.disputeTimeout);
    const beforeClock = await page.evaluate(() => ({ date: Date.now(), host: Math.round(performance.timeOrigin + performance.now()) }));
    let afterClock: typeof beforeClock;
    try {
      await page.clock.fastForward(deadline * 1000 - beforeClock.host);
      afterClock = await page.evaluate(() => ({ date: Date.now(), host: Math.round(performance.timeOrigin + performance.now()) }));
      expect(afterClock.host).toBeGreaterThanOrEqual(deadline * 1000);
    } finally { await page.clock.resume(); }
    await expect.poll(async () => (await readDisputeJournal(page, rejected.height, hubId)).deadlineWakes.filter(wake => wake.timestamp >= deadline * 1000).length, WAIT).toBe(1);
    await finishSubmission(page, hubId);
    await expect.poll(async () => {
      const s = await readState(page, hubId);
      return [s.dispute, s.status, s.reserve, s.collateral, s.offdelta, s.pending, s.mempool, s.batch];
    }, WAIT).toEqual([null, 'disputed', AMOUNT.toString(), '0', '0', false, 0, { operations: 0, sent: false, finalizations: 0 }]);
    const finished = await readState(page, hubId);
    const finalChain = await chainMoney(contract, wallet.entityId, hubId);
    const finalizations = await contract.queryFilter(contract.filters.DisputeFinalized(wallet.entityId, hubId), initialBlock);
    expect(finalizations).toHaveLength(1);
    const finalization = finalizations[0];
    if (!finalization) throw new Error('DisputeFinalized receipt unavailable');
    const receipt = await finalization.getTransactionReceipt();
    expect(receipt.status).toBe(1);
    expect(receipt.gasUsed).toBeLessThanOrEqual(5_000_000n);
    expect(finalization.args.finalProofbodyHash).toBe(active.initialProofbodyHash);
    expect(finalization.args.nonce).toBe(BigInt(active.initialNonce));
    const payout = await contract.queryFilter(contract.filters.ReserveUpdated(wallet.entityId, 1), receipt.blockNumber, receipt.blockNumber);
    expect(payout.filter(event => event.transactionHash === receipt.hash).map(event => event.args.newBalance)).toEqual([AMOUNT]);
    expect(finalChain).toEqual({ ...startedChain, reserve: AMOUNT.toString(), collateral: '0', ondelta: '0', nonce: String(active.initialNonce + 1), disputeHash: ZeroHash, timeout: 0 });
    expect(BigInt(finalChain.reserve) + BigInt(finalChain.peerReserve) + BigInt(finalChain.collateral)).toBe(BigInt(fundedChain.reserve) + BigInt(fundedChain.peerReserve) + BigInt(fundedChain.collateral));
    expect(finished.jNonce).toBe(active.initialNonce + 1);
    const accepted = await readDisputeJournal(page, rejected.height, hubId);
    // The wake executes its approved collective actions in the same signed Entity
    // frame. Its committed batch and actual receipt prove that internal execution.
    expect(accepted.finalizeInputs).toHaveLength(0);
    const wakes = accepted.deadlineWakes.filter(wake => wake.timestamp >= deadline * 1000);
    expect(wakes).toHaveLength(1);
    const wake = wakes[0];
    if (!wake) throw new Error('Finalization wake unavailable');
    const sourceBatch = await page.evaluate(async ({ entityId, height }) => {
      const debug = (window as DebugWindow).__xln;
      const adapter = debug?.adapter();
      if (!adapter) throw new Error('Finalization source reader unavailable');
      const core = await adapter.read<NonNullable<RuntimeAdapterViewFrame['activeEntity']>['core']>(`entity/${entityId}`, { atHeight: height });
      const sent = core.jBatchState?.sentBatch;
      if (!sent) throw new Error(`FINALIZATION_SOURCE_BATCH_MISSING:${height}`);
      return { batchHash: sent.batchHash, entityNonce: sent.entityNonce };
    }, { entityId: wallet.entityId, height: wake.height });
    const submitted = accepted.submissions.filter(item => item.txHash === receipt.hash);
    expect(submitted).toHaveLength(1);
    expect(submitted.map(item => ({ batchHash: item.batchHash, entityNonce: item.entityNonce }))).toEqual([sourceBatch]);
    expect(submitted.every(item => item.timestamp >= deadline * 1000 && item.height >= wake.height)).toBe(true);
    const processed = await contract.queryFilter(contract.filters.HankoBatchProcessed(wallet.entityId, sourceBatch.batchHash), receipt.blockNumber, receipt.blockNumber);
    expect(processed.map(event => ({ txHash: event.transactionHash, nonce: event.args.nonce }))).toEqual([{ txHash: receipt.hash, nonce: BigInt(sourceBatch.entityNonce) }]);
    await expect(page.getByTestId('token-net-USDC')).toHaveText('100.00');
    await page.getByTestId('account-row').first().click();
    await expect(page.getByTestId('account-status')).toHaveText('Closed after dispute');
    await expect(page.getByTestId('account-dispute-state')).toHaveText('Dispute finalized. This account is permanently closed.');
    await expect(page.getByTestId('account-dispute')).toHaveCount(0);
    await manageDispute(page);
    await expect(page.getByTestId('dispute-closed')).toHaveText('Dispute finalized. This account is permanently closed.');
    await expect(page.locator('[data-testid="dispute-prepare"], [data-testid="dispute-prepare-confirm"], [data-testid="dispute-finalize"]')).toHaveCount(0);
    expect(errors, 'no uncaught browser errors').toEqual([]);
    await testInfo.attach('dispute-finality', { body: safeStringify({ mode: 'canonical-auto-after-ui-start-and-early-prevention', beforeClock, afterClock, funded, fundedChain, started, startTx: start.transactionHash, deadlineBlock: { number: block.number, hash: block.hash, timestamp: block.timestamp }, finished, finalChain, finalTx: receipt.hash, sourceBatch, accepted }), contentType: 'application/json' });
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByTestId('nav-home').locator('visible=true').first().click();
    await expect(page.getByTestId('token-net-USDC')).toHaveText('100.00');
    await expect(page.getByTestId('account-row').first()).toContainText('Closed after dispute');
    await expect(page.getByRole('region', { name: 'Test money faucet' })).toContainText('closed after a dispute');
    const externalBefore = await externalUsdc(contract, funded.signerId, provider);
    await page.getByTestId('home-move').click();
    await page.getByTestId('move-from-reserve').click();
    await page.getByTestId('move-to-external').click();
    await page.getByTestId('move-external-recipient').fill(funded.signerId);
    await page.getByTestId('move-amount').fill('100');
    await page.getByTestId('move-now').click();
    await expect.poll(() => externalUsdc(contract, funded.signerId, provider), WAIT).toBe(externalBefore + AMOUNT);
    await expect.poll(() => contract._reserves(wallet.entityId, 1), WAIT).toBe(0n);
    await expect.poll(async () => (await readState(page, hubId)).reserve, WAIT).toBe('0');
    await testInfo.attach('withdrawn-dispute-proceeds', { body: safeStringify({ signerId: funded.signerId, before: externalBefore, after: await externalUsdc(contract, funded.signerId, provider) }), contentType: 'application/json' });
    await page.screenshot({ path: testInfo.outputPath('dispute-paid.png'), fullPage: true, animations: 'disabled' });
  } catch (error) {
    if (diagnosticHub) {
      try {
        const state = await readState(page, diagnosticHub);
        const contract = Depository__factory.connect(state.depository, provider);
        const money = await chainMoney(contract, state.entityId, diagnosticHub);
        const starts = await contract.queryFilter(contract.filters.DisputeStarted(state.entityId, diagnosticHub));
        await testInfo.attach('first-red-state', { body: safeStringify({ state, money, starts, browserErrors: errors }), contentType: 'application/json' });
      } catch (diagnosticError) { throw new AggregateError([error, diagnosticError], 'Dispute failed and first-red snapshot could not be read'); }
    }
    throw error;
  } finally { provider.destroy(); }
});

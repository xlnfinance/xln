import { expect, type Page } from '@playwright/test';
import type { RuntimeAdapterViewFrame, RuntimeReplica, XLNModule } from '../../core/api/public/runtime-module';
import type { RuntimeAdapter } from '../../core/api/runtime-adapter/types';

type DebugWindow = Window & {
  __xln?: {
    adapter: () => RuntimeAdapter | null;
    env: () => RuntimeReplica | null;
    xln: () => Promise<XLNModule>;
    store: { getState: () => { activeEntityId: string | null } };
  };
};
export const AMOUNT = 100_000_000n;
export const WAIT = { timeout: 15_000, intervals: [100, 250, 500] };
export const readState = (page: Page, hubId: string) =>
  page.evaluate(async counterpartyId => {
    const debug = (window as DebugWindow).__xln;
    if (!debug) throw new Error('Wallet diagnostics unavailable');
    const adapter = debug.adapter();
    const entityId = debug.store.getState().activeEntityId;
    if (!adapter || !entityId) throw new Error('Dispute owner unavailable');
    const frame = await adapter.read<RuntimeAdapterViewFrame>('view-frame', { entityId });
    const active = frame.activeEntity;
    if (!active || frame.activeEntityId !== entityId) throw new Error('Dispute Entity unavailable');
    const account = await adapter.read<
      NonNullable<RuntimeAdapterViewFrame['activeEntity']>['accounts']['items'][number]
    >(`entity/${entityId}/account/${counterpartyId}`, { atHeight: frame.height });
    const delta = account.state.deltas.get(1);
    const jurisdiction = active.core.config.jurisdiction;
    if (!delta || !jurisdiction) throw new Error('Dispute USDC/J domain unavailable');
    const xln = await debug.xln();
    const derived = xln.deriveDelta(delta, xln.isLeftEntity(entityId, counterpartyId));
    const batch = active.core.jBatchState;
    return {
      entityId,
      signerId: active.core.signerId,
      height: frame.height,
      timestamp: active.core.timestamp,
      depository: jurisdiction.depositoryAddress,
      lastFinalizedJHeight: active.core.lastFinalizedJHeight,
      disputeConfig: account.state.disputeConfig,
      accountHeight: account.currentHeight,
      accountRoot: account.currentFrame.accountStateRoot,
      status: account.status,
      reserve: (active.core.reserves.get(1) ?? 0n).toString(),
      incomingDebt: (active.core.debtTotals.incoming.get(1) ?? 0n).toString(),
      collateral: delta.collateral.toString(),
      ondelta: delta.ondelta.toString(),
      offdelta: delta.offdelta.toString(),
      ownValue: (derived.outCollateral + derived.outPeerCredit - derived.inOwnCredit).toString(),
      jNonce: account.state.jNonce,
      pending: Boolean(account.pendingFrame),
      mempool: account.mempoolCount,
      dispute: account.activeDispute ?? null,
      sentBatch: batch?.sentBatch
        ? {
            txHash: batch.sentBatch.txHash,
            batchHash: batch.sentBatch.batchHash,
            nonce: batch.sentBatch.entityNonce,
            lastFailure: batch.sentBatch.lastFailure,
            terminalFailure: batch.sentBatch.terminalFailure,
          }
        : null,
      batch: {
        operations: batch
          ? Object.values(batch.batch)
              .filter(Array.isArray)
              .reduce((sum, rows) => sum + rows.length, 0)
          : 0,
        sent: Boolean(batch?.sentBatch),
        finalizations: batch?.batch.disputeFinalizations.length ?? 0,
      },
    };
  }, hubId);

export const readDisputeJournal = (page: Page, afterHeight: number, hubId: string) =>
  page.evaluate(
    async ({ afterHeight, hubId }) => {
      const debug = (window as DebugWindow).__xln;
      if (!debug) throw new Error('Wallet diagnostics unavailable');
      const env = debug.env();
      const entityId = debug.store.getState().activeEntityId;
      if (!env || !entityId) throw new Error('Dispute journal owner unavailable');
      const xln = await debug.xln();
      const latest = await xln.getPersistedLatestHeight(env);
      const finalizeInputs: { height: number; timestamp: number; description: string | undefined }[] = [];
      const deadlineWakes: { height: number; timestamp: number; frameHash: string; dueAt: number }[] = [];
      const submissions: {
        height: number;
        timestamp: number;
        attemptId: string;
        batchHash: string;
        entityNonce: number;
        txHash: string | undefined;
      }[] = [];
      for (let height = afterHeight + 1; height <= latest; height++) {
        // Accepted financial commands belong to canonical WAL, not the Activity log projection.
        const frame = await xln.readPersistedStorageFrameRecord(env, height);
        if (!frame) throw new Error(`DISPUTE_ACCEPTED_WAL_FRAME_MISSING:${height}`);
        for (const tx of frame.runtimeInput.runtimeTxs ?? [])
          if (tx.type === 'recordJSubmitResult' && tx.data.entityId === entityId && tx.data.outcome === 'submitted')
            submissions.push({
              height,
              timestamp: frame.timestamp,
              attemptId: tx.data.attemptId,
              batchHash: tx.data.batchHash,
              entityNonce: tx.data.entityNonce,
              txHash: tx.data.txHash,
            });
        for (const input of frame.runtimeInput.entityInputs)
          if (input.entityId === entityId) {
            for (const tx of input.entityTxs ?? []) {
              if (tx.type === 'disputeFinalize' && tx.data.counterpartyEntityId === hubId)
                finalizeInputs.push({ height, timestamp: frame.timestamp, description: tx.data.description });
              if (
                tx.type === 'scheduledWake' &&
                tx.data.jobs.some(job => job.kind === 'hook' && job.id === `dispute-deadline:${hubId}`)
              ) {
                if (!frame.frameHash) throw new Error(`DISPUTE_WAKE_FRAME_HASH_MISSING:${height}`);
                deadlineWakes.push({
                  height,
                  timestamp: frame.timestamp,
                  frameHash: frame.frameHash,
                  dueAt: tx.data.dueAt,
                });
              }
            }
          }
      }
      return { finalizeInputs, deadlineWakes, submissions };
    },
    { afterHeight, hubId },
  );
export async function faucet(page: Page, kind: 'gas' | 'reserve', amount: string): Promise<void> {
  await page.getByTestId('faucet-amount').fill(amount);
  const response = page.waitForResponse(
    res => new URL(res.url()).pathname === `/api/faucet/${kind}` && res.request().method() === 'POST',
  );
  await page.getByTestId(`faucet-${kind}`).click();
  const result = await response;
  expect(result.ok(), await result.text()).toBe(true);
  await expect(page.getByTestId(`faucet-${kind}`)).toBeEnabled(WAIT);
}

export async function fundCollateral(page: Page, hubId: string): Promise<void> {
  await page.getByTestId('nav-manage').locator('visible=true').first().click();
  await page.getByTestId('manage-assets').click();
  await faucet(page, 'gas', '0.1');
  await faucet(page, 'reserve', '100');
  await expect.poll(async () => (await readState(page, hubId)).reserve, WAIT).toBe(AMOUNT.toString());
  await page.getByTestId('nav-home').locator('visible=true').first().click();
  await page.getByTestId('home-move').click();
  await page.getByTestId('move-from-reserve').click();
  await page.getByTestId('move-to-account').click();
  await page.getByTestId('move-target-hub').selectOption(hubId);
  await page.getByTestId('move-amount').fill('100');
  await page.getByTestId('move-now').click();
  await expect(page.getByTestId('home-total')).toBeVisible(WAIT);
  await expect
    .poll(async () => {
      const s = await readState(page, hubId);
      return [s.reserve, s.collateral, s.ownValue, s.pending, s.mempool, s.batch];
    }, WAIT)
    .toEqual(['0', AMOUNT.toString(), AMOUNT.toString(), false, 0, { operations: 0, sent: false, finalizations: 0 }]);
}

export async function manageDispute(page: Page): Promise<void> {
  await page.getByTestId('account-manage').click();
  await page.getByTestId('manage-tab-dispute').click();
}

export async function broadcast(page: Page, operation: string): Promise<void> {
  await page.getByTestId('nav-home').locator('visible=true').first().click();
  await expect(page.getByTestId('pending-batch')).toContainText(operation, WAIT);
  await page.getByTestId('batch-broadcast').click();
  await expect(page.getByTestId('pending-batch')).toHaveCount(0, WAIT);
}

export async function finishSubmission(page: Page, hubId: string): Promise<void> {
  await page.getByTestId('nav-home').locator('visible=true').first().click();
  // The canonical deadline scheduler may already have broadcast the UI request.
  // Only a remaining draft needs another user signature; receipt checks stay identical.
  await expect
    .poll(async () => {
      const s = await readState(page, hubId);
      return s.batch.finalizations > 0 || s.batch.sent || s.dispute === null;
    }, WAIT)
    .toBe(true);
  const state = await readState(page, hubId);
  if (state.batch.finalizations > 0 && !state.batch.sent) await broadcast(page, 'Dispute finalize');
}

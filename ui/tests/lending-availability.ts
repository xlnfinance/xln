import type { Page, TestInfo, expect as PlaywrightExpect } from '@playwright/test';
type Expect = typeof PlaywrightExpect;
import type { RuntimeAdapterViewFrame, RuntimeReplica, XLNModule } from '../../core/api/public/runtime-module';
import type { RuntimeAdapter } from '../../core/api/runtime-adapter/types';
import type { RuntimeAdapterFrameSummary } from '../../core/api/runtime-adapter/resolve';
import { safeStringify } from '../../core/protocol/serialization';
import { fundFromHubUi } from './fund-from-hub';
import { readCommittedPayment } from './payment-evidence';

type DebugWindow = Window & {
  __xln?: { adapter: () => RuntimeAdapter | null; env: () => RuntimeReplica | null; xln: () => Promise<XLNModule> };
};

/** One current view owns all money and live Account queue observations; no historical mempool inference. */
const readSnapshot = (page: Page, ownerId: string) =>
  page.evaluate(async entityId => {
    const debug = (window as DebugWindow).__xln;
    const adapter = debug?.adapter();
    if (!debug || !adapter) throw new Error('Lending availability diagnostics unavailable');
    const xln = await debug.xln();
    const frame = await adapter.read<RuntimeAdapterViewFrame>('view-frame', { entityId, accountsLimit: 100 });
    const active = frame.activeEntity;
    if (!active || frame.activeEntityId !== entityId || active.accounts.nextCursor !== null)
      throw new Error('Lending availability requires the complete owner Account view');
    const committed = await adapter.read<RuntimeAdapterFrameSummary>(`frame/${frame.height}`);
    const env = debug.env();
    if (!env?.infrastructure) throw new Error('Lending availability live queues unavailable');
    if (
      env.infrastructure.stateMutationInFlight ||
      env.infrastructure.processingPromise ||
      env.state.height !== frame.height
    )
      return { ready: false as const };
    // No await after this guard: the live envelope and committed view belong to one frame.
    const entities = Array.from(env.state.eReplicas.values());
    const liveAccounts = entities.flatMap(replica => Array.from(replica.state.accounts.values()));
    let ownedUsdc = 0n;
    const accounts = active.accounts.items
      .map(account => {
        const peer = account.state.leftEntity === entityId ? account.state.rightEntity : account.state.leftEntity;
        const delta = account.state.deltas.get(1);
        if (!delta) throw new Error('Lending availability USDC lane missing');
        const derived = xln.deriveDelta(delta, xln.isLeftEntity(entityId, peer));
        ownedUsdc += derived.outCollateral + derived.outPeerCredit - derived.inOwnCredit;
        return {
          peer,
          height: account.currentHeight,
          root: account.currentFrame.accountStateRoot,
          pending: Boolean(account.pendingFrame),
          mempool: account.mempoolCount,
          balances: Array.from(account.state.deltas, ([tokenId, leaf]) => ({
            tokenId,
            collateral: leaf.collateral.toString(),
            ondelta: leaf.ondelta.toString(),
            offdelta: leaf.offdelta.toString(),
            leftCreditLimit: leaf.leftCreditLimit.toString(),
            rightCreditLimit: leaf.rightCreditLimit.toString(),
          })).sort((left, right) => left.tokenId - right.tokenId),
        };
      })
      .sort((left, right) => left.peer.localeCompare(right.peer));
    const batch = active.core.jBatchState;
    return {
      ready: true as const,
      runtime: { height: frame.height, root: committed.postStateHash },
      queues: {
        runtimeEntityInputs: env.runtimeMempool.entityInputs.length,
        runtimeTxs: env.runtimeMempool.runtimeTxs.length,
        runtimeJInputs: env.runtimeMempool.jInputs?.length ?? 0,
        pendingOutputs: env.pendingOutputs?.length ?? 0,
        pendingNetworkOutputs: env.pendingNetworkOutputs?.length ?? 0,
        networkInbox: env.networkInbox?.length ?? 0,
        pendingCommittedJOutbox: env.infrastructure.pendingCommittedJOutbox?.length ?? 0,
        entityMempool: entities.reduce((sum, replica) => sum + replica.mempool.length, 0),
        entityCandidates: entities.filter(replica => replica.proposal || replica.lockedFrame || replica.candidate)
          .length,
        accountMempool: liveAccounts.reduce((sum, account) => sum + account.mempool.length, 0),
        pendingAccounts: liveAccounts.filter(account => account.pendingFrame || account.pendingAccountInput).length,
        jDraftOperations: entities.reduce(
          (sum, replica) =>
            sum +
            (replica.state.jBatchState
              ? Object.values(replica.state.jBatchState.batch)
                  .filter(Array.isArray)
                  .reduce((count, rows) => count + rows.length, 0)
              : 0),
          0,
        ),
        jSentBatches: entities.filter(replica => replica.state.jBatchState?.sentBatch).length,
        jRecoveryBatches: entities.reduce(
          (sum, replica) => sum + (replica.state.jBatchState?.recoveryBatches?.length ?? 0),
          0,
        ),
      },
      financial: {
        ownedUsdc: ownedUsdc.toString(),
        reserves: Array.from(active.core.reserves, ([tokenId, amount]) => ({
          tokenId,
          amount: amount.toString(),
        })).sort((left, right) => left.tokenId - right.tokenId),
        accounts,
        batch: {
          draftOperations: batch
            ? Object.values(batch.batch)
                .filter(Array.isArray)
                .reduce((sum, rows) => sum + rows.length, 0)
            : 0,
          sent: Boolean(batch?.sentBatch),
        },
      },
    };
  }, ownerId);

async function readState(page: Page, ownerId: string, expect: Expect) {
  let snapshot = await readSnapshot(page, ownerId);
  await expect
    .poll(
      async () => {
        if (!snapshot.ready) snapshot = await readSnapshot(page, ownerId);
        return snapshot.ready;
      },
      { timeout: 5_000 },
    )
    .toBe(true);
  if (!snapshot.ready) throw new Error('Lending availability could not observe a committed frame');
  return snapshot;
}

export async function verifyLendingEntryAndPayment(
  page: Page,
  info: TestInfo,
  expect: Expect,
  enterWallet: () => Promise<{ entityId: string }>,
): Promise<void> {
  const errors: string[] = [];
  const fatalMessages: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (
      /ACCOUNT_TX_KIND_OUT_OF_PROFILE|ACCOUNT_AUTHORITY_ENTITY_STAGE_APPLY_DISCARD_FAILED|RUNTIME_FATAL/.test(
        message.text(),
      )
    )
      fatalMessages.push(message.text());
  });
  const wallet = await enterWallet();
  await fundFromHubUi(page, expect, '100');
  await expect
    .poll(
      async () => {
        const current = (await readState(page, wallet.entityId, expect)).financial;
        return {
          owned: current.ownedUsdc,
          drained: current.accounts.every(account => !account.pending && account.mempool === 0),
        };
      },
      { timeout: 15_000 },
    )
    .toEqual({ owned: '100000000', drained: true });
  await expect
    .poll(async () =>
      Object.values((await readState(page, wallet.entityId, expect)).queues).every(count => count === 0),
    )
    .toBe(true);
  const before = await readState(page, wallet.entityId, expect);
  expect(before.financial.accounts).not.toHaveLength(0);
  expect(before.financial.batch).toEqual({ draftOperations: 0, sent: false });

  // Current lending is visible; invalid zero amounts must never enqueue financial work.
  await page.getByTestId('nav-manage').locator('visible=true').first().click();
  await expect(page.getByTestId('manage-lend')).toContainText('Lend to a hub pool or borrow');
  await page.getByTestId('manage-lend').click();
  await expect(page.getByTestId('lending-unavailable')).toHaveCount(0);
  await expect(page.getByTestId('lending-state')).toBeVisible();
  for (const side of ['lend', 'borrow']) {
    await expect(page.getByTestId(`lend-side-${side}`)).toHaveCount(1);
    await page.getByTestId(`lend-side-${side}`).click();
    await page.getByTestId('lend-amount').fill('0');
    if (side === 'borrow') await page.getByTestId('lend-rate').fill('100');
    await expect(page.getByTestId('lend-submit')).toBeDisabled();
  }
  // Browsing and invalid amount entry must neither submit nor mutate financial state.
  const offered = await readState(page, wallet.entityId, expect);
  expect(offered.financial).toEqual(before.financial);
  expect(offered.queues).toEqual(before.queues);
  await info.attach('lending-current-controls', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });

  await page.getByTestId('nav-home').locator('visible=true').first().click();
  await expect(page.getByTestId('token-net-USDC')).toHaveText('100.00');
  await page.getByTestId('home-pay').click();
  await page.getByTestId('pay-to').fill('H2');
  await page.getByTestId('pay-amount').fill('25');
  await expect(page.getByTestId('pay-submit')).toBeEnabled();
  const quoteView = page.getByTestId('pay-quote');
  const sender = await quoteView.getAttribute('data-sender-amount');
  const recipient = await quoteView.getAttribute('data-recipient-amount');
  const fee = await quoteView.getAttribute('data-fee-amount');
  if (
    sender === null ||
    recipient === null ||
    fee === null ||
    ![sender, recipient, fee].every(value => /^\d+$/.test(value))
  )
    throw new Error('Displayed payment quote is missing exact atomic amounts');
  const quote = { sender: BigInt(sender), recipient: BigInt(recipient), fee: BigInt(fee) };
  expect(quote.recipient).toBe(25_000_000n);
  expect(quote.sender).toBe(quote.recipient + quote.fee);
  await page.getByTestId('pay-submit').click();
  await page.getByTestId('receipt-open').click();
  const receipt = page.getByTestId('payment-receipt');
  await expect(receipt).toBeVisible({ timeout: 15_000 });
  await expect(receipt.getByTestId('receipt-kicker')).toHaveText('Paid');
  await expect(receipt.getByTestId('receipt-amount')).toContainText('25.00');
  await expect(receipt.getByTestId('receipt-title')).toContainText('H2');
  await receipt.getByTestId('receipt-done').click();
  const committed = await readCommittedPayment(page, wallet.entityId, before.runtime.height + 1);
  expect(BigInt(committed.amount)).toBe(quote.recipient);
  expect(BigInt(committed.senderAmount)).toBe(BigInt(committed.amount) + BigInt(committed.fee));
  expect(BigInt(committed.senderAmount)).toBeLessThanOrEqual(quote.sender);
  const expectedPaid = (BigInt(offered.financial.ownedUsdc) - BigInt(committed.senderAmount)).toString();
  await expect
    .poll(
      async () => {
        const current = (await readState(page, wallet.entityId, expect)).financial;
        return {
          owned: current.ownedUsdc,
          drained: current.accounts.every(account => !account.pending && account.mempool === 0),
        };
      },
      { timeout: 15_000 },
    )
    .toEqual({ owned: expectedPaid, drained: true });
  await expect
    .poll(async () =>
      Object.values((await readState(page, wallet.entityId, expect)).queues).every(count => count === 0),
    )
    .toBe(true);
  const paid = await readState(page, wallet.entityId, expect);
  expect(BigInt(offered.financial.ownedUsdc) - BigInt(paid.financial.ownedUsdc)).toBe(
    BigInt(committed.amount) + BigInt(committed.fee),
  );
  expect(paid.financial.reserves).toEqual(before.financial.reserves);
  expect(paid.financial.batch).toEqual({ draftOperations: 0, sent: false });
  expect(paid.financial.accounts.map(account => account.root)).not.toEqual(
    before.financial.accounts.map(account => account.root),
  );
  expect(paid.runtime.height).toBeGreaterThan(before.runtime.height);
  expect(paid.runtime.root).not.toBe(before.runtime.root);
  expect(errors).toEqual([]);
  expect(fatalMessages).toEqual([]);
  await info.attach('lending-deferred-real-account-and-payment', {
    body: safeStringify({ before, offered, quoteCeiling: quote, committed, paid }, 2),
    contentType: 'application/json',
  });
}

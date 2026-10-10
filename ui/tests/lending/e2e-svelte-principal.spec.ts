import { expect, test, type Page } from '@playwright/test';
import type { RuntimeReplica } from '../../../core/runtime/types';
import { deriveDelta } from '../../../core/account/utils';
import { safeStringify } from '../../../core/protocol/serialization';

async function signedAccount(page: Page) {
  const owner = await page.getByTestId('context-current').getAttribute('data-entity-id');
  if (!owner) throw new Error('SVELTE_ENTITY_MISSING');
  const evidence = await page.evaluate(entityId => {
    const runtime = (window as Window & { __xln?: { liveRuntimeSnapshot: RuntimeReplica } }).__xln?.liveRuntimeSnapshot;
    const entity = runtime && [...runtime.state.eReplicas.values()].find(replica => replica.state.entityId === entityId);
    const account = entity && [...entity.state.accounts.values()][0];
    const delta = account?.state.deltas.get(1);
    if (!account || !delta) throw new Error('SVELTE_ACCOUNT_MISSING');
    return { delta, isLeft: account.state.leftEntity === entityId, root: account.currentFrame.accountStateRoot };
  }, owner);
  const balance = deriveDelta(evidence.delta, evidence.isLeft);
  return { owned: balance.outCollateral + balance.outPeerCredit - balance.inOwnCredit, credit: balance.ownCreditLimit, root: evidence.root };
}

test('Svelte funds, receives principal, repays and withdraws through real wallet controls', { tag: '@functional' }, async ({ browser }) => {
  test.setTimeout(60_000);
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(process.env['SVELTE_E2E_BASE_URL'] ?? 'http://localhost:8081/app');
    await page.locator('#name').fill(`e2e-term-${crypto.randomUUID()}`);
    await page.getByLabel('Secret passphrase', { exact: true }).fill('Disposable local E2E wallet 2026!');
    await page.getByRole('button', { name: 'Derive wallet', exact: true }).click();
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await page.getByRole('button', { name: 'Accounts', exact: true }).click();
    await page.getByRole('button', { name: 'Faucet', exact: true }).first().click();
    await expect.poll(async () => (await signedAccount(page)).owned).toBe(100_000_000n);
    const before = await signedAccount(page);
    await page.getByTestId('wallet-tutorial').click();
    await page.getByTestId('tour-chapter').selectOption('lending');
    const offer = page.getByTestId('lending-offer-form');
    await offer.locator('input[placeholder="Amount"]').fill('5');
    await page.getByTestId('lending-offer-term').selectOption('1m');
    await page.getByTestId('lending-offer-rate').fill('100');
    await page.getByTestId('lending-offer-submit').click();
    await expect.poll(async () => (await signedAccount(page)).owned).toBe(95_000_000n);
    await expect(page.getByTestId('home-total')).toContainText('100.00');
    await page.getByTestId('tour-chapter').selectOption('borrow');
    await page.getByTestId('lending-borrow-form').locator('input[placeholder="Amount"]').fill('2');
    await page.getByTestId('lending-borrow-term').selectOption('1m');
    await page.getByTestId('lending-borrow-max-rate').fill('100');
    await expect(page.getByTestId('lending-borrow-preview')).toContainText('Maximum repayment: 2.02 USDC, due 30 days after approval.');
    await page.getByTestId('lending-borrow-submit').click();
    await expect.poll(async () => (await signedAccount(page)).owned).toBe(97_000_000n);
    const disbursed = await signedAccount(page);
    expect(disbursed.credit).toBe(before.credit);
    await expect(page.getByTestId('home-total')).toContainText('99.98');
    await expect(page.getByTestId('lending-loan-row')).toContainText('2.02 USDC');
    await page.getByTestId('tour-chapter').selectOption('repay');
    await page.getByTestId('lending-repay-submit').click();
    await expect.poll(async () => (await signedAccount(page)).owned).toBe(94_980_000n);
    await expect(page.getByTestId('lending-close')).toBeEnabled();
    await page.getByTestId('lending-close').click();
    await expect.poll(async () => (await signedAccount(page)).owned).toBe(100_000_000n);
    await expect(page.getByTestId('home-total')).toContainText('100.00');
    const after = await signedAccount(page);
    expect(after.credit).toBe(before.credit);
    await test.info().attach('svelte-lending-money', { body: safeStringify({ before, disbursed, after }), contentType: 'application/json' });
    await page.screenshot({ path: test.info().outputPath('svelte-lending-settled.png'), fullPage: true });
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

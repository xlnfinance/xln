import { expect, test, type Page } from '@playwright/test';
import { enterStack } from './stack';
import { readUsdcAccount } from './payment-evidence';
import type { RuntimeReplica } from '../../core/runtime/types';
import { deriveDelta } from '../../core/account/utils';

const svelte = process.env['XLN_LOCAL_PROD_SMOKE_WALLET_UI'] === 'svelte';
async function createWallet(page: Page) {
  if (!svelte) return (await enterStack(page)).entityId;
  await page.goto('/app');
  await page.locator('#name').fill(`notice-${crypto.randomUUID()}`);
  await page.getByLabel('Secret passphrase', { exact: true }).fill('Disposable notification E2E 2026!');
  await page.getByRole('button', { name: 'Derive wallet', exact: true }).click();
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await page.getByRole('button', { name: 'Accounts', exact: true }).click();
  const entityId = await page.getByTestId('context-current').getAttribute('data-entity-id');
  if (!entityId) throw new Error('NOTIFICATION_OWNER_MISSING');
  return entityId;
}
async function balance(page: Page, entityId: string) {
  if (!svelte) return (await readUsdcAccount(page, entityId)).owned;
  const money = await page.evaluate(owner => {
    const runtime = (window as Window & { __xln?: { liveRuntimeSnapshot: RuntimeReplica } }).__xln?.liveRuntimeSnapshot;
    const entity = runtime && [...runtime.state.eReplicas.values()].find(replica => replica.state.entityId === owner);
    const account = entity && [...entity.state.accounts.values()][0];
    const delta = account?.state.deltas.get(1);
    if (!account || !delta) throw new Error('NOTIFICATION_ACCOUNT_MISSING');
    return { delta, isLeft: account.state.leftEntity === owner };
  }, entityId);
  const d = deriveDelta(money.delta, money.isLeft);
  return (d.outCollateral + d.outPeerCredit - d.inOwnCredit).toString();
}
async function openPay(page: Page) {
  if (svelte) await page.getByTestId('account-workspace-tab-send').click();
  else await page.getByTestId('home-pay').click();
}
const amountInput = (page: Page) => page.getByTestId(svelte ? 'payment-amount-input' : 'pay-amount');

for (const width of [1280, 390]) test(`${svelte ? 'Svelte' : 'React'} payment notifications preserve a draft and focus at ${width}px`, { tag: '@functional' }, async ({ browser, baseURL }, info) => {
  test.setTimeout(60_000);
  const contexts = await Promise.all([0, 1].map(() => browser.newContext({ baseURL, viewport: { width, height: 860 } })));
  const sender = await contexts[0]!.newPage();
  const recipient = await contexts[1]!.newPage();
  const errors: string[] = [];
  for (const page of [sender, recipient]) page.on('pageerror', error => errors.push(error.message));
  try {
    const senderId = await createWallet(sender);
    const recipientId = await createWallet(recipient);
    if (svelte) await sender.getByRole('button', { name: 'Faucet', exact: true }).first().click();
    else await sender.getByTestId('home-faucet').click();
    await expect.poll(() => balance(sender, senderId)).toBe('100000000');
    await openPay(recipient);
    await amountInput(recipient).fill('7.25');
    await amountInput(recipient).focus();
    await openPay(sender);
    if (svelte) {
      await sender.locator('#payment-invoice-input').fill(recipientId);
      await amountInput(sender).fill('1');
      await sender.getByRole('button', { name: /^Find routes?$/i }).click();
      await sender.getByRole('button', { name: /Pay now/i }).click();
    } else {
      await sender.getByTestId('pay-to').fill(recipientId);
      await amountInput(sender).fill('1');
      await sender.getByTestId('pay-submit').click();
    }
    await expect(recipient.getByTestId('payment-notification')).toContainText('Received', { timeout: 15_000 });
    await expect(recipient.getByTestId('payment-notification')).toContainText('1');
    await expect.poll(() => balance(recipient, recipientId)).toBe('1000000');
    await expect(recipient.getByTestId('payment-receipt')).toHaveCount(0);
    await expect(sender.getByTestId('payment-receipt')).toHaveCount(0);
    await expect(amountInput(recipient)).toHaveValue('7.25');
    await expect(amountInput(recipient)).toBeFocused();
    await amountInput(recipient).press('End');
    await amountInput(recipient).pressSequentially('1');
    await expect(amountInput(recipient)).toHaveValue('7.251');
    expect(await recipient.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await recipient.screenshot({ path: info.outputPath('notification-keeps-draft.png'), fullPage: true });
    await recipient.getByTestId('receipt-open').click();
    await expect(recipient.getByTestId('payment-receipt')).toBeVisible();
    await expect(recipient.locator(svelte ? '.receipt-kicker' : '[data-testid="receipt-kicker"]')).toContainText('Received');
    await recipient.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(amountInput(recipient)).toHaveValue('7.251');
    expect(errors).toEqual([]);
  } finally { for (const context of contexts) await context.close(); }
});

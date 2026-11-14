# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: lending/e2e-svelte-current-lending.spec.ts >> Svelte signed savings and loan preserve exact money without leaving /app
- Location: ui/tests/lending/e2e-svelte-current-lending.spec.ts:23:0

# Error details

```
Test timeout of 240000ms exceeded.
```

```
Error: click: Test timeout of 240000ms exceeded.
Call log:
  - waiting for getByRole('button', { name: 'Faucet', exact: true }).first()

```

# Page snapshot

```yaml
- main [ref=e5]:
  - complementary "Active jurisdiction" [ref=e6]:
    - generic [ref=e7]:
      - generic [ref=e8]:
        - text: Jurisdiction ·
        - strong [ref=e9]: Testnet
      - generic [ref=e10]: Chain 31337
      - button "Tutorial · all features" [ref=e11] [cursor=pointer]
    - group [ref=e12]:
      - generic "Contract stack" [ref=e13] [cursor=pointer]
  - generic [ref=e14]:
    - generic [ref=e16]:
      - button "Test wallet" [ref=e20] [cursor=pointer]:
        - generic [ref=e21]:
          - generic "Testnet" [ref=e23]: L
          - generic [ref=e24]:
            - generic [ref=e25]: Test wallet
            - generic [ref=e26]: Test wallet · Testnet
          - generic [aria-hidden] [ref=e27]: ›
        - generic [aria-hidden] [ref=e28]: Test wallet
      - generic [ref=e29]:
        - paragraph [ref=e30]: Entity
        - button "0x3eaca2baefd58f265dcb13cb1c6067e5a1018c396879c1f74a6c1f2bcad95201" [ref=e31] [cursor=pointer]
    - generic [ref=e34]:
      - generic [ref=e35]: $0.00
      - 'generic "Total balance includes external funds, reserves, signed account balances and hub-reported lending deposits. Frozen funds remain yours; drawn account debt is deducted. Example: 80 USDC in your account + 20 in lending = 100 total. Available to pay excludes lending deposits and includes unused credit; a 50 USDC credit limit does not make you 50 USDC richer. Unpaid term loans, including agreed interest, are also deducted; their schedules are shown in Lending. USD values use reference prices, not executable swap quotes." [ref=e36]': Total balance
      - generic [ref=e37]: "Available to pay: $0.00 · includes credit"
      - group [ref=e38]:
        - generic "Balance explained" [ref=e39]
  - navigation [ref=e40]:
    - button "Assets" [ref=e41] [cursor=pointer]
    - button "Accounts" [active] [ref=e44] [cursor=pointer]
    - button "Ownership" [ref=e47] [cursor=pointer]
    - button "Settings" [ref=e50] [cursor=pointer]
  - generic [ref=e53]:
    - generic [ref=e56]:
      - paragraph [ref=e57]: No accounts established
      - generic [ref=e58]: Select an entity below to open an account
    - generic [ref=e59]:
      - navigation "Account workspace" [ref=e60]:
        - button "Open Account" [ref=e61] [cursor=pointer]
        - button "Pay" [ref=e64] [cursor=pointer]
        - button "Receive" [ref=e67] [cursor=pointer]
        - button "Swap" [ref=e70] [cursor=pointer]
        - button "Move" [ref=e73] [cursor=pointer]
        - button "Lending" [ref=e76] [cursor=pointer]
        - button "History" [ref=e79] [cursor=pointer]
        - button "Manage" [ref=e82] [cursor=pointer]
        - button "Activity" [ref=e85] [cursor=pointer]
        - button "Appearance" [ref=e88] [cursor=pointer]
      - group [ref=e91]:
        - generic "How this works" [ref=e92] [cursor=pointer]
    - generic [ref=e94]:
      - generic [ref=e95]:
        - generic [ref=e97]:
          - generic [ref=e98]: Network
          - heading "Open Account" [level=4] [ref=e99]
        - generic [ref=e100]:
          - generic [ref=e101]: Counterparties
          - generic [ref=e104]:
            - article [ref=e105]:
              - generic [ref=e107]:
                - button "H1" [ref=e108] [cursor=pointer]
                - generic [ref=e111]:
                  - button "Connect" [ref=e112] [cursor=pointer]
                  - button "Details" [ref=e114] [cursor=pointer]
            - article [ref=e117]:
              - generic [ref=e119]:
                - button "H2" [ref=e120] [cursor=pointer]
                - generic [ref=e123]:
                  - button "Connect" [ref=e124] [cursor=pointer]
                  - button "Details" [ref=e126] [cursor=pointer]
            - article [ref=e129]:
              - generic [ref=e131]:
                - button "H3" [ref=e132] [cursor=pointer]
                - generic [ref=e135]:
                  - button "Connect" [ref=e136] [cursor=pointer]
                  - button "Details" [ref=e138] [cursor=pointer]
      - generic [ref=e141]:
        - generic [ref=e143]:
          - generic [ref=e144]: Direct
          - heading "Open by ID" [level=4] [ref=e145]
        - generic [ref=e146]:
          - generic [ref=e147]:
            - generic [ref=e148]: Recipient
            - generic [ref=e149]:
              - textbox "Recipient" [ref=e150]:
                - /placeholder: Select or paste entity ID
              - button "Open Recipient picker" [ref=e151] [cursor=pointer]
          - button "Open" [disabled] [ref=e154]
```

# Test source

```ts
  1  | import { expect, test, type Page } from '@playwright/test';
  2  | import type { RuntimeReplica } from '../../../core/runtime/types';
  3  | import { deriveDelta } from '../../../core/account/utils';
  4  | import { setBankPolicy } from './bank-policy';
  5  | 
  6  | async function accountMoney(page: Page) {
  7  |   const owner = await page.getByTestId('context-current').getAttribute('data-entity-id');
  8  |   if (!owner) throw new Error('SVELTE_OWNER_MISSING');
  9  |   const data = await page.evaluate(entityId => {
  10 |     const env = (window as Window & { __xln: { liveRuntimeSnapshot: RuntimeReplica } }).__xln.liveRuntimeSnapshot;
  11 |     const entity = [...env.state.eReplicas.values()].find(item => item.entityId === entityId);
  12 |     const entry = entity && [...entity.state.accounts.entries()][0];
  13 |     if (!entry) throw new Error('SVELTE_ACCOUNT_MISSING');
  14 |     const [hubId, account] = entry;
  15 |     const delta = account.state.deltas.get(1);
  16 |     if (!delta) throw new Error('SVELTE_USDC_MISSING');
  17 |     return { ownerId: entityId, hubId, tokenId: 1, delta, isLeft: account.state.leftEntity === entityId, pending: Boolean(account.pendingFrame) };
  18 |   }, owner);
  19 |   const balance = deriveDelta(data.delta, data.isLeft);
  20 |   return { ...data, owned: balance.outCollateral + balance.outPeerCredit - balance.inOwnCredit };
  21 | }
  22 | 
  23 | test('Svelte signed savings and loan preserve exact money without leaving /app', { tag: '@functional' }, async ({ page }) => {
  24 |   const errors: string[] = [];
  25 |   page.on('pageerror', error => errors.push(error.message));
  26 |   await page.goto('/app');
  27 |   await page.getByRole('button', { name: 'Open test wallet', exact: true }).click();
  28 |   await expect(page.getByTestId('context-current')).toBeVisible();
  29 |   await page.getByRole('button', { name: 'Accounts', exact: true }).click();
> 30 |   await page.getByTestId('hub-discovery-card').filter({ hasText: 'H1' }).getByTestId('hub-connect-button').click();
     |                                                                          ^ Error: click: Test timeout of 240000ms exceeded.
  31 |   await expect(page.getByTestId('account-preview').first()).toBeVisible();
  32 |   await page.getByRole('button', { name: 'Faucet', exact: true }).first().click();
  33 |   await expect.poll(async () => (await accountMoney(page)).owned).toBe(100_000_000n);
  34 |   const ids = await accountMoney(page);
  35 |   await setBankPolicy(page, ids, { termId: '1d', savingsInterestBps: 100, loanInterestBps: 100, maxPrincipal: 2_000_000n });
  36 |   await page.getByRole('button', { name: 'Lending', exact: true }).click();
  37 |   const panel = page.getByTestId('lending-panel');
  38 |   await panel.getByLabel('Term', { exact: true }).selectOption('1d');
  39 |   await panel.getByLabel('Amount', { exact: true }).fill('5');
  40 |   await expect(panel.getByRole('button', { name: 'Authorize this maximum risk', exact: true })).toBeVisible();
  41 |   await panel.getByRole('button', { name: 'Authorize this maximum risk', exact: true }).click();
  42 |   await expect(page.getByTestId('lending-offer-submit')).toBeEnabled();
  43 |   await page.getByTestId('lending-offer-submit').click();
  44 |   await expect.poll(async () => (await accountMoney(page)).owned).toBe(95_000_000n);
  45 |   await expect(panel.getByText(/5 USDC · open/)).toBeVisible();
  46 |   await panel.getByLabel('Action', { exact: true }).selectOption('borrow');
  47 |   await panel.getByLabel('Amount', { exact: true }).fill('2');
  48 |   await panel.getByLabel('Maximum rate (basis points)', { exact: true }).fill('100');
  49 |   await expect(panel.getByRole('button', { name: /^Accept as credit:/ })).toBeVisible();
  50 |   await panel.getByRole('button', { name: /^Accept as credit:/ }).click();
  51 |   await expect(page.getByTestId('lending-borrow-submit')).toBeEnabled();
  52 |   await page.getByTestId('lending-borrow-submit').click();
  53 |   await expect.poll(async () => (await accountMoney(page)).owned).toBe(97_000_000n);
  54 |   await expect(page.getByTestId('lending-repay-submit')).toBeEnabled();
  55 |   await page.getByTestId('lending-repay-submit').click();
  56 |   await expect(page.getByTestId('lending-loan-row')).toContainText('repaid');
  57 |   const repaid = await accountMoney(page);
  58 |   const response = await page.request.get('/api/lending/state', { params: { hubEntityId: ids.hubId, userEntityId: ids.ownerId, tokenId: '1' } });
  59 |   expect(response.ok()).toBe(true);
  60 |   const state = await response.json();
  61 |   expect(state.loans).toHaveLength(1);
  62 |   expect(state.loans[0].repaidAmount).toMatch(/^[0-9]+$/);
  63 |   expect(repaid.owned).toBe(97_000_000n - BigInt(state.loans[0].repaidAmount));
  64 |   await expect(page).toHaveURL(/\/app#accounts\/lending$/);
  65 |   expect(errors).toEqual([]);
  66 | });
  67 | 
```
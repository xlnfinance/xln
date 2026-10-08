import { expect, type Page } from '@playwright/test';
import { HDNodeWallet } from 'ethers';
import { attachRustH1 } from '../../core/scripts/operations/hlt/rust/rust-h1';
import { LOCAL_TEST_STACK_BASES } from '../../core/scripts/e2e/harness/local-test-port-lease';
import type { RuntimeAdapterViewFrame } from '../../core/api/public/runtime-module';
import type { StorageHead } from '../../core/storage/types';
import type { RuntimeAdapter } from '../../core/api/runtime-adapter/types';
import type { RuntimeAdapterFrameSummary } from '../../core/api/runtime-adapter/resolve';

export const BOOT_TIMEOUT = 180_000;
export const LOCAL_PASSWORD = 'e2e-local-wallet-password';

type DebugWindow = Window & {
  __xln?: {
    adapter: () => RuntimeAdapter | null;
    store: { getState: () => { activeEntityId: string | null; activeVaultId: string | null } };
  };
};

export type StackWallet = Readonly<{ phrase: string; runtimeId: string; entityId: string; vaultId: string }>;

/** A Rust-selected browser gate must trade with the actual native H1, never a healthy TS fallback. */
export async function assertSelectedNativeHub(hubId: string): Promise<void> {
  if (process.env['XLN_HLT_ENGINE'] !== 'rust') return;
  const privateRpc = process.env['XLN_UI_DISPUTE_PRIVATE_RPC'];
  if (!privateRpc) throw new Error('NATIVE_UI_GATE_PRIVATE_STACK_MISSING');
  const url = new URL(privateRpc);
  const portBase = Number(url.port);
  if (url.hostname !== '127.0.0.1' || !LOCAL_TEST_STACK_BASES.some(base => base === portBase)) throw new Error('NATIVE_UI_GATE_PRIVATE_STACK_INVALID');
  // Attest the engine through its canonical supervised API, independently
  // of the runtime-import manifest used to connect the wallet.
  const native = await attachRustH1(`http://127.0.0.1:${portBase + 10}`);
  try {
    expect(hubId.toLowerCase(), 'Selected browser Account must belong to native H1').toBe(native.ready.entityId);
    console.log(`NATIVE_UI_GATE_SOURCE engine=rust label=H1 entityId=${hubId} runtimeId=${native.ready.runtimeId} workers=${native.ready.workers}`);
  } finally {
    await native.stop();
  }
}

/** Import through the public wallet UI, including production builds without diagnostics. */
export async function importStackPhraseUi(page: Page, phrase: string): Promise<void> {
  await expect(page.getByTestId('gate-stack')).toHaveAttribute('data-state', 'online', { timeout: 20_000 });
  await page.getByRole('button', { name: /Restore a wallet/ }).click();
  await page.locator('textarea').fill(phrase);
  await page.locator('button[type="submit"]').click();
  await expect(page.getByRole('heading', { name: 'Set a local password' })).toBeVisible({ timeout: BOOT_TIMEOUT });
  await page.getByLabel('Password', { exact: true }).fill(LOCAL_PASSWORD);
  await page.getByLabel('Confirm password', { exact: true }).fill(LOCAL_PASSWORD);
  await page.getByRole('button', { name: 'Save and open', exact: true }).click();
  // Surface the first recovery invariant immediately instead of timing out on Home.
  await expect(page.locator('[data-testid="nav-home"]:visible, .gate-error').first()).toBeVisible({ timeout: BOOT_TIMEOUT });
  const errors = await page.locator('.gate-error').allTextContents();
  if (errors.length > 0) throw new Error(`WALLET_BOOT_FAILED:${errors.join('\n')}`);
}

async function importStackPhrase(page: Page, phrase: string): Promise<Omit<StackWallet, 'phrase'>> {
  await importStackPhraseUi(page, phrase);
  return readWalletIdentity(page);
}

async function readWalletIdentity(page: Page): Promise<Omit<StackWallet, 'phrase'>> {
  return page.evaluate(() => {
    const debug = (window as DebugWindow).__xln;
    if (!debug) throw new Error('Wallet diagnostics unavailable');
    const adapter = debug.adapter();
    const { activeEntityId: entityId, activeVaultId: vaultId } = debug.store.getState();
    if (!adapter || !entityId || !vaultId) throw new Error('Wallet identity unavailable');
    return { runtimeId: adapter.runtimeId, entityId, vaultId };
  });
}

/** Enter the wallet on the running stack with a fresh phrase; the account with the stack hub must exist on our side. */
export async function enterStack(page: Page, providedPhrase?: string): Promise<StackWallet> {
  await page.goto('/');
  const phrase = providedPhrase ?? HDNodeWallet.createRandom().mnemonic?.phrase;
  if (!phrase) throw new Error('TEST_WALLET_MNEMONIC_MISSING');
  const identity = await importStackPhrase(page, phrase);
  await expect(page.getByTestId('account-row').first()).toBeVisible({ timeout: 90_000 });
  if (process.env['XLN_HLT_ENGINE'] === 'rust') {
    const checkpoint = await readWalletCheckpoint(page);
    expect(checkpoint.accounts, 'Fresh wallet must select exactly one native H1 Account').toHaveLength(1);
    const account = checkpoint.accounts[0]!;
    const hubId = account.leftEntity === identity.entityId ? account.rightEntity : account.leftEntity;
    await assertSelectedNativeHub(hubId);
  }
  return { phrase, ...identity };
}

/** Unlock the same durable wallet after reload; never generate a replacement phrase or clear storage. */
export async function reopenStack(page: Page, wallet: StackWallet): Promise<void> {
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Password', { exact: true }).fill(LOCAL_PASSWORD);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await page.getByTestId('nav-home').locator('visible=true').first().click();
  await expect(page.getByTestId('home-total')).toBeVisible({ timeout: BOOT_TIMEOUT });
  const identity = await readWalletIdentity(page);
  expect(identity.runtimeId).toBe(wallet.runtimeId);
  expect(identity.entityId).toBe(wallet.entityId);
  expect(identity.vaultId).toBe(wallet.vaultId);
  await page.getByTestId('nav-home').locator('visible=true').first().click();
  await expect(page.getByTestId('home-total')).toBeVisible();
}

/** Read committed heads and exact integer balances through the wallet's existing adapter. */
export async function readWalletCheckpoint(page: Page, atHeight?: number) {
  return page.evaluate(async requestedHeight => {
    const debug = (window as DebugWindow).__xln;
    if (!debug) throw new Error('Wallet diagnostics unavailable');
    const adapter = debug.adapter();
    const { activeEntityId: entityId, activeVaultId: vaultId } = debug.store.getState();
    if (!adapter || !entityId || !vaultId) throw new Error('Wallet identity unavailable');
    // Capture current Accounts and their Runtime height together. Reading HEAD
    // first races live commits and accidentally turns a current read into replay.
    const current = requestedHeight === undefined
      ? await adapter.read<RuntimeAdapterViewFrame>('view-frame', { entityId, accountsLimit: 100 })
      : null;
    const latestHeight = current?.height ?? (await adapter.read<StorageHead>('head')).latestHeight;
    const height = requestedHeight ?? latestHeight;
    const frame = await adapter.read<RuntimeAdapterFrameSummary>(`frame/${height}`);
    const accounts = current?.activeEntity?.accounts ?? await adapter.read<{ items: NonNullable<RuntimeAdapterViewFrame['activeEntity']>['accounts']['items']; nextCursor: string | null }>(
      `entity/${entityId}/accounts`,
      { atHeight: height, accountsLimit: 100 },
    );
    if (accounts.nextCursor !== null) throw new Error('Recovery fixture exceeds one Account page');
    return {
      runtimeId: adapter.runtimeId,
      entityId,
      vaultId,
      latestHeight,
      frame: { height: frame.height, frameHash: frame.frameHash, postStateHash: frame.postStateHash },
      accounts: accounts.items
        .map(account => ({
          leftEntity: account.state.leftEntity,
          rightEntity: account.state.rightEntity,
          height: account.currentHeight,
          root: account.currentFrame.accountStateRoot,
          pending: Boolean(account.pendingFrame),
          mempool: account.mempoolCount,
          balances: Array.from(account.state.deltas, ([tokenId, delta]) => ({
            tokenId,
            collateral: delta.collateral.toString(),
            ondelta: delta.ondelta.toString(),
            offdelta: delta.offdelta.toString(),
            leftCreditLimit: delta.leftCreditLimit.toString(),
            rightCreditLimit: delta.rightCreditLimit.toString(),
          })).sort((left, right) => left.tokenId - right.tokenId),
        }))
        .sort((left, right) =>
          `${left.leftEntity}/${left.rightEntity}`.localeCompare(`${right.leftEntity}/${right.rightEntity}`),
        ),
    };
  }, atHeight);
}

/** Ask the stack hub to pay `amount` USDC over credit (the network faucet); Home then shows the USDC lane. */
export async function fundFromHub(page: Page, amount = '100'): Promise<void> {
  await page.getByTestId('nav-manage').locator('visible=true').first().click();
  await page.getByTestId('manage-assets').click();
  await page.getByTestId('faucet-amount').fill(amount);
  const spectrum = page.getByTestId('receive-spectrum');
  if (await spectrum.isVisible()) {
    await page.getByRole('button', { name: '0% collateral', exact: true }).click();
    await page.getByTestId('receive-spectrum-confirm').click();
    await expect(spectrum).toHaveCount(0, { timeout: 15_000 });
  }
  await expect(page.getByTestId('faucet-offchain')).toBeEnabled();
  await page.getByTestId('faucet-offchain').click();
  await page.getByTestId('nav-home').locator('visible=true').first().click();
  await expect(page.getByTestId('token-net-USDC')).toBeVisible({ timeout: 90_000 });
}

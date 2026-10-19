import { expect, test as base, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { ZeroHash } from 'ethers';
import { Depository__factory } from '../../jurisdictions/typechain-types/factories/Depository.sol/Depository__factory';
import { enterStack, LOCAL_PASSWORD, readWalletCheckpoint, reopenStack, type StackWallet } from './stack';
import { AMOUNT, WAIT, broadcast, finishSubmission, fundCollateral, manageDispute, readState } from './dispute-wallet';
import { chainMoney, privateChain } from './dispute-chain';

type FundedBackup = {
  restored: Page;
  wallet: StackWallet;
  hubId: string;
  path: string;
  contents: string;
  funded: Awaited<ReturnType<typeof readState>>;
  before: Awaited<ReturnType<typeof readWalletCheckpoint>>;
  provider: ReturnType<typeof privateChain>;
};

// Each test exports its own funded wallet and stops its original Runtime.
// Integrity/overwrite and financial exit are separate real recovery paths;
// neither shares a live wallet or relaxes the 60-second per-test budget.
const test = base.extend<{ fundedBackup: FundedBackup }>({
  fundedBackup: async ({ browser, baseURL }, use, info) => {
    const provider = privateChain(baseURL);
    const source = await browser.newContext();
    const target = await browser.newContext();
    try {
      const page = await source.newPage();
      const wallet = await enterStack(page);
      await page.getByTestId('account-row').first().click();
      const hubId = new URL(page.url()).pathname.split('/accounts/')[1];
      if (!hubId) throw new Error('Funded Account unavailable');
      await fundCollateral(page, hubId);
      const funded = await readState(page, hubId);
      await page.getByTestId('home-sovereignty').click();
      const downloadPromise = page.waitForEvent('download');
      await page.getByTestId('evidence-export').click();
      const download = await downloadPromise;
      const path = info.outputPath('encrypted-recovery.json');
      await download.saveAs(path);
      const contents = await readFile(path, 'utf8');
      expect(contents).not.toContain(wallet.phrase);
      const exported = JSON.parse(contents);
      expect(typeof exported.bundle.ciphertext).toBe('string');
      expect(exported.bundle.runtimeId).toBe(wallet.runtimeId);
      expect(Number.isSafeInteger(exported.bundle.height)).toBe(true);
      // Compare the export's exact committed barrier, not an earlier UI frame.
      const before = await readWalletCheckpoint(page, exported.bundle.height);
      await source.close();
      const restored = await target.newPage();
      await restored.clock.install();
      await restored.goto('/');
      await use({ restored, wallet, hubId, path, contents, funded, before, provider });
    } finally {
      await source.close();
      await target.close();
      provider.destroy();
    }
  },
});

test.describe.configure({ timeout: 60_000 });

async function chooseFile(restored: Page, wallet: StackWallet) {
  await expect(restored.getByTestId('gate-stack')).toHaveAttribute('data-state', 'online');
  await restored.getByRole('button', { name: /Restore a wallet/ }).click();
  await restored.locator('textarea').fill(wallet.phrase);
  await restored.getByTestId('restore-from-tower').check();
  await restored.getByTestId('restore-source').selectOption('file');
}

async function completeRestore(restored: Page, path: string) {
  await restored.getByTestId('restore-file').setInputFiles(path);
  await restored.getByRole('button', { name: 'Restore wallet', exact: true }).click();
  await restored.getByLabel('Password', { exact: true }).fill(LOCAL_PASSWORD);
  await restored.getByLabel('Confirm password', { exact: true }).fill(LOCAL_PASSWORD);
  await restored.getByRole('button', { name: 'Save and open', exact: true }).click();
  await expect(restored.locator('[data-testid="nav-home"]:visible, .gate-error').first()).toBeVisible({
    timeout: 25_000,
  });
  await expect(restored.locator('.gate-error')).toHaveCount(0);
}

async function assertRestoredCheckpoint({ restored, before, funded, hubId }: FundedBackup) {
  const after = await readWalletCheckpoint(restored, before.frame.height);
  expect(after.runtimeId).toBe(before.runtimeId);
  expect(after.entityId).toBe(before.entityId);
  expect(after.accounts).toEqual(before.accounts);
  expect(await readState(restored, hubId)).toMatchObject({
    accountHeight: funded.accountHeight,
    accountRoot: funded.accountRoot,
    collateral: AMOUNT.toString(),
    reserve: '0',
    ownValue: AMOUNT.toString(),
  });
  return after;
}

test(
  'a downloaded backup rejects corruption and refuses to overwrite restored signed Accounts',
  { tag: '@resilience' },
  async ({ fundedBackup }) => {
    const { restored, wallet, path, contents } = fundedBackup;
    const damaged = JSON.parse(contents);
    damaged.bundle.ciphertext = (damaged.bundle.ciphertext[0] === 'A' ? 'B' : 'A') + damaged.bundle.ciphertext.slice(1);
    await chooseFile(restored, wallet);
    await restored
      .getByTestId('restore-file')
      .setInputFiles({
        name: 'corrupted.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(damaged)),
      });
    await restored.getByRole('button', { name: 'Restore wallet', exact: true }).click();
    await expect(restored.getByRole('alert')).toBeVisible();
    await expect(restored.getByRole('heading', { name: 'Set a local password' })).toHaveCount(0);
    await completeRestore(restored, path);
    await assertRestoredCheckpoint(fundedBackup);
    await restored.reload();
    await chooseFile(restored, wallet);
    await restored.getByTestId('restore-file').setInputFiles(path);
    await restored.getByRole('button', { name: 'Restore wallet', exact: true }).click();
    await expect(restored.getByRole('alert')).toContainText('already has data');
    await restored.reload();
    await reopenStack(restored, wallet);
    await assertRestoredCheckpoint(fundedBackup);
  },
);

test(
  'a downloaded backup restores signed Accounts and exits collateral on a fresh device',
  { tag: '@resilience' },
  async ({ fundedBackup }, info) => {
    const { restored, wallet, hubId, path, funded, before, provider } = fundedBackup;
    await chooseFile(restored, wallet);
    await completeRestore(restored, path);
    const after = await assertRestoredCheckpoint(fundedBackup);
    await restored.locator(`[data-testid="account-row"][data-counterparty-id="${hubId}"]`).click();
    await manageDispute(restored);
    await restored.getByTestId('dispute-prepare').click();
    await restored.getByTestId('dispute-prepare-confirm').click();
    const contract = Depository__factory.connect(funded.depository, provider);
    const initialBlock = await provider.getBlockNumber();
    await broadcast(restored, 'Dispute start');
    await expect.poll(async () => (await readState(restored, hubId)).dispute?.observedOnChain, WAIT).toBe(true);
    const active = (await readState(restored, hubId)).dispute;
    if (!active) throw new Error('Restored dispute evidence unavailable');
    const starts = await contract.queryFilter(contract.filters.DisputeStarted(wallet.entityId, hubId), initialBlock);
    expect(starts).toHaveLength(1);
    const startedReceipt = await starts[0]!.getTransactionReceipt();
    expect(startedReceipt.status).toBe(1);
    expect(startedReceipt.gasUsed).toBeLessThanOrEqual(5_000_000n);

    await restored.clock.pauseAt(await restored.evaluate(() => Date.now() + 1000));
    const deadline = active.disputeTimeout + 1;
    await provider.send('evm_setNextBlockTimestamp', [deadline]);
    await provider.send('evm_mine', []);
    const hostClock = await restored.evaluate(() => Math.round(performance.timeOrigin + performance.now()));
    try {
      await restored.clock.fastForward(deadline * 1000 - hostClock);
    } finally {
      await restored.clock.resume();
    }
    await finishSubmission(restored, hubId);
    await expect
      .poll(async () => {
        const state = await readState(restored, hubId);
        return [state.dispute, state.status, state.reserve, state.collateral];
      }, WAIT)
      .toEqual([null, 'disputed', AMOUNT.toString(), '0']);
    const finalChain = await chainMoney(contract, wallet.entityId, hubId);
    expect(finalChain).toMatchObject({
      reserve: AMOUNT.toString(),
      collateral: '0',
      disputeHash: ZeroHash,
      timeout: 0,
    });
    const finalized = await contract.queryFilter(
      contract.filters.DisputeFinalized(wallet.entityId, hubId),
      initialBlock,
    );
    expect(finalized).toHaveLength(1);
    const receipt = await finalized[0]!.getTransactionReceipt();
    expect(receipt.status).toBe(1);
    expect(receipt.gasUsed).toBeLessThanOrEqual(5_000_000n);
    // Restore real wall time before a new authenticated relay handshake.
    await restored.clock.setSystemTime(Date.now());
    await restored.reload();
    await reopenStack(restored, wallet);
    expect(await readState(restored, hubId)).toMatchObject({
      status: 'disputed',
      reserve: AMOUNT.toString(),
      collateral: '0',
    });
    await info.attach('file-restore-exit', {
      contentType: 'application/json',
      body: JSON.stringify({
        runtimeId: wallet.runtimeId,
        originalAccounts: before.accounts,
        restoredAccounts: after.accounts,
        startTransaction: startedReceipt.hash,
        startGas: startedReceipt.gasUsed.toString(),
        finalTransaction: receipt.hash,
        finalGas: receipt.gasUsed.toString(),
        finalChain,
      }),
    });
    await restored.screenshot({ path: info.outputPath('restored-after-exit.png'), fullPage: true });
  },
);

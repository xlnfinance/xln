import { readFileSync } from 'node:fs';

import { expect, test, type Page } from './global-setup';

import {
  normalizeBrainvaultMnemonic as normalizeMnemonic,
  runBrainvaultCli,
  type BrainvaultCliOutput,
} from './utils/e2e-brainvault';

import {
  APP_BASE_URL,
  createRuntimeIdentity,
  deriveSignerAddressFromMnemonic,
  gotoApp,
  selectDemoMnemonic,
} from './utils/e2e-demo-users';

type StoredRuntime = {
  id?: string;
  label?: string;
  seed?: string;
  mnemonic12?: string;
};

type CanonicalEntityProbe = {
  runtimeId: string;
  replicaKey: string;
  entityId: string;
  signerId: string;
  height: number;
  profileName: string;
  accountCount: number;
};

type BrowserEntityEnv = {
  runtimeId?: string;
  eReplicas?: Map<string, {
    entityId?: string;
    state?: {
      entityId?: string;
      height?: number;
      profile?: { name?: string };
      accounts?: Map<string, unknown>;
    };
  }>;
};

const CASES = [
  { name: 'vault alpha', passphrase: 'saffron-rain-42', shards: 6 },
  { name: 'vault beta', passphrase: 'mango-river-77', shards: 7 },
  { name: 'vault gamma', passphrase: 'linen-fox-88', shards: 8 },
];
const APP_HOST = new URL(APP_BASE_URL).hostname;
const REQUIRE_BROWSER_RUNTIME_GLOBALS =
  APP_HOST === 'localhost' || APP_HOST === '127.0.0.1' || APP_HOST === '::1';

async function waitForBrainvaultCreateForm(page: Page): Promise<void> {
  const brainVaultTab = page.getByRole('button', { name: 'BrainVault', exact: true });
  if (await brainVaultTab.isVisible().catch(() => false)) {
    await brainVaultTab.click();
  }
  await expect(page.getByRole('heading', { name: /Create XLN wallet/i }).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#name')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#passphrase')).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByTestId('brainvault-create-details'),
    'BrainVault recovery controls belong to the post-create setup screen, not the initial wallet form',
  ).toHaveCount(0);
  await expect(
    page.getByText('BrainVault recovery'),
    'BrainVault recovery belongs to the next screen after wallet creation',
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: /Download sheet/i }),
    'Seed sheet download belongs to the post-create recovery panel',
  ).toHaveCount(0);
}

async function expectPostCreateBrainvaultRecovery(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: /Configure account/i })).toBeVisible({ timeout: 30_000 });
  const recoveryDetails = page.getByTestId('brainvault-onboarding-recovery');
  await expect(recoveryDetails).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('brainvault-onboarding-recovery-toggle')).toContainText(/Seed safety/i);
  await expect(page.getByRole('heading', { name: /Encrypted backup and last-resort dispute protection/i })).toBeVisible();
  const downloadButton = page.getByRole('button', { name: /Download sheet/i });
  if (!await downloadButton.isVisible().catch(() => false)) {
    await page.getByTestId('brainvault-onboarding-recovery-toggle').click();
  }
  await expect(downloadButton).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole('link', { name: /Read safety notes/i })).toBeVisible({ timeout: 5_000 });
}

async function readRuntimeCount(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const raw = localStorage.getItem('xln-vaults');
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as { runtimes?: Record<string, unknown> };
    return Object.keys(parsed.runtimes ?? {}).length;
  });
}

async function readActiveRuntimeId(page: Page): Promise<string | null> {
  return await page.evaluate(() => {
    const raw = localStorage.getItem('xln-vaults');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { activeRuntimeId?: string };
    return parsed.activeRuntimeId ?? null;
  });
}

async function openAddRuntimePanel(page: Page): Promise<void> {
  const trigger = page.locator('button:has([data-testid="context-current"]), .context-switcher .dropdown-trigger').first();
  const menu = page.locator('.switcher-menu').first();
  await expect(trigger).toBeVisible({ timeout: 15_000 });
  if (!await menu.isVisible().catch(() => false)) {
    await trigger.click({ force: true });
  }
  const addRuntimeItem = page.locator('.switcher-menu .add-runtime-btn').filter({ hasText: /Add Runtime/i }).first();
  await expect(addRuntimeItem).toBeVisible({ timeout: 10_000 });
  await addRuntimeItem.click();
  await waitForBrainvaultCreateForm(page);
}

async function waitForRuntimeMetadata(page: Page, expectedRuntimeId: string): Promise<StoredRuntime> {
  const handle = await page.waitForFunction((runtimeId: string) => {
    try {
      const raw = localStorage.getItem('xln-vaults');
      if (!raw) return null;
      const parsed = JSON.parse(raw) as {
        activeRuntimeId?: string;
        runtimes?: Record<string, StoredRuntime>;
      };
      const runtime = parsed.activeRuntimeId ? parsed.runtimes?.[parsed.activeRuntimeId] : null;
      if (!runtime || String(runtime.id || '').toLowerCase() !== runtimeId.toLowerCase()) return null;
      return runtime;
    } catch {
      return null;
    }
  }, expectedRuntimeId, { timeout: 90_000 });
  return await handle.jsonValue() as StoredRuntime;
}

const phraseAfter = (sheet: string, heading: string): string => {
  const lines = sheet.split(/\r?\n/);
  const index = lines.findIndex(line => line.trim() === heading);
  if (index < 0) throw new Error(`BRAINVAULT_SHEET_HEADING_MISSING:${heading}`);
  return normalizeMnemonic(lines[index + 1] || '');
};

async function readBrainvaultRecoverySheet(page: Page): Promise<BrainvaultCliOutput & { runtimeId: string }> {
  const recoveryDetails = page.getByTestId('brainvault-onboarding-recovery');
  await expect(recoveryDetails).toBeVisible({ timeout: 30_000 });
  const downloadButton = page.getByRole('button', { name: /Download sheet/i });
  if (!await downloadButton.isVisible().catch(() => false)) {
    await page.getByTestId('brainvault-onboarding-recovery-toggle').click();
  }
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    downloadButton.click(),
  ]);
  const downloadPath = await download.path();
  if (!downloadPath) throw new Error('BRAINVAULT_SHEET_DOWNLOAD_PATH_MISSING');
  const sheet = readFileSync(downloadPath, 'utf8');
  const runtimeIdLine = sheet.split(/\r?\n/).find(line => line.startsWith('Runtime ID:')) || '';
  return {
    mnemonic24: phraseAfter(sheet, '24-word recovery phrase:'),
    mnemonic12: phraseAfter(sheet, '12-word compatibility phrase:'),
    runtimeId: runtimeIdLine.slice('Runtime ID:'.length).trim().toLowerCase(),
  };
}

async function createFreshWalletWhenNoBackupExists(page: Page): Promise<void> {
  const configureHeading = page.getByRole('heading', { name: /Configure account/i });
  await expect(configureHeading).toBeVisible({ timeout: 120_000 });
  const recoveryStatus = page.getByTestId('runtime-recovery-check-status');
  await expect(recoveryStatus).toBeVisible({ timeout: 30_000 });
  await expect(recoveryStatus).toContainText(/Checked \d+ watchtowers?,\s+found 0 backups? for this seed/i);
  await expect(recoveryStatus.getByRole('button', { name: /I have a runtime backup file/i })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Restore wallet/i })).toHaveCount(0);
}

async function deriveBrainvaultInUi(page: Page, name: string, passphrase: string, shards: number): Promise<BrainvaultCliOutput> {
  await waitForBrainvaultCreateForm(page);

  await page.locator('#name').fill(name);
  await page.locator('#passphrase').fill(passphrase);

  // Security work factor presets (incl. Custom) are collapsed under the "Advanced" toggle now.
  await page.getByRole('button', { name: /Security work factor/i }).click();
  await page.getByRole('button', { name: /Custom/i }).click();
  await page.locator('#shards').fill(String(shards));

  const openVaultButton = page.getByRole('button', { name: /Derive wallet/i });
  await expect(openVaultButton).toBeEnabled({ timeout: 15_000 });
  await openVaultButton.click();
  await createFreshWalletWhenNoBackupExists(page);

  const recovery = await readBrainvaultRecoverySheet(page);
  const expectedRuntimeId = deriveSignerAddressFromMnemonic(recovery.mnemonic24);
  const runtime = await waitForRuntimeMetadata(page, expectedRuntimeId);
  expect(runtime.label).toBe(name);
  expect(runtime.seed).toBeUndefined();
  expect(runtime.mnemonic12).toBeUndefined();
  expect(recovery.runtimeId).toBe(expectedRuntimeId);
  return recovery;
}

async function waitForCanonicalProfile(page: Page, expectedProfileName: string): Promise<CanonicalEntityProbe> {
  const handle = await page.waitForFunction((profileName: string) => {
    const error = [...document.querySelectorAll<HTMLElement>('.error-msg, .toast.error .message')]
      .find((element) => element.offsetParent !== null)?.textContent?.trim();
    if (error) throw new Error(`BRAINVAULT_START_FAILED:${error}`);
    const env = (window as typeof window & { isolatedEnv?: BrowserEntityEnv }).isolatedEnv;
    for (const [replicaKey, replica] of env?.eReplicas?.entries?.() ?? []) {
      const [keyEntityId = '', signerId = ''] = String(replicaKey).split(':');
      const entityId = String(replica?.state?.entityId || replica?.entityId || '').toLowerCase();
      if (replica?.state?.profile?.name !== profileName || entityId !== keyEntityId.toLowerCase()) continue;
      return {
        runtimeId: String(env?.runtimeId || '').toLowerCase(),
        replicaKey: String(replicaKey).toLowerCase(),
        entityId,
        signerId: signerId.toLowerCase(),
        height: Number(replica?.state?.height || 0),
        profileName: replica.state.profile.name,
        accountCount: Number(replica?.state?.accounts?.size || 0),
      };
    }
    return null;
  }, expectedProfileName, { timeout: 90_000 });
  return await handle.jsonValue() as CanonicalEntityProbe;
}

async function readOnboardingRuntimeDiagnostics(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => {
    const env = (window as typeof window & { isolatedEnv?: Record<string, any> }).isolatedEnv;
    const summarizeInput = (input: any) => ({
      entityInputs: (input?.entityInputs ?? []).map((candidate: any) => ({
        entityId: candidate?.entityId,
        signerId: candidate?.signerId,
        entityTxs: (candidate?.entityTxs ?? []).map((tx: any) => tx?.type),
        proposedHeight: candidate?.proposedFrame?.height ?? null,
        hashPrecommitCount: candidate?.hashPrecommits instanceof Map ? candidate.hashPrecommits.size : 0,
        jPrefixAttestationCount: candidate?.jPrefixAttestations instanceof Map
          ? candidate.jPrefixAttestations.size
          : 0,
      })),
      runtimeTxs: (input?.runtimeTxs ?? []).map((tx: any) => tx?.type),
      jInputs: (input?.jInputs ?? []).map((input: any) => input?.jurisdictionName),
    });
    return {
      runtimeHeight: env?.height ?? null,
      runtimeMempool: summarizeInput(env?.runtimeMempool),
      history: (env?.history ?? []).slice(-12).map((frame: any) => ({
        height: frame?.height,
        input: summarizeInput(frame?.runtimeInput),
      })),
      replicas: Array.from(env?.eReplicas?.entries?.() ?? []).map(([key, replica]: [string, any]) => ({
        key,
        entityId: replica?.state?.entityId,
        height: replica?.state?.height,
        profileName: replica?.state?.profile?.name,
        accounts: Array.from(replica?.state?.accounts?.keys?.() ?? []),
        mempool: (replica?.mempool ?? []).map((tx: any) => tx?.type),
        proposalHeight: replica?.proposal?.height ?? null,
        proposalTxs: (replica?.proposal?.entityTxs ?? []).map((tx: any) => tx?.type),
        lockedHeight: replica?.lockedFrame?.height ?? null,
        jPrefixTarget: replica?.jPrefixRound?.targetHeight ?? null,
      })),
    };
  });
}

async function startBrainvaultWallet(page: Page, expectedProfileName: string): Promise<CanonicalEntityProbe> {
  const configureHeading = page.getByRole('heading', { name: /Configure account/i });
  await expect(configureHeading).toBeVisible({ timeout: 30_000 });
  await page.locator('#display-name').fill(expectedProfileName);

  const terms = page.locator('.confirm-section input[type="checkbox"]').first();
  if (!await terms.isChecked()) await terms.check();
  const startButton = page.getByRole('button', { name: /^Start$/i });
  await expect(startButton).toBeEnabled({ timeout: 15_000 });
  await startButton.click();

  const completion = await page.waitForFunction(() => {
    const visibleError = [...document.querySelectorAll<HTMLElement>('.error-msg, .toast.error .message')]
      .find((element) => element.offsetParent !== null)?.textContent?.trim();
    if (visibleError) return { status: 'error', error: visibleError };
    const heading = [...document.querySelectorAll<HTMLElement>('h1, h2, h3')]
      .find((element) => element.textContent?.trim() === 'Configure account' && element.offsetParent !== null);
    return heading ? null : { status: 'complete', error: '' };
  }, undefined, { timeout: 30_000 }).then((handle) => handle.jsonValue()) as {
    status: 'complete' | 'error';
    error: string;
  };
  if (completion.status === 'error') {
    const work = await page.evaluate(() => {
      const env = (window as typeof window & { isolatedEnv?: Record<string, any> }).isolatedEnv;
      const summarizeInput = (input: any) => ({
        runtimeTxs: (input?.runtimeTxs ?? []).map((tx: any) => tx?.type),
        jInputs: (input?.jInputs ?? []).map((tx: any) => tx?.type),
        entityInputs: (input?.entityInputs ?? []).map((candidate: any) => ({
          entityId: candidate?.entityId,
          signerId: candidate?.signerId,
          txs: (candidate?.entityTxs ?? []).map((tx: any) => tx?.type),
          proposedHeight: candidate?.proposedFrame?.height ?? null,
          precommits: candidate?.hashPrecommits instanceof Map ? candidate.hashPrecommits.size : 0,
        })),
      });
      return {
        height: env?.height,
        runtimeMempool: summarizeInput(env?.runtimeMempool),
        pendingOutputs: (env?.pendingOutputs ?? []).length,
        networkInbox: (env?.networkInbox ?? []).length,
        pendingNetworkOutputs: (env?.pendingNetworkOutputs ?? []).length,
        pendingCommittedJOutbox: env?.runtimeState?.pendingCommittedJOutbox?.length ?? 0,
        pendingJurisdictionImports: env?.runtimeState?.pendingJurisdictionImports?.size ?? 0,
        replicas: Array.from(env?.eReplicas?.entries?.() ?? []).map(([key, replica]: [string, any]) => ({
          key,
          height: replica?.state?.height,
          profileName: replica?.state?.profile?.name,
          mempool: (replica?.mempool ?? []).map((tx: any) => tx?.type),
          proposal: replica?.proposal?.height ?? null,
          locked: replica?.lockedFrame?.height ?? null,
          jPrefixTarget: replica?.jPrefixRound?.targetHeight ?? null,
          accountMempools: Array.from(replica?.state?.accounts?.values?.() ?? [])
            .map((account: any) => (account?.mempool ?? []).map((tx: any) => tx?.type)),
        })),
      };
    });
    throw new Error(`BRAINVAULT_START_FAILED:${completion.error}:${JSON.stringify(work)}`);
  }
  await expect(page.locator('.error-msg:visible')).toHaveCount(0);
  await expect(page.locator('.toast.error .message').filter({
    hasText: /RUNTIME_INPUT_QUARANTINED|Runtime error/i,
  })).toHaveCount(0);
  return waitForCanonicalProfile(page, expectedProfileName);
}

test.describe('brainvault parity', () => {
  for (const currentCase of CASES) {
    test(`browser brainvault matches local CLI for ${currentCase.shards} shards`, { tag: '@functional' }, async ({ page }) => {
      test.slow();

      await gotoApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: 60_000, settleMs: 250 });

      const cli = runBrainvaultCli(currentCase.name, currentCase.passphrase, currentCase.shards);
      const ui = await deriveBrainvaultInUi(page, currentCase.name, currentCase.passphrase, currentCase.shards);

      expect(ui.mnemonic12).toBe(cli.mnemonic12);
      expect(ui.mnemonic24).toBe(cli.mnemonic24);
    });
  }

  test('standalone BrainVault creates and starts the XLN wallet with deterministic seed material', { tag: '@functional' }, async ({ page }) => {
    test.slow();

    await gotoApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: 60_000, settleMs: 250 });

    const cli = runBrainvaultCli('standalone vault', 'ced-export-42', 1);
    await waitForBrainvaultCreateForm(page);
    await page.locator('#name').fill('standalone vault');
    await page.locator('#passphrase').fill('ced-export-42');
    // Security work factor presets are collapsed under the "Advanced" toggle now.
    await page.getByRole('button', { name: /Security work factor/i }).click();
    await page.getByRole('button', { name: /^1\s+Test$/ }).click();

    const openVaultButton = page.getByRole('button', { name: /Derive wallet/i });
    await expect(openVaultButton).toBeEnabled({ timeout: 15_000 });
    await openVaultButton.click();
    await createFreshWalletWhenNoBackupExists(page);

    const expectedRuntimeId = deriveSignerAddressFromMnemonic(cli.mnemonic24);
    const runtime = await waitForRuntimeMetadata(page, expectedRuntimeId);
    const recovery = await readBrainvaultRecoverySheet(page);
    expect(runtime.label).toBe('standalone vault');
    expect(runtime.seed).toBeUndefined();
    expect(runtime.mnemonic12).toBeUndefined();
    expect(recovery.mnemonic24).toBe(cli.mnemonic24);
    expect(recovery.mnemonic12).toBe(cli.mnemonic12);
    expect(recovery.runtimeId).toBe(expectedRuntimeId);
    expect(await readRuntimeCount(page)).toBe(1);
    await expectPostCreateBrainvaultRecovery(page);

    const canonicalEntity = await startBrainvaultWallet(page, 'standalone live profile');
    expect(canonicalEntity.runtimeId).toBe(expectedRuntimeId);
    expect(canonicalEntity.profileName).toBe('standalone live profile');
    expect(canonicalEntity.entityId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(canonicalEntity.signerId).toMatch(/^0x[0-9a-f]{40}$/);
    expect(canonicalEntity.signerId).toBe(expectedRuntimeId);
    expect(canonicalEntity.replicaKey).toBe(`${canonicalEntity.entityId}:${canonicalEntity.signerId}`);
    expect(canonicalEntity.height).toBeGreaterThan(0);
    if (canonicalEntity.accountCount < 1) {
      const diagnostic = await readOnboardingRuntimeDiagnostics(page);
      throw new Error(`BRAINVAULT_AUTO_JOIN_NOT_FINALIZED:${JSON.stringify(diagnostic)}`);
    }

    await page.reload({ waitUntil: 'domcontentloaded' });
    const restoredEntity = await waitForCanonicalProfile(page, 'standalone live profile');
    expect(restoredEntity.runtimeId).toBe(expectedRuntimeId);
    expect(restoredEntity.entityId).toBe(canonicalEntity.entityId);
    expect(restoredEntity.signerId).toBe(canonicalEntity.signerId);
    expect(restoredEntity.height).toBeGreaterThanOrEqual(canonicalEntity.height);
    expect(restoredEntity.accountCount).toBeGreaterThanOrEqual(1);
    await expect(page.getByRole('heading', { name: /Configure account/i })).toHaveCount(0);
  });

  test('embedded BrainVault add-runtime flow does not fall back to the active wallet', { tag: '@functional' }, async ({ page }) => {
    test.slow();

    await gotoApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: 60_000, settleMs: 250 });

    const oldRuntime = await createRuntimeIdentity(page, 'alice', selectDemoMnemonic('alice'), {
      requireOnline: REQUIRE_BROWSER_RUNTIME_GLOBALS,
    });
    expect(await readRuntimeCount(page)).toBe(1);

    await openAddRuntimePanel(page);
    const derived = await deriveBrainvaultInUi(page, 'embedded add runtime', 'ced-add-runtime-42', 1);

    const runtime = await waitForRuntimeMetadata(page, deriveSignerAddressFromMnemonic(derived.mnemonic24));
    expect(runtime.label).toBe('embedded add runtime');
    expect(runtime.seed).toBeUndefined();
    expect(runtime.mnemonic12).toBeUndefined();
    expect(await readActiveRuntimeId(page)).not.toBe(oldRuntime.runtimeId);
    expect(await readRuntimeCount(page)).toBe(2);
  });
});

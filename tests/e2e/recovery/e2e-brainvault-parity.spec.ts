import type { RuntimeReplica } from '../../../core/api/public/runtime-module';
import type { VaultMeta } from '../../../ui/src/runtime/store';
import { createWalletIdentity } from '../../../ui/tests/wallet-ui';
import { allowBrowserIssue, expect, test, type Page } from '../../global-setup.mts';
import { connectRuntimeToHub } from '../../utils/e2e-connect';
import { APP_BASE_URL, deriveSignerAddressFromMnemonic, gotoApp, selectDemoMnemonic } from '../../utils/e2e-demo-users';
import { deriveBrainvaultOracle } from '../../utils/runtime/e2e-brainvault';

type TestWindow = Window & {
  __xln?: {
    env: () => RuntimeReplica | null;
    store: { getState: () => { activeEntityId: string | null; activeVaultId: string | null; vaults: VaultMeta[] } };
  };
};

const CASES = [
  { name: 'vault alpha', passphrase: 'saffron-rain-42', shards: 6 },
  { name: 'vault beta', passphrase: 'mango-river-77', shards: 7 },
  { name: 'vault gamma', passphrase: 'linen-fox-88', shards: 8 },
];

async function expectVaultMetadata(
  page: Page,
  runtimeId: string,
  name: string,
  mnemonic: string,
  count: number,
): Promise<void> {
  const saved = await page.evaluate(() => {
    const debug = (window as TestWindow).__xln;
    if (!debug) throw new Error('CURRENT_WALLET_DIAGNOSTICS_MISSING');
    const state = debug.store.getState();
    return {
      activeId: state.activeVaultId,
      vaults: state.vaults,
      persisted: localStorage.getItem('xln-ui-vaults'),
      encrypted: localStorage.getItem(`xln-password-vault:${state.activeVaultId}`),
      allStorage: Object.values(localStorage),
    };
  });
  expect(saved.activeId).toBe(runtimeId);
  expect(saved.vaults).toHaveLength(count);
  expect(saved.vaults.find(vault => vault.id === runtimeId)).toMatchObject({ id: runtimeId, name, kind: 'brainvault' });
  expect(saved.persisted).not.toBeNull();
  expect(JSON.parse(saved.persisted ?? 'null')).toEqual(saved.vaults);
  expect(saved.encrypted).not.toBeNull();
  const encrypted: unknown = JSON.parse(saved.encrypted ?? 'null');
  expect(encrypted).toMatchObject({
    version: 1,
    ciphertext: expect.any(String),
    salt: expect.any(String),
    iv: expect.any(String),
  });
  expect(saved.persisted).not.toMatch(/"(?:seed|mnemonic12|mnemonic)"\s*:/);
  expect(saved.allStorage.every(value => !value.includes(mnemonic))).toBe(true);
}

async function deriveBrainvaultInUi(page: Page, name: string, passphrase: string, shards: number): Promise<void> {
  await expect(page.locator('[data-testid="gate-stack"][data-state="online"]')).toBeVisible();
  await page.getByRole('button', { name: /Create a wallet/ }).click();
  await page.getByLabel('Vault name', { exact: true }).fill(name);
  await page.getByLabel('Passphrase', { exact: true }).fill(passphrase);
  if (shards === 1) await page.getByRole('button', { name: 'Test 1 shard', exact: true }).click();
  else await page.getByPlaceholder('custom shards · 6+').fill(String(shards));
  await page.getByRole('button', { name: 'Derive vault', exact: true }).click();
  await page.locator('[data-testid="nav-home"]:visible, [role="alert"]').first().waitFor({ timeout: 30_000 });
  const errors = await page.getByRole('alert').allTextContents();
  if (errors.length) throw new Error(`BRAINVAULT_START_FAILED:${errors.join(';')}`);
}

async function readCanonicalEntity(page: Page) {
  return page.evaluate(() => {
    const debug = (window as TestWindow).__xln;
    const env = debug?.env();
    const entityId = debug?.store.getState().activeEntityId;
    if (!env || !entityId) throw new Error('CURRENT_WALLET_IDENTITY_MISSING');
    const entries = [...env.state.eReplicas.entries()].filter(([, replica]) => replica.entityId === entityId);
    const [entry] = entries;
    if (entries.length !== 1 || !entry) throw new Error('CURRENT_WALLET_SIGNER_NOT_UNIQUE');
    const [replicaKey, replica] = entry;
    const accounts = [...replica.state.accounts.entries()];
    return {
      runtimeId: env.runtimeId,
      replicaKey,
      entityId,
      signerId: replica.signerId,
      height: replica.state.height,
      profileName: replica.state.profile.name,
      profileBio: replica.state.profile.bio,
      profileWebsite: replica.state.profile.website,
      accountIds: accounts.map(([id]) => id.toLowerCase()).sort(),
      pendingAccountIds: accounts
        .filter(([, account]) => account.pendingFrame || account.currentHeight === 0)
        .map(([id]) => id),
    };
  });
}

async function readCurrentHubIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const debug = (window as TestWindow).__xln;
    const env = debug?.env();
    const entityId = debug?.store.getState().activeEntityId;
    if (!env || !entityId) throw new Error('CURRENT_WALLET_IDENTITY_MISSING');
    const jurisdiction = [...env.state.eReplicas.values()].find(replica => replica.entityId === entityId)?.state.config
      .jurisdiction;
    if (!jurisdiction) throw new Error('CURRENT_WALLET_JURISDICTION_MISSING');
    return env.gossip
      .getProfiles()
      .filter(
        profile =>
          profile.metadata?.isHub === true &&
          profile.metadata.jurisdiction?.chainId === jurisdiction.chainId &&
          profile.metadata.jurisdiction?.depositoryAddress.toLowerCase() ===
            jurisdiction.depositoryAddress.toLowerCase(),
      )
      .map(profile => profile.entityId.toLowerCase())
      .sort();
  });
}

async function readAdvertisedHubIds(page: Page): Promise<string[]> {
  const response = await page.request.get(new URL('/api/hubs', APP_BASE_URL).toString());
  expect(response.ok()).toBe(true);
  const payload: unknown = await response.json();
  if (
    !payload ||
    typeof payload !== 'object' ||
    !('ok' in payload) ||
    payload.ok !== true ||
    !('hubs' in payload) ||
    !Array.isArray(payload.hubs)
  )
    throw new Error('HUB_DISCOVERY_RESPONSE_INVALID');
  return payload.hubs
    .map((hub: unknown) => {
      if (
        !hub ||
        typeof hub !== 'object' ||
        !('entityId' in hub) ||
        typeof hub.entityId !== 'string' ||
        !('metadata' in hub) ||
        !hub.metadata ||
        typeof hub.metadata !== 'object' ||
        !('isHub' in hub.metadata) ||
        hub.metadata.isHub !== true
      )
        throw new Error('HUB_DISCOVERY_ENTRY_INVALID');
      return hub.entityId.toLowerCase();
    })
    .sort();
}

async function waitForCanonicalProfile(page: Page, profileName: string) {
  await expect
    .poll(
      async () => {
        const entity = await readCanonicalEntity(page);
        return {
          profileName: entity.profileName,
          accountCount: entity.accountIds.length,
          pendingAccountIds: entity.pendingAccountIds,
        };
      },
      { timeout: 15_000, message: 'Signed profile and all three bilateral Hub Accounts must commit' },
    )
    .toEqual({ profileName, accountCount: 3, pendingAccountIds: [] });
  return readCanonicalEntity(page);
}

test.describe('brainvault parity', () => {
  for (const currentCase of CASES) {
    test(
      `browser brainvault matches native oracle for ${currentCase.shards} shards`,
      { tag: '@functional' },
      async ({ page }) => {
        await gotoApp(page, { appBaseUrl: APP_BASE_URL });
        const oracle = await deriveBrainvaultOracle(currentCase.name, currentCase.passphrase, currentCase.shards);
        await deriveBrainvaultInUi(page, currentCase.name, currentCase.passphrase, currentCase.shards);
        const expectedId = deriveSignerAddressFromMnemonic(oracle.mnemonic24);
        expect((await readCanonicalEntity(page)).runtimeId).toBe(expectedId);
        await expectVaultMetadata(page, expectedId, currentCase.name, oracle.mnemonic24, 1);
      },
    );
  }

  test(
    'standalone BrainVault creates and starts the XLN wallet with deterministic seed material',
    { tag: '@functional' },
    async ({ page }) => {
      await gotoApp(page, { appBaseUrl: APP_BASE_URL });
      const oracle = await deriveBrainvaultOracle('standalone vault', 'ced-export-42', 1);
      const expectedId = deriveSignerAddressFromMnemonic(oracle.mnemonic24);
      await deriveBrainvaultInUi(page, 'standalone vault', 'ced-export-42', 1);
      await expectVaultMetadata(page, expectedId, 'standalone vault', oracle.mnemonic24, 1);
      const identity = await readCanonicalEntity(page);
      // Preserve this fixture's three-hub resilience requirement over the one-hub product default.
      await expect.poll(() => readCurrentHubIds(page)).toHaveLength(3);
      const hubs = await readCurrentHubIds(page);
      for (const hub of hubs) await connectRuntimeToHub(page, identity, hub);
      await page.locator('[data-testid="nav-settings"]:visible').click();
      await page.getByTestId('profile-name').fill('standalone live profile');
      await page.getByLabel('Website', { exact: true }).fill('https://example.com/standalone');
      await page.getByLabel('About you', { exact: true }).fill('Signed profile survives local unlock');
      await page.getByTestId('profile-publish').click();
      const canonical = await waitForCanonicalProfile(page, 'standalone live profile');
      expect(canonical.runtimeId).toBe(expectedId);
      expect(canonical.profileBio).toBe('Signed profile survives local unlock');
      expect(canonical.profileWebsite).toBe('https://example.com/standalone');
      expect(canonical.entityId).toMatch(/^0x[0-9a-f]{64}$/);
      expect(canonical.signerId).toBe(expectedId);
      expect(canonical.signerId).toMatch(/^0x[0-9a-f]{40}$/);
      expect(canonical.replicaKey).toBe(`${canonical.entityId}:${canonical.signerId}`);
      expect(canonical.height).toBeGreaterThan(0);
      expect(canonical.accountIds).toEqual(hubs);
      const advertised = await readAdvertisedHubIds(page);
      expect(canonical.accountIds.every(id => advertised.includes(id))).toBe(true);
      // Only this exact recipient's transient reload disconnect may retain routing outputs.
      allowBrowserIssue({
        type: 'console',
        severity: 'warning',
        message: new RegExp(`\\[WARN\\]\\[network\\.route\\] output\\.retained .*"runtimeId":"${expectedId}"`),
      });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await page.getByLabel('Password', { exact: true }).fill('ced-export-42');
      await page.getByRole('button', { name: 'Unlock', exact: true }).click();
      await expect(page.locator('[data-testid="nav-home"]:visible')).toBeVisible();
      const restored = await waitForCanonicalProfile(page, 'standalone live profile');
      expect(restored).toEqual({ ...canonical, height: restored.height });
      expect(restored.height).toBeGreaterThanOrEqual(canonical.height);
      expect(restored.pendingAccountIds).toEqual([]);
      await expectVaultMetadata(page, expectedId, 'standalone vault', oracle.mnemonic24, 1);
      await expect(page.getByLabel('Vault name', { exact: true })).toHaveCount(0);
    },
  );

  test(
    'embedded BrainVault add-runtime flow does not fall back to the active wallet',
    { tag: '@functional' },
    async ({ page }) => {
      await gotoApp(page, { appBaseUrl: APP_BASE_URL });
      const old = await createWalletIdentity(page, 'alice', selectDemoMnemonic('alice'));
      await page.locator('[data-testid="nav-settings"]:visible').click();
      await page.getByRole('button', { name: 'Lock', exact: true }).click();
      const oracle = await deriveBrainvaultOracle('embedded add runtime', 'ced-add-runtime-42', 1);
      const expectedId = deriveSignerAddressFromMnemonic(oracle.mnemonic24);
      await deriveBrainvaultInUi(page, 'embedded add runtime', 'ced-add-runtime-42', 1);
      expect((await readCanonicalEntity(page)).runtimeId).toBe(expectedId);
      expect(expectedId).not.toBe(old.runtimeId);
      await expectVaultMetadata(page, expectedId, 'embedded add runtime', oracle.mnemonic24, 2);
      expect(await page.evaluate(id => localStorage.getItem(`xln-password-vault:${id}`) !== null, old.runtimeId)).toBe(
        true,
      );
    },
  );
});

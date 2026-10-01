import { expect, test } from '@playwright/test';

test('native BrainVault without verified recovery never creates an empty runtime', { tag: '@functional' }, async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/', { waitUntil: 'networkidle' });
  const evidence = await page.evaluate(async () => {
    const nativePath = '/src/native/brainvault.ts';
    const recoveryPath = '/src/runtime/recovery.ts';
    const adapterPath = '/src/runtime/adapter.ts';
    const { openNativeBrainvault } = await import(nativePath);
    const { towerHealth } = await import(recoveryPath);
    const { getEmbeddedEnv } = await import(adapterPath);
    const backupPath = '/src/native/backup.ts';
    const { nativeBackupAddress } = await import(backupPath);
    const address = nativeBackupAddress();
    await towerHealth(address);
    const before = await indexedDB.databases();
    const identities: string[] = [];
    let failure = '';
    try {
      await openNativeBrainvault({ name: 'ios-brainvault-e2e-20260913',
        password: 'xln-local-test-2026-only-do-not-fund', factor: 1 },
      (event: { kind: string; runtimeId?: string }) => {
        if (event.kind === 'brainvaultIdentity' && event.runtimeId) identities.push(event.runtimeId);
      });
    } catch (error) { failure = String(error); }
    return { before, after: await indexedDB.databases(), identities, failure, booted: Boolean(getEmbeddedEnv()) };
  });
  expect(evidence.identities).toEqual(['0xb60405a0d5ef0ac5f1c1a7454852bf28a99fa2ee']);
  expect(evidence.failure).toContain('No verified backup could be restored.');
  expect(evidence.after).toEqual(evidence.before);
  expect(evidence.booted).toBe(false);
});

test('native cancellation at recovery discovery never opens or persists a wallet', { tag: '@functional' }, async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/', { waitUntil: 'networkidle' });
  const evidence = await page.evaluate(async () => {
    const nativePath = '/src/native/brainvault.ts';
    const adapterPath = '/src/runtime/adapter.ts';
    const { openNativeBrainvault, cancelNativeBrainvault } = await import(nativePath);
    const { getEmbeddedEnv } = await import(adapterPath);
    const before = await indexedDB.databases();
    let cancelledAtDiscovery = false;
    let failure = '';
    try {
      await openNativeBrainvault({ name: 'ios-cancel-discovery-20260913',
        password: 'local-cancel-test-only-20260913', factor: 1 },
      (event: { kind: string; message?: string }) => {
        if (event.kind === 'progress' && event.message === 'Finding and verifying your encrypted backup…') {
          cancelledAtDiscovery = cancelNativeBrainvault();
        }
      });
    } catch (error) { failure = String(error); }
    return { before, after: await indexedDB.databases(), cancelledAtDiscovery, failure, booted: Boolean(getEmbeddedEnv()), idleCancel: cancelNativeBrainvault() };
  });
  expect(evidence.cancelledAtDiscovery).toBe(true);
  expect(evidence.idleCancel).toBe(false);
  expect(evidence.failure).toContain('BRAINVAULT_ABORTED');
  expect(evidence.after).toEqual(evidence.before);
  expect(evidence.booted).toBe(false);
});

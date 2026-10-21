import { expect, test, type Page } from '../../global-setup.mts';

import { APP_BASE_URL, API_BASE_URL, ensureE2EBaseline, waitForNamedHubs } from '../../utils/e2e-baseline';
import {
  decodeRuntimeAdapterMessage,
  decodeRuntimeAdapterBrowserMessage,
} from '../../../core/api/runtime-adapter/codec';
import { timedStep } from '../../utils/e2e-timing.mts';
import { normalizeWsConnectUrl } from '../../../frontend/src/lib/utils/runtime/wsUrl';

type RuntimeImportCapability = {
  label: string;
  access: 'admin';
  wsUrl: string;
  token: string;
};

const readH1AdminCapability = async (page: Page): Promise<RuntimeImportCapability> => {
  await expect
    .poll(
      async () => {
        const response = await page.request.get(`${API_BASE_URL}/api/runtime-import?access=admin`, {
          headers: { 'Cache-Control': 'no-store' },
          timeout: 5_000,
        });
        if (!response.ok()) return null;
        const payload = (await response.json()) as { manifest?: { entries?: RuntimeImportCapability[] } };
        return payload.manifest?.entries?.find(entry => entry.label.trim().toLowerCase() === 'h1') ?? null;
      },
      { timeout: 60_000 },
    )
    .not.toBeNull();

  const response = await page.request.get(`${API_BASE_URL}/api/runtime-import?access=admin`, {
    headers: { 'Cache-Control': 'no-store' },
  });
  const payload = (await response.json()) as { manifest?: { entries?: RuntimeImportCapability[] } };
  const capability = payload.manifest?.entries?.find(entry => entry.label.trim().toLowerCase() === 'h1');
  if (!capability) throw new Error('BRAINVAULT_REMOTE_H1_CAPABILITY_MISSING');
  expect(capability.access).toBe('admin');
  expect(capability.token).toMatch(/^xlnra1\./);
  return capability;
};

test.setTimeout(5 * 60_000);

test(
  'remote BrainVault keeps the mnemonic on the node and opens account setup without browser export',
  { tag: '@functional' },
  async ({ page }) => {
    await ensureE2EBaseline(page, { requireHubMesh: true, minHubCount: 3 });
    const capability = await readH1AdminCapability(page);
    const hubs = await waitForNamedHubs(page, ['h1'], { apiBaseUrl: API_BASE_URL });
    const nodeOperations: string[] = [];
    let cancelledOwner = '';
    let cancelledReadId = '';
    let cancelledReadAnswered = false;
    const nodeSocketPaths: string[] = [];
    page.on('websocket', socket => {
      nodeSocketPaths.push(new URL(socket.url()).pathname);
      if (socket.url() !== normalizeWsConnectUrl(capability.wsUrl)) return;
      socket.on('framesent', frame => {
        const request = decodeRuntimeAdapterMessage(frame.payload);
        if ('op' in request) nodeOperations.push(request.op);
        if (
          'op' in request &&
          request.op === 'read' &&
          request.path === 'entities' &&
          cancelledOwner &&
          request.query?.entityId === cancelledOwner
        )
          cancelledReadId = request.id;
      });
      socket.on('framereceived', frame => {
        const response =
          typeof frame.payload === 'string'
            ? decodeRuntimeAdapterBrowserMessage(frame.payload)
            : decodeRuntimeAdapterMessage(frame.payload);
        if ('inReplyTo' in response && response.inReplyTo === cancelledReadId) cancelledReadAnswered = true;
      });
    });
    const hash = new URLSearchParams({
      runtime: 'remote',
      ws: capability.wsUrl,
      token: capability.token,
    });
    const remoteUrl = `${APP_BASE_URL}/app#${hash.toString()}`;
    await page.goto(remoteUrl, { waitUntil: 'domcontentloaded' });
    await expect(page.getByLabel('Runtime endpoint', { exact: true })).toBeVisible({ timeout: 30_000 });
    await timedStep('node_vault.connect', () =>
      page.getByRole('button', { name: 'Connect', exact: true }).click({ timeout: 30_000 }),
    );
    await timedStep('node_vault.choose_h1', () =>
      page.getByRole('button', { name: new RegExp(hubs.h1!.slice(0, 18)) }).click({ timeout: 30_000 }),
    );
    await page.waitForFunction(
      () => {
        const adapter = (
          window as typeof window & {
            __xln?: { adapter?: () => { status?: string; authLevel?: string | null } };
          }
        ).__xln?.adapter?.();
        return adapter?.status === 'connected' && adapter.authLevel === 'admin';
      },
      null,
      { timeout: 30_000 },
    );

    await timedStep('node_vault.settings', () =>
      page.locator('[data-testid=nav-settings]:visible').click({ timeout: 30_000 }),
    );
    await timedStep('node_vault.open', () =>
      page.getByRole('button', { name: 'BrainVault on this node', exact: true }).click({ timeout: 30_000 }),
    );
    await page.getByLabel('Vault name public derivation input').fill('remote-e2e-vault');
    await page.getByLabel('Secret passphrase').fill('Remote-e2e-passphrase-42!');
    await timedStep('node_vault.work', () =>
      page.getByLabel('Derivation work', { exact: true }).selectOption('1', { timeout: 10_000 }),
    );

    const estimate = page.getByTestId('brainvault-work-estimate');
    await expect(estimate).toContainText(/Browser benchmark|Initial browser estimate/);
    await expect(
      page.getByText('Browser comparison only. The native node benchmark appears after derivation.'),
    ).toBeVisible();

    const derive = page.getByRole('button', { name: 'Derive on node', exact: true });
    await expect(derive).toBeEnabled({ timeout: 10_000 });
    await derive.click();

    const receipt = page.getByTestId('brainvault-node-ready');
    const failure = page.getByRole('alert');
    await timedStep('node_vault.derive', () => expect(receipt.or(failure).first()).toBeVisible({ timeout: 120_000 }));
    if (await failure.isVisible()) {
      throw new Error(`REMOTE_BRAINVAULT_DERIVATION_FAILED:${await failure.innerText()}`);
    }
    await expect(receipt).toBeVisible({ timeout: 120_000 });
    await expect(receipt).toContainText('Native benchmark');
    await expect(receipt.locator('#node-mnemonic-export')).toHaveCount(0);
    const publicReceipt = await receipt.textContent();
    expect(publicReceipt).toContain('never delivered to this browser');
    await expect(receipt.getByRole('button', { name: 'Show mnemonic', exact: true })).toHaveCount(0);
    const ownerEntity = await receipt.getByTestId('node-vault-entity').innerText();
    expect(ownerEntity).toMatch(/^0x[0-9a-f]{64}$/);
    console.log(
      `NODE_VAULT_OBSERVATION ${JSON.stringify({ socketPaths: nodeSocketPaths, derives: nodeOperations.filter(op => op === 'brainvault-derive').length })}`,
    );
    expect(nodeOperations.filter(op => op === 'brainvault-derive')).toHaveLength(1);
    await expect(receipt.getByRole('button', { name: 'Open node wallet', exact: true })).toBeEnabled();
    // Deliver both clicks in one browser task, before the real remote read can answer.
    // No synthetic response: wait for that exact node response before asserting cancellation.
    cancelledOwner = ownerEntity;
    const cancellation = await page.evaluate(() => {
      const receipt = document.querySelector('[data-testid=brainvault-node-ready]')!;
      const dialog = receipt.closest('dialog')!;
      const open = receipt.querySelector<HTMLButtonElement>('button')!;
      const wasEnabled = !open.disabled;
      open.click();
      dialog.querySelector<HTMLButtonElement>('[data-testid=sheet-close]')!.click();
      return { wasEnabled, dialogConnected: dialog.isConnected };
    });
    console.log(`NODE_VAULT_CANCELLATION ${JSON.stringify(cancellation)}`);
    expect(cancellation.wasEnabled).toBe(true);
    await expect.poll(() => cancelledReadId, { timeout: 5_000 }).not.toBe('');
    await expect.poll(() => cancelledReadAnswered, { timeout: 30_000 }).toBe(true);
    await page.evaluate(
      () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
    expect(
      await page.evaluate(
        () =>
          (
            window as typeof window & { __xln: { store: { getState(): { activeEntityId: string } } } }
          ).__xln.store.getState().activeEntityId,
      ),
    ).toBe(hubs.h1);
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    cancelledOwner = '';
    await page.getByRole('button', { name: 'BrainVault on this node', exact: true }).click();
    await timedStep('node_vault.open_owner', () =>
      receipt.getByRole('button', { name: 'Open node wallet', exact: true }).click({ timeout: 30_000 }),
    );
    await expect(page.getByTestId('home-entity-id')).toHaveText(ownerEntity, { timeout: 30_000 });
    await page.getByTestId('home-open-account').click();
    await expect(page.getByRole('dialog', { name: 'Open account', exact: true })).toBeVisible({ timeout: 30_000 });
    expect(
      await page.evaluate(() =>
        Object.keys(
          (
            window as typeof window & { __xln: { store: { getState(): { sessionSeeds: object } } } }
          ).__xln.store.getState().sessionSeeds,
        ),
      ),
    ).toHaveLength(0);
    expect(nodeOperations.filter(op => op === 'brainvault-derive')).toHaveLength(1);
    expect(nodeOperations).not.toContain('brainvault-reveal');
  },
);

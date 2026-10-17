/**
 * Manage → Ownership creates a self-issued (lazy) entity on this runtime. Its
 * id is the hash of its board, so the wallet's own one-signer board is already
 * taken by the boot entity; a different board (weight 2, threshold 2, still
 * only our signer) forms a new entity that the switcher can open and leave.
 */
import { expect, test, type Page } from '@playwright/test';
import type { RuntimeReplica, XLNModule } from '../../core/api/public/runtime-module';
import { enterStack } from './stack';

type DebugWindow = Window & { __xln?: { env: () => RuntimeReplica | null; xln: () => Promise<XLNModule> } };
const NAME = 'E2E Treasury';

const openOwnership = async (page: Page): Promise<void> => {
  await page.getByTestId('nav-manage').locator('visible=true').first().click();
  await page.getByTestId('manage-ownership').click();
  await expect(page.getByTestId('board')).toBeVisible();
};

/** The signer that boards the active entity, and the lazy id the given board hashes to. */
const readBoard = (page: Page, entityId: string) =>
  page.evaluate(async id => {
    const debug = (window as DebugWindow).__xln;
    const env = debug?.env();
    if (!debug || !env) throw new Error('Formation diagnostics unavailable');
    const replica = Array.from(env.state.eReplicas.values()).find(candidate => candidate.entityId === id);
    if (!replica) throw new Error(`Boot entity replica missing: ${id}`);
    const xln = await debug.xln();
    return {
      signerId: replica.signerId,
      ownLazyId: xln.generateLazyEntityId([{ name: replica.signerId, weight: 1 }], 1n),
      treasuryId: xln.generateLazyEntityId([{ name: replica.signerId, weight: 2 }], 2n),
    };
  }, entityId);

const expectBoard = async (page: Page, board: { entityId: string; signerId: string; weight: number }) => {
  const card = page.getByTestId('board');
  const kv = (label: string) =>
    card
      .locator('.kv')
      .filter({ has: page.locator('.k', { hasText: label }) })
      .locator('.v');
  await expect(kv('Entity').locator('button')).toHaveAttribute('title', `${board.entityId} · tap to copy`);
  await expect(kv('Kind')).toHaveText('Self-issued (its id is the hash of its board)');
  await expect(kv('Threshold')).toHaveText(`${board.weight} of ${board.weight} voting weight`);
  await expect(kv('Signer')).toHaveCount(1);
  await expect(kv('Signer').locator('button')).toHaveAttribute('title', `${board.signerId} · tap to copy`);
  await expect(kv('Signer')).toContainText(`weight ${board.weight}`);
  await expect(kv('Signer').locator('.chip')).toHaveText('you');
  await expect(card).toContainText('Register it on the EntityProvider to issue shares or change owners.');
  // Shares exist only for a registered entity: a lazy one has issued none.
  await expect(page.getByTestId('shares')).toHaveCount(0);
  await expect(page.getByTestId('release-shares')).toHaveCount(0);
};

const expectTakeoverOf = async (page: Page, target: { entityId: string; name: string }) => {
  const takeover = page.getByTestId('takeover');
  const option = takeover.locator('button.mode-card');
  await expect(option).toHaveCount(1);
  await expect(option.locator('.t')).toHaveText(target.name);
  await expect(option.locator('.s')).toHaveText(`${target.entityId.slice(0, 8)}…${target.entityId.slice(-4)}`);
  // Nothing is proposed or activated before a target is chosen.
  await expect(page.getByTestId('takeover-propose')).toBeDisabled();
  await expect(page.getByTestId('takeover-activate')).toBeDisabled();
  await option.click();
  await expect(option).toHaveClass(/active/);
  await expect(page.getByTestId('takeover-propose')).toBeEnabled();
  await expect(page.getByTestId('takeover-activate')).toBeEnabled();
};

test(
  'self-issued entity forms from Ownership, opens in the switcher and switches back',
  { tag: '@functional' },
  async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    const halts: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (/RUNTIME_LOOP_HALTED|RUNTIME_FATAL|apply_input\.failed/.test(message.text()))
        halts.push(message.text().slice(0, 600));
    });
    const wallet = await enterStack(page);
    const board = await readBoard(page, wallet.entityId);
    expect(board.ownLazyId).toBe(wallet.entityId);
    expect(board.treasuryId).not.toBe(wallet.entityId);

    await openOwnership(page);
    await expectBoard(page, { entityId: wallet.entityId, signerId: board.signerId, weight: 1 });
    await expect(page.getByTestId('takeover')).toContainText(
      'Nothing to take over: no other entity in this runtime lists your signer on its board.',
    );
    await expect(page.locator('[data-testid="takeover-propose"], [data-testid="takeover-activate"]')).toHaveCount(0);

    const formation = page.getByTestId('entity-formation');
    await formation.locator('summary').click();
    await page.getByTestId('formation-name').fill(NAME);
    await page.getByTestId('formation-kind').selectOption('lazy');
    await expect(formation).toContainText(
      'No registration transaction. Changing this board produces a different entity id.',
    );
    await expect(page.getByTestId('formation-submit')).toHaveText('Create entity');
    // The default board is this wallet's own one-signer board: that entity already exists.
    await page.getByTestId('formation-submit').click();
    await expect(formation.getByRole('alert')).toHaveText('This board already exists in your wallet.');
    await expect(formation.getByRole('status')).toHaveCount(0);

    await formation.getByRole('checkbox').check();
    await formation.getByLabel('Signer address', { exact: true }).fill(board.signerId);
    await formation.getByLabel('Weight', { exact: true }).fill('2');
    const threshold = formation.getByLabel(/Required voting weight/);
    await expect(threshold).toHaveAccessibleName('Required voting weight · total 2');
    await threshold.fill('2');
    await page.getByTestId('formation-submit').click();
    const created = formation.getByRole('status');
    await expect(created).toContainText('Entity created. Select it in your entity switcher.', { timeout: 15_000 });
    await expect(created.locator('button')).toHaveAttribute('title', `${board.treasuryId} · tap to copy`);
    await expect(formation.getByRole('alert')).toHaveCount(0);
    // Our boot entity now sees another board listing our signer.
    await expectTakeoverOf(page, { entityId: board.treasuryId, name: NAME });

    await page.getByTestId('nav-home').locator('visible=true').first().click();
    const trigger = page.getByTestId('entity-switcher-trigger');
    await expect(trigger).toHaveAttribute('data-entity-id', wallet.entityId);
    await trigger.click();
    const rows = page.getByTestId('entity-switcher-entity');
    // Two boot entities (one per stack jurisdiction) plus the one just formed,
    // served by a Runtime that kept running after the import.
    await expect
      .poll(async () => ({ rows: await rows.count(), halts }), { timeout: 15_000 })
      .toEqual({ rows: 3, halts: [] });
    const treasury = page.locator(`[data-testid="entity-switcher-entity"][data-entity-id="${board.treasuryId}"]`);
    // The row title is the avatar initial followed by the entity label.
    await expect(treasury.locator('.t')).toHaveText(`${NAME.slice(0, 1).toUpperCase()}${NAME}`);
    await expect(treasury).toHaveAttribute('aria-selected', 'false');
    await expect(
      page.locator(`[data-testid="entity-switcher-entity"][data-entity-id="${wallet.entityId}"]`),
    ).toHaveAttribute('aria-selected', 'true');
    await treasury.click();
    await expect(trigger).toHaveAttribute('data-entity-id', board.treasuryId, { timeout: 15_000 });
    await expect(trigger).toContainText(NAME);
    await expect(page.getByTestId('home-entity-id')).toHaveText(board.treasuryId);

    await openOwnership(page);
    await expectBoard(page, { entityId: board.treasuryId, signerId: board.signerId, weight: 2 });
    const bootName = await page.getByTestId('takeover').locator('button.mode-card .t').innerText();
    expect(bootName.length).toBeGreaterThan(0);
    await expectTakeoverOf(page, { entityId: wallet.entityId, name: bootName });

    await page.getByTestId('nav-home').locator('visible=true').first().click();
    await trigger.click();
    await expect(rows).toHaveCount(3);
    await page.locator(`[data-testid="entity-switcher-entity"][data-entity-id="${wallet.entityId}"]`).click();
    await expect(trigger).toHaveAttribute('data-entity-id', wallet.entityId, { timeout: 15_000 });
    await expect(page.getByTestId('home-entity-id')).toHaveText(wallet.entityId);
    await expect(page.getByTestId('account-row').first()).toBeVisible();
    await openOwnership(page);
    await expectBoard(page, { entityId: wallet.entityId, signerId: board.signerId, weight: 1 });
    expect(errors).toEqual([]);
    expect(halts).toEqual([]);
  },
);

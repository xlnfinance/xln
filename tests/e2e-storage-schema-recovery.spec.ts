import { Wallet } from 'ethers';
import { decodeBinaryPayload, encodeBinaryPayload } from '../runtime/storage/binary-codec';
import { STORAGE_SCHEMA_VERSION } from '../runtime/storage/keys';
import { expect, test, type Page } from './global-setup';

type BrowserIssue = {
  type: 'console' | 'pageerror' | 'requestfailed' | 'http';
  message: string;
};

const mutateAuthoritativeStorageHeadToLegacySchema = async (
  page: Page,
  runtimeId: string,
): Promise<{ databaseName: string; before: number; after: number }> => {
  const currentBytes = await page.evaluate(async id => {
    const location = `db-${id}-frames`;
    const databaseName = `level-js-${location}`;
    const open = indexedDB.open(databaseName, 1);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error ?? new Error(`STORAGE_SCHEMA_E2E_DB_OPEN_FAILED:${databaseName}`));
    });

    try {
      const transaction = db.transaction(location, 'readwrite');
      const store = transaction.objectStore(location);
      const headKey = new Uint8Array([0x20]);
      const get = store.get(headKey);
      const raw = await new Promise<unknown>((resolve, reject) => {
        get.onsuccess = () => resolve(get.result);
        get.onerror = () => reject(get.error ?? new Error('STORAGE_SCHEMA_E2E_HEAD_READ_FAILED'));
      });
      if (!(raw instanceof ArrayBuffer) && !ArrayBuffer.isView(raw)) {
        throw new Error(`STORAGE_SCHEMA_E2E_HEAD_BYTES_INVALID:${Object.prototype.toString.call(raw)}`);
      }
      const bytes =
        raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
      return { databaseName, bytes: Array.from(bytes) };
    } finally {
      db.close();
    }
  }, runtimeId);

  const head = decodeBinaryPayload<Record<string, unknown>>(Uint8Array.from(currentBytes.bytes));
  const before = Number(head['schemaVersion']);
  if (before !== STORAGE_SCHEMA_VERSION) {
    throw new Error(`STORAGE_SCHEMA_E2E_CURRENT_HEAD_REQUIRED:${before}`);
  }
  const encoded = Array.from(encodeBinaryPayload({ ...head, schemaVersion: 1 }, 'msgpack'));
  await page.evaluate(async ({ id, bytes }) => {
    const location = `db-${id}-frames`;
    const databaseName = `level-js-${location}`;
    const open = indexedDB.open(databaseName, 1);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error ?? new Error(`STORAGE_SCHEMA_E2E_DB_OPEN_FAILED:${databaseName}`));
    });
    try {
      const transaction = db.transaction(location, 'readwrite');
      transaction.objectStore(location).put(Uint8Array.from(bytes), new Uint8Array([0x20]));
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error ?? new Error('STORAGE_SCHEMA_E2E_HEAD_WRITE_ABORTED'));
        transaction.onerror = () => reject(transaction.error ?? new Error('STORAGE_SCHEMA_E2E_HEAD_WRITE_FAILED'));
      });
    } finally {
      db.close();
    }
  }, { id: runtimeId, bytes: encoded });
  return { databaseName: currentBytes.databaseName, before, after: 1 };
};

const readPersistedStorageSchema = async (page: Page, runtimeId: string): Promise<number> => {
  const bytes = await page.evaluate(async id => {
    const location = `db-${id}-frames`;
    const databaseName = `level-js-${location}`;
    const open = indexedDB.open(databaseName, 1);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error ?? new Error(`STORAGE_SCHEMA_E2E_DB_REOPEN_FAILED:${databaseName}`));
    });
    try {
      const transaction = db.transaction(location, 'readonly');
      const get = transaction.objectStore(location).get(new Uint8Array([0x20]));
      const raw = await new Promise<unknown>((resolve, reject) => {
        get.onsuccess = () => resolve(get.result);
        get.onerror = () => reject(get.error ?? new Error('STORAGE_SCHEMA_E2E_HEAD_REREAD_FAILED'));
      });
      if (!(raw instanceof ArrayBuffer) && !ArrayBuffer.isView(raw)) {
        throw new Error('STORAGE_SCHEMA_E2E_HEAD_REREAD_BYTES_INVALID');
      }
      const bytes =
        raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
      return Array.from(bytes);
    } finally {
      db.close();
    }
  }, runtimeId);
  return Number(decodeBinaryPayload<{ schemaVersion: unknown }>(Uint8Array.from(bytes)).schemaVersion);
};

test.describe('Storage schema recovery', () => {
  test('legacy wallet storage fails closed and offers authenticated recovery before reset', { tag: '@resilience' }, async ({
    page,
  }, testInfo) => {
    test.setTimeout(5 * 60_000);
    const issues: BrowserIssue[] = [];
    page.on('console', message => {
      if (message.type() === 'error' || message.type() === 'warning') {
        issues.push({ type: 'console', message: message.text() });
      }
    });
    page.on('pageerror', error => issues.push({ type: 'pageerror', message: error.message }));
    page.on('requestfailed', request => {
      const message = request.failure()?.errorText ?? 'request failed';
      if (message !== 'net::ERR_ABORTED') issues.push({ type: 'requestfailed', message });
    });
    page.on('response', response => {
      if (response.status() >= 400) issues.push({ type: 'http', message: `${response.status()} ${response.url()}` });
    });

    await page.goto('/app');
    await expect.poll(() => page.evaluate(() => typeof window.__xln?.vault?.createRuntime)).toBe('function');
    const mnemonic = Wallet.createRandom().mnemonic?.phrase;
    if (!mnemonic) throw new Error('STORAGE_SCHEMA_E2E_MNEMONIC_GENERATION_FAILED');
    const runtimeId = await page.evaluate(
      async ({ seed }) => {
        const operations = window.__xln?.vault;
        if (typeof operations?.createRuntime !== 'function') {
          throw new Error('STORAGE_SCHEMA_E2E_CREATE_RUNTIME_MISSING');
        }
        const runtime = (await operations.createRuntime('schema-recovery-e2e', seed, {
          loginType: 'manual',
          requiresOnboarding: false,
          skipRecoveryRestore: true,
          recovery: { useDefaultTowers: false, towers: [] },
        })) as { id?: unknown };
        const id = String(runtime.id ?? '').toLowerCase();
        if (!/^0x[0-9a-f]{40}$/.test(id)) throw new Error(`STORAGE_SCHEMA_E2E_RUNTIME_ID_INVALID:${id}`);
        if (typeof operations.suspendAllRuntimeActivity !== 'function') {
          throw new Error('STORAGE_SCHEMA_E2E_SUSPEND_MISSING');
        }
        await operations.suspendAllRuntimeActivity();
        return id;
      },
      { seed: mnemonic },
    );

    expect(issues).toEqual([]);
    const mutation = await mutateAuthoritativeStorageHeadToLegacySchema(page, runtimeId);
    expect(mutation).toEqual({
      databaseName: `level-js-db-${runtimeId}-frames`,
      before: STORAGE_SCHEMA_VERSION,
      after: 1,
    });

    issues.length = 0;
    await page.reload({ waitUntil: 'domcontentloaded' });
    const errorScreen = page.getByTestId('app-initialization-error');
    await expect(errorScreen).toBeVisible({ timeout: 30_000 });
    await expect(errorScreen.getByRole('heading', { name: 'Local runtime needs recovery' })).toBeVisible();
    await expect(errorScreen).toContainText('storage schema 1');
    await expect(errorScreen).toContainText(`requires schema ${STORAGE_SCHEMA_VERSION}`);
    await expect(errorScreen).toContainText('No incompatible data was applied or deleted');
    await expect(page.getByTestId('storage-schema-recover')).toBeVisible();
    await expect(page.getByTestId('storage-schema-reset')).toBeVisible();

    for (const [name, width, height] of [
      ['wide', 1920, 1080],
      ['laptop', 1440, 900],
      ['mobile', 390, 844],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.screenshot({ path: testInfo.outputPath(`storage-schema-recovery-${name}.png`), fullPage: true });
    }

    await page.getByTestId('storage-schema-recover').click();
    const recoveryError = page.getByTestId('storage-schema-recovery-error');
    await expect(recoveryError).toContainText(`STORAGE_SCHEMA_RECOVERY_BACKUP_NOT_FOUND:${runtimeId}`, {
      timeout: 30_000,
    });
    expect(await readPersistedStorageSchema(page, runtimeId)).toBe(1);

    page.once('dialog', async dialog => dialog.dismiss());
    await page.getByTestId('storage-schema-reset').click();
    await expect(errorScreen).toBeVisible();
    expect(await readPersistedStorageSchema(page, runtimeId)).toBe(1);

    const resetComplete = page.waitForEvent('load').catch(() => undefined);
    page.once('dialog', async dialog => dialog.accept());
    await page.getByTestId('storage-schema-reset').click();
    await resetComplete;
    await expect(page.getByRole('heading', { name: 'Create xln wallet' })).toBeVisible({ timeout: 30_000 });

    expect(issues.filter(issue => issue.type !== 'console')).toEqual([]);
    expect(
      issues.filter(issue => issue.type === 'console' && !issue.message.includes('STORAGE_SCHEMA_MISMATCH')),
    ).toEqual([]);
  });
});

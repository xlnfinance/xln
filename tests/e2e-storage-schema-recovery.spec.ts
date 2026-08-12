import { Wallet } from 'ethers';
import { decodeBinaryPayload, encodeBinaryPayload } from '../runtime/storage/codec/binary-codec';
import { STORAGE_SCHEMA_VERSION } from '../runtime/storage/keys';
import { allowBrowserIssue, expect, test, type Page } from './global-setup.mts';

type BrowserIssue = {
  type: 'console' | 'pageerror' | 'requestfailed' | 'http';
  message: string;
};

const INCOMPATIBLE_STORAGE_SCHEMA_VERSION = STORAGE_SCHEMA_VERSION + 1;

const mutateAuthoritativeStorageHeadToIncompatibleSchema = async (
  page: Page,
  runtimeId: string,
): Promise<{ databaseName: string; before: number; after: number }> => {
  const currentBytes = await page.evaluate(async id => {
    const location = `db-${id}-wal`;
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
  const encoded = Array.from(
    encodeBinaryPayload({ ...head, schemaVersion: INCOMPATIBLE_STORAGE_SCHEMA_VERSION }, 'msgpack'),
  );
  await page.evaluate(async ({ id, bytes }) => {
    const location = `db-${id}-wal`;
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
  return {
    databaseName: currentBytes.databaseName,
    before,
    after: INCOMPATIBLE_STORAGE_SCHEMA_VERSION,
  };
};

const readPersistedStorageSchema = async (page: Page, runtimeId: string): Promise<number> => {
  const bytes = await page.evaluate(async id => {
    const location = `db-${id}-wal`;
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
  test('incompatible wallet storage fails closed and offers authenticated recovery before reset', { tag: '@resilience' }, async ({
    page,
  }, testInfo) => {
    test.setTimeout(5 * 60_000);
    for (const message of [
      /runtime_wal\.open_failed .*STORAGE_SCHEMA_MISMATCH/,
      /load_env_from_db\.failed .*STORAGE_SCHEMA_MISMATCH/,
    ]) {
      allowBrowserIssue({ type: 'console', severity: 'error', message });
    }
    const issues: BrowserIssue[] = [];
    const observeBrowserIssues = (target: Page): void => {
      target.on('console', message => {
        if (message.type() === 'error' || message.type() === 'warning') {
          issues.push({ type: 'console', message: message.text() });
        }
      });
      target.on('pageerror', error => issues.push({ type: 'pageerror', message: error.message }));
      target.on('requestfailed', request => {
        const message = request.failure()?.errorText ?? 'request failed';
        if (message !== 'net::ERR_ABORTED') issues.push({ type: 'requestfailed', message });
      });
      target.on('response', response => {
        if (response.status() >= 400) issues.push({ type: 'http', message: `${response.status()} ${response.url()}` });
      });
    };
    observeBrowserIssues(page);

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
    await expect
      .poll(() =>
        page.evaluate(() => {
          const snapshot = window.__xln?.liveRuntimeSnapshot as
            | { runtimeId?: unknown; dbNamespace?: unknown }
            | undefined;
          return {
            runtimeId: String(snapshot?.runtimeId ?? '').toLowerCase(),
            dbNamespace: String(snapshot?.dbNamespace ?? '').toLowerCase(),
          };
        }),
      )
      .toEqual({ runtimeId, dbNamespace: runtimeId });

    expect(issues).toEqual([]);
    // A separate page guarantees a new JS realm and no retained Runtime/Level
    // handles. A content-type navigation is insufficient: browsers may keep the
    // original document alive when they treat that response as a download.
    const recoveryPage = await page.context().newPage();
    observeBrowserIssues(recoveryPage);
    await recoveryPage.route('**/storage-fault-injection', route =>
      route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>storage fault injection</title>' }),
    );
    await page.close();
    await recoveryPage.goto('/storage-fault-injection', { waitUntil: 'domcontentloaded' });
    const mutation = await mutateAuthoritativeStorageHeadToIncompatibleSchema(recoveryPage, runtimeId);
    expect(mutation).toEqual({
      databaseName: `level-js-db-${runtimeId}-wal`,
      before: STORAGE_SCHEMA_VERSION,
      after: INCOMPATIBLE_STORAGE_SCHEMA_VERSION,
    });
    expect(await readPersistedStorageSchema(recoveryPage, runtimeId)).toBe(INCOMPATIBLE_STORAGE_SCHEMA_VERSION);

    issues.length = 0;
    await recoveryPage.goto('/app', { waitUntil: 'domcontentloaded' });
    await expect
      .poll(() => readPersistedStorageSchema(recoveryPage, runtimeId))
      .toBe(INCOMPATIBLE_STORAGE_SCHEMA_VERSION);
    const errorScreen = recoveryPage.getByTestId('app-initialization-error');
    await expect(errorScreen).toBeVisible({ timeout: 30_000 });
    await expect(errorScreen.getByRole('heading', { name: 'Local runtime needs recovery' })).toBeVisible();
    await expect(errorScreen).toContainText(`storage schema ${INCOMPATIBLE_STORAGE_SCHEMA_VERSION}`);
    await expect(errorScreen).toContainText(`requires schema ${STORAGE_SCHEMA_VERSION}`);
    await expect(errorScreen).toContainText('No incompatible data was applied or deleted');
    await expect(recoveryPage.getByTestId('storage-schema-recover')).toBeVisible();
    await expect(recoveryPage.getByTestId('storage-schema-reset')).toBeVisible();

    for (const [name, width, height] of [
      ['wide', 1920, 1080],
      ['laptop', 1440, 900],
      ['mobile', 390, 844],
    ] as const) {
      await recoveryPage.setViewportSize({ width, height });
      await recoveryPage.screenshot({ path: testInfo.outputPath(`storage-schema-recovery-${name}.png`), fullPage: true });
    }

    await recoveryPage.getByTestId('storage-schema-recover').click();
    const recoveryError = recoveryPage.getByTestId('storage-schema-recovery-error');
    await expect(recoveryError).toContainText(`STORAGE_SCHEMA_RECOVERY_BACKUP_NOT_FOUND:${runtimeId}`, {
      timeout: 30_000,
    });
    expect(await readPersistedStorageSchema(recoveryPage, runtimeId)).toBe(INCOMPATIBLE_STORAGE_SCHEMA_VERSION);

    recoveryPage.once('dialog', async dialog => dialog.dismiss());
    await recoveryPage.getByTestId('storage-schema-reset').click();
    await expect(errorScreen).toBeVisible();
    expect(await readPersistedStorageSchema(recoveryPage, runtimeId)).toBe(INCOMPATIBLE_STORAGE_SCHEMA_VERSION);

    const resetComplete = recoveryPage.waitForEvent('load').catch(() => undefined);
    recoveryPage.once('dialog', async dialog => dialog.accept());
    await recoveryPage.getByTestId('storage-schema-reset').click();
    await resetComplete;
    await expect(recoveryPage.getByRole('heading', { name: 'Create xln wallet' })).toBeVisible({ timeout: 30_000 });

    expect(issues.filter(issue => issue.type !== 'console')).toEqual([]);
    expect(
      issues.filter(issue => issue.type === 'console' && !issue.message.includes('STORAGE_SCHEMA_MISMATCH')),
    ).toEqual([]);
  });
});

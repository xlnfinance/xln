import { createWalletIdentity, LOCAL_PASSWORD, waitForWalletBoot } from '../../../ui/tests/wallet-ui';
import { gotoApp, selectDemoMnemonic } from '../../utils/e2e-demo-users';
import { decodeBinaryPayload, encodeBinaryPayload } from '../../../core/protocol/serialization/binary-codec';
import { STORAGE_SCHEMA_VERSION } from '../../../core/storage/keys';
import { allowBrowserIssue, expect, test, type Page } from '../../global-setup.mts';
import type { RuntimeReplica, XLNModule } from '../../../core/api/public/runtime-module';
import { timedStep } from '../../utils/e2e-timing.mts';

type BrowserIssue = {
  type: 'console' | 'pageerror' | 'requestfailed' | 'http';
  message: string;
};

const INCOMPATIBLE_STORAGE_SCHEMA_VERSION = STORAGE_SCHEMA_VERSION - 1;

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
  await page.evaluate(
    async ({ id, bytes }) => {
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
    },
    { id: runtimeId, bytes: encoded },
  );
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

test.describe('Canonical storage schema rejection', () => {
  test(
    'rejects obsolete storage and regenerates current data only after explicit testnet reset',
    { tag: '@resilience' },
    async ({ page }, testInfo) => {
      test.setTimeout(55_000);
      // Unlock no longer re-verifies the WAL when it opens; the schema boundary rejects
      // the obsolete head once, when the Runtime loads it.
      for (const message of [
        new RegExp(
          `load_env_from_db\\.failed .*STORAGE_SCHEMA_MISMATCH:stored=${INCOMPATIBLE_STORAGE_SCHEMA_VERSION}:current=${STORAGE_SCHEMA_VERSION}:boundary=storage-head`,
        ),
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
          if (response.status() >= 400)
            issues.push({ type: 'http', message: `${response.status()} ${response.url()}` });
        });
      };
      observeBrowserIssues(page);

      await gotoApp(page);
      const { runtimeId, entityId } = await createWalletIdentity(page, 'schema-rejection', selectDemoMnemonic('alice'));
      await page.getByTestId('nav-settings').first().click();
      await page.getByRole('button', { name: 'Lock', exact: true }).click();
      await expect(page.getByRole('button', { name: /Continue/ })).toBeVisible();

      expect(issues).toEqual([]);
      // A separate page guarantees a new JS realm and no retained Runtime/Level
      // handles. A content-type navigation is insufficient: browsers may keep the
      // original document alive when they treat that response as a download.
      const recoveryPage = await page.context().newPage();
      observeBrowserIssues(recoveryPage);
      await page
        .context()
        .route('**/storage-fault-injection', route =>
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
      await gotoApp(recoveryPage);
      await recoveryPage.getByRole('button', { name: /Continue/ }).click();
      await recoveryPage.getByLabel('Password', { exact: true }).fill(LOCAL_PASSWORD);
      await recoveryPage.getByRole('button', { name: 'Unlock', exact: true }).click();
      await expect
        .poll(() => readPersistedStorageSchema(recoveryPage, runtimeId))
        .toBe(INCOMPATIBLE_STORAGE_SCHEMA_VERSION);
      const errorScreen = recoveryPage.getByRole('alert');
      await expect(errorScreen).toHaveText(
        `STORAGE_SCHEMA_MISMATCH:stored=${INCOMPATIBLE_STORAGE_SCHEMA_VERSION}:current=${STORAGE_SCHEMA_VERSION}:boundary=storage-head`,
      );
      await expect(recoveryPage.getByTestId('nav-home')).toHaveCount(0);
      await expect(recoveryPage.getByTestId('storage-schema-recover')).toHaveCount(0);
      expect(await readPersistedStorageSchema(recoveryPage, runtimeId)).toBe(INCOMPATIBLE_STORAGE_SCHEMA_VERSION);

      for (const [name, width, height] of [
        ['wide', 1920, 1080],
        ['laptop', 1440, 900],
        ['mobile', 390, 844],
      ] as const) {
        await recoveryPage.setViewportSize({ width, height });
        await recoveryPage.screenshot({
          path: testInfo.outputPath(`storage-schema-recovery-${name}.png`),
          fullPage: true,
        });
      }

      // Disposable testnet policy: the operator deletes only this stopped Runtime's
      // obsolete stores. This is an explicit browser database operation, not a
      // wallet migration/rescue path. Closing the realm releases every Level handle.
      const resetPage = await recoveryPage.context().newPage();
      observeBrowserIssues(resetPage);
      await recoveryPage.close();
      await resetPage.goto('/storage-fault-injection', { waitUntil: 'domcontentloaded' });
      const reset = await resetPage.evaluate(async id => {
        const prefix = `level-js-db-${id}-`;
        const allowed = new Set(
          ['wal', 'storage-current', 'storage-previous', 'infra', 'history-views'].map(suffix => prefix + suffix),
        );
        const before = (await indexedDB.databases())
          .map(db => db.name)
          .filter((name): name is string => typeof name === 'string')
          .sort();
        const owned = before.filter(name => name.startsWith(prefix));
        if (!owned.includes(prefix + 'wal') || owned.some(name => !allowed.has(name))) {
          throw new Error(`STORAGE_SCHEMA_RESET_UNEXPECTED_STORES:${JSON.stringify(owned)}`);
        }
        const credentials = Object.entries(localStorage).sort(([a], [b]) => a.localeCompare(b));
        if (!localStorage.getItem(`xln-password-vault:${id}`))
          throw new Error('STORAGE_SCHEMA_RESET_PASSWORD_VAULT_MISSING');
        for (const name of owned)
          await new Promise<void>((resolve, reject) => {
            const request = indexedDB.deleteDatabase(name);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error ?? new Error(`STORAGE_SCHEMA_RESET_FAILED:${name}`));
            request.onblocked = () => reject(new Error(`STORAGE_SCHEMA_RESET_ACTIVE_HANDLE:${name}`));
          });
        const after = (await indexedDB.databases())
          .map(db => db.name)
          .filter((name): name is string => typeof name === 'string')
          .sort();
        const expected = before.filter(name => !owned.includes(name));
        if (JSON.stringify(after) !== JSON.stringify(expected))
          throw new Error('STORAGE_SCHEMA_RESET_UNRELATED_STORE_CHANGED');
        if (
          JSON.stringify(credentials) !==
          JSON.stringify(Object.entries(localStorage).sort(([a], [b]) => a.localeCompare(b)))
        ) {
          throw new Error('STORAGE_SCHEMA_RESET_CREDENTIALS_CHANGED');
        }
        return { deleted: owned, preserved: after, credentialsPreserved: true };
      }, runtimeId);
      await testInfo.attach('explicit-testnet-reset', { body: JSON.stringify(reset), contentType: 'application/json' });
      await gotoApp(resetPage);
      await resetPage.getByRole('button', { name: /Continue/ }).click();
      await resetPage.getByLabel('Password', { exact: true }).fill('wrong-password');
      await resetPage.getByRole('button', { name: 'Unlock', exact: true }).click();
      await expect(resetPage.getByRole('alert')).toContainText('Incorrect password');
      await expect(resetPage.getByTestId('nav-home')).toHaveCount(0);
      await resetPage.getByLabel('Password', { exact: true }).fill(LOCAL_PASSWORD);
      await resetPage.evaluate(() => {
        const started = performance.now();
        const stages: Array<{ elapsedMs: number; stage: string }> = [];
        const capture = () => {
          const stage =
            document.querySelector('button[type=submit]')?.textContent ??
            document.querySelector('main [role=status]')?.textContent ??
            (document.querySelector('[data-testid=home-entity-id]') ? 'Home' : 'Opening');
          if (stages.at(-1)?.stage !== stage)
            stages.push({ elapsedMs: Math.round(performance.now() - started), stage });
        };
        const observer = new MutationObserver(capture);
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        (window as Window & { __storageUnlockStages?: typeof stages }).__storageUnlockStages = stages;
        capture();
      });
      await timedStep('storage_schema.regenerated_unlock', async () => {
        await resetPage.getByRole('button', { name: 'Unlock', exact: true }).click();
        try {
          // Use the same boot boundary as wallet import, still bounded by this 55s test.
          // Asset loading then has the unchanged 5s Home identity assertion deadline.
          await waitForWalletBoot(resetPage);
          await expect(resetPage.getByTestId('home-entity-id')).toHaveText(entityId);
        } finally {
          const state = await resetPage.evaluate(async () => {
            const debug = (window as Window & { __xln: { env(): RuntimeReplica | null; xln(): Promise<XLNModule> } })
              .__xln;
            const env = debug.env();
            if (!env) return { runtimePresent: false };
            const xln = await debug.xln();
            return {
              stages: (window as Window & { __storageUnlockStages?: Array<{ elapsedMs: number; stage: string }> })
                .__storageUnlockStages,
              relayConnected: env.infrastructure?.p2p?.isConnected() ?? false,
              runtimeHeight: env.state.height,
              halted: env.infrastructure?.halted ?? false,
              runtimeInputs: env.runtimeMempool.entityInputs.map(input => ({
                entityId: input.entityId,
                txs: input.entityTxs?.map(tx => tx.type),
              })),
              entities: [...env.state.eReplicas.values()].map(replica => {
                const adapter = xln.getEntityJAdapter(env, replica.entityId, replica.signerId);
                return {
                  entityId: replica.entityId,
                  height: replica.state.height,
                  pending: replica.mempool.map(tx => tx.type),
                  proposalHeight: replica.proposal?.height ?? null,
                  scan: adapter?.getWatcherScanProgress?.(),
                  accounts: [...replica.state.accounts.values()].map(account => ({
                    height: account.currentHeight,
                    pendingHeight: account.pendingFrame?.height ?? null,
                  })),
                };
              }),
            };
          });
          await testInfo.attach('regenerated-unlock-boundary', {
            body: JSON.stringify(state),
            contentType: 'application/json',
          });
          console.info('[storage_schema.regenerated_unlock]', JSON.stringify(state));
        }
      });
      await expect.poll(() => readPersistedStorageSchema(resetPage, runtimeId)).toBe(STORAGE_SCHEMA_VERSION);

      expect(issues.filter(issue => issue.message.includes('STORAGE_SCHEMA_MISMATCH'))).toHaveLength(1);
      expect(issues.filter(issue => issue.type !== 'console')).toEqual([]);
      expect(
        issues.filter(issue => issue.type === 'console' && !issue.message.includes('STORAGE_SCHEMA_MISMATCH')),
      ).toEqual([]);
    },
  );
});

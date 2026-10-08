import { expect, test } from 'bun:test';
import { safeStringify } from '../../../protocol/serialization';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitForRuntimeImportManifest } from '../../../scripts/operations/production/browser/wallet-gate';
import { createRuntimeImportManifest } from '../../../orchestrator/replica-import/runtime-import-manifest';

const manifest = () => ({
  importUrl: 'http://localhost/app',
  manifest: createRuntimeImportManifest([{
    label: 'H1', engine: 'rust', wsUrl: 'ws://127.0.0.1:18000/rpc',
    authSeed: 'readiness-real-capability', audience: `0x${'11'.repeat(20)}`, keyId: 'h1',
  }], 60_000),
});

test('wallet waits for the controller manifest publication, not general system health', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xln-wallet-readiness-'));
  const path = join(dir, 'manifest.json');
  try {
    let ready = false;
    const waiting = waitForRuntimeImportManifest(path).then(() => { ready = true; });
    await Promise.resolve();
    expect(ready).toBe(false);
    writeFileSync(path, safeStringify(manifest()));
    await waiting;
    expect(ready).toBe(true);
    writeFileSync(path, '{}');
    await expect(waitForRuntimeImportManifest(path)).rejects.toThrow('PRODUCTION_SWAP_LOAD_MANIFEST_FIELDS_INVALID');
    const expired = manifest();
    expired.manifest!.expiresAt = 1;
    writeFileSync(path, safeStringify(expired));
    await expect(waitForRuntimeImportManifest(path)).rejects.toThrow('WALLET_IMPORT_MANIFEST_EXPIRED');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

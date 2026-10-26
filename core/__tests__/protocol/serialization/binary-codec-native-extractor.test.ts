import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'url';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

/**
 * E2E run 17 shard 63: H1 failed its height-1 commit read-back with
 * STORAGE_RUNTIME_MACHINE_LEAF_PATH_2_KIND although the stored bytes were
 * canonical. The bare `msgpackr` Bun entry loads msgpackr-extract; each Account
 * worker isolate that loads it clears one process-global token table, and a
 * racing main-thread string extraction skipped the 0x48 hex Map key, returning
 * a shifted `kind`. A fresh hub import graph must leave that decoder disabled.
 */
describe('binary codec decoder', () => {
  test('hub storage, Account and dispute graphs never enable the native string extractor', () => {
    const probe = [
      "await import('./core/storage/index.ts');",
      "await import('./core/runtime/workers/account/provider.ts');",
      "await import('./core/protocol/dispute/proof-builder.ts');",
      "const { isNativeAccelerationEnabled } = await import('msgpackr/pack');",
      'console.log(`native=${isNativeAccelerationEnabled}`);',
    ].join('\n');
    const result = Bun.spawnSync([process.execPath, '-e', probe], { cwd: repoRoot });
    expect(result.stderr.toString()).toBe('');
    expect(result.stdout.toString().trim()).toBe('native=false');
  });
});

import { expect, test } from 'bun:test';
import { safeStringify } from '../../../protocol/serialization';

const poolUrl = new URL('../../../protocol/crypto/crypto-pool.ts', import.meta.url).href;
const primingUrl = new URL('../../../runtime/admit/ingress-priming.ts', import.meta.url).href;

test('a malformed queued input never escapes ingress priming as an uncaught exception', () => {
  // Priming runs from a timer with a live crypto pool. A malformed
  // accountInput threw there; the server's uncaughtException handler exits
  // the whole process, taking every Runtime in it down.
  const child = Bun.spawnSync({
    cmd: [process.execPath, '--eval', `
      import { configureCryptoPoolEntry } from ${safeStringify(poolUrl)};
      import { primeEntityInputsAtIngress } from ${safeStringify(primingUrl)};
      configureCryptoPoolEntry(new URL(${safeStringify(poolUrl)}));
      // The API server's handler (core/api/server/index.ts) exits like this.
      process.on('uncaughtException', () => process.exit(1));
      const env = { state: { eReplicas: new Map() } };
      primeEntityInputsAtIngress(env, [{
        entityId: '0x${'11'.repeat(32)}',
        signerId: '0x${'22'.repeat(20)}',
        entityTxs: [{ type: 'accountInput', data: null }],
      }]);
      await new Promise(resolve => setTimeout(resolve, 50));
      console.log('PRIMING_ALIVE');
      process.exit(0);
    `],
    cwd: process.cwd(),
    env: { ...process.env, XLN_CRYPTO_POOL_WORKERS: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 10_000,
  });
  expect(child.stdout.toString()).toContain('PRIMING_ALIVE');
  expect(child.exitCode).toBe(0);
});

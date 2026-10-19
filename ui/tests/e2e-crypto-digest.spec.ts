import { expect, test } from '@playwright/test';
import { SigningKey, concat, toBeHex } from 'ethers';
import { enterStack } from './stack';

// A public test vector, never an owner or operator credential.
const privateKey = `0x${'00'.repeat(31)}01`;
const digests = [`0x${'00'.repeat(32)}`, `0x${'ff'.repeat(32)}`, `0x${'01'.repeat(32)}`];

async function probe(moduleUrl: string) {
  const runtime: typeof import('../../core/api/public/browser') = await import(moduleUrl);
  const env = { runtimeSeed: 'portable-digest-regression', quietRuntimeLogs: true };
  const signer = '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf';
  const key = new Uint8Array(32);
  key[31] = 1;
  runtime.registerSignerKey(env, signer, key);
  const digests = [`0x${'00'.repeat(32)}`, `0x${'ff'.repeat(32)}`, `0x${'01'.repeat(32)}`];
  return digests.map(digest => {
    const signature = runtime.signAccountFrame(env, signer, digest);
    return {
      signature,
      valid: runtime.verifyAccountSignature(env, signer, digest, signature),
      wrongDigest: runtime.verifyAccountSignature(env, signer, `0x${'ab'.repeat(32)}`, signature),
      invalidRecovery: runtime.verifyAccountSignature(env, signer, digest, `${signature.slice(0, -2)}02`),
      zeroSignature: runtime.verifyAccountSignature(env, signer, digest, `0x${'00'.repeat(65)}`),
    };
  });
}

test(
  'current browser window and real web worker preserve raw digest signature bytes',
  { tag: '@functional' },
  async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    // Exercise the bundle selected by the real wallet loader at this stand's base.
    // Importing a guessed /ui path only tests one host configuration.
    const [runtimeResponse] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/runtime.js')),
      enterStack(page),
    ]);
    expect(runtimeResponse.status()).toBe(200);
    expect(runtimeResponse.headers()['content-type']).toContain('javascript');
    const moduleUrl = runtimeResponse.url();
    const windowResult = await page.evaluate(probe, moduleUrl);
    const workerResult = await page.evaluate(
      async ({ source, moduleUrl }) => {
        const code = `const probe = ${source}; probe(${JSON.stringify(moduleUrl)}).then(result => postMessage({ ok: true, result }), error => postMessage({ ok: false, error: String(error.stack || error) }));`;
        const blob = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
        const worker = new Worker(blob, { type: 'module' });
        try {
          return await new Promise((resolve, reject) => {
            worker.onmessage = event => {
              if (event.data.ok === true) resolve(event.data.result);
              else reject(new Error(event.data.error));
            };
            worker.onerror = event => reject(new Error(event.message));
          });
        } finally {
          worker.terminate();
          URL.revokeObjectURL(blob);
        }
      },
      { source: probe.toString(), moduleUrl },
    );
    const key = new SigningKey(privateKey);
    const expected = digests.map(digest => {
      const signed = key.sign(digest);
      return {
        signature: concat([signed.r, signed.s, toBeHex(signed.yParity, 1)]),
        valid: true,
        wrongDigest: false,
        invalidRecovery: false,
        zeroSignature: false,
      };
    });
    expect(windowResult).toEqual(expected);
    expect(workerResult).toEqual(expected);
    expect(errors).toEqual([]);
  },
);

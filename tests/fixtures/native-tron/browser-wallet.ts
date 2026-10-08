import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { computeRepositoryCodeFingerprint } from '../../../core/qa/tools/code-fingerprint';
import { chromium, expect } from '@playwright/test';

const root = process.cwd();
const sourceBefore = computeRepositoryCodeFingerprint({ root });
const bundle = Bun.spawn(['bun', 'run', 'build'], { cwd: root, stdout: 'inherit', stderr: 'inherit' });
assert.equal(await bundle.exited, 0, 'Browser must run a fresh canonical runtime bundle');
const data = process.env['XLN_TRON_STAND_PATH'];
assert(data && process.env['XLN_STAND_LOCK_TOKEN'], 'Run under scripts/tron/native-stand.ts and the stand lock');
const graph = await Bun.file(`${data}/graph.json`).json();
const jurisdictions = `${data}/jurisdictions.json`;
assert(await Bun.file(jurisdictions).exists());
assert.notEqual(graph.chainId, 31338, 'Native browser evidence must not use the Anvil Tron substitute');
const out = process.env['XLN_NATIVE_BROWSER_ARTIFACTS'] ?? `${root}/.logs/native-tron-browser/${Date.now()}`;
const evidenceFiles = ['frontend/static/runtime.js', 'frontend/static/account-worker.js',
  `${data}/config.conf`, jurisdictions, `${data}/graph.json`, `${data}/token.json`,
  `${homedir()}/.cache/xln/tron/4.8.2.1/FullNode-aarch64.jar`];
const hashes = Object.fromEntries(await Promise.all(evidenceFiles.map(async path =>
  [path, createHash('sha256').update(Buffer.from(await Bun.file(path).arrayBuffer())).digest('hex')])));
await Bun.write(`${out}/fixture.json`, JSON.stringify({ data, chainId: graph.chainId, sourceBefore, hashes }));
// Exercise the aggregate's actual shard-bound HTTP handler against this TVM,
// independently of the standalone runtime server's process-global config.
const { proxyNativeRest } = await import('../../../core/orchestrator/proxy');
const aggregate = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request =>
  proxyNativeRest(request, { 'content-type': 'application/json' }, { shardJurisdictionsPath: jurisdictions, rpc2Url: '' }) });
try {
  const response = await fetch(`http://127.0.0.1:${aggregate.port}/api/tron/${graph.chainId}/walletsolidity/getnowblock`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 200, await response.clone().text());
  const head = await response.json();
  assert(Number.isSafeInteger(head.block_header.raw_data.number) && head.block_header.raw_data.number > 0);
  await Bun.write(`${out}/aggregate-native-rest.json`, JSON.stringify({ solidifiedHead: head.block_header.raw_data.number, chainId: graph.chainId }));
} finally { aggregate.stop(true); }
const apiBase = 'http://127.0.0.1:19804';
const appBase = 'http://localhost:19805';
const orchestrated = process.argv.includes('--orchestrator');
const meshDb = `${data}/browser-orchestrator`;
if (orchestrated) await Bun.write(`${meshDb}/jurisdictions.json`, await Bun.file(jurisdictions).text());
const apiCommand = orchestrated
  ? ['bun', 'core/orchestrator/orchestrator.ts', '--port', '19804', '--db-root', meshDb, '--rpc-url', graph.chain.defaultRpc, '--relay-url', 'ws://localhost:19804/relay', '--public-ws-base-url', 'ws://localhost:19805']
  : ['bun', 'core/api/server/index.ts', '--port', '19804'];
const api = Bun.spawn(apiCommand, {
  cwd: root, env: { ...process.env, XLN_RUNTIME_SEED: 'native-tron-browser-public-fixture',
    XLN_DB_PATH: `${data}/browser-server`, PUBLIC_RELAY_URL: 'ws://localhost:19805/relay', XLN_JURISDICTIONS_PATH: jurisdictions,
    USE_ANVIL: 'false', XLN_LOCAL_SIMULATION: 'false', XLN_SKIP_SERVER_BOOTSTRAP: 'true',
    ...(orchestrated ? { XLN_MESH_ROOT_SEED: 'native-tvm-browser-mesh-public-fixture', XLN_MESH_PRESERVE_STATE_ON_RESET: '1', XLN_SKIP_STALE_REAP: '1' } : {}) },
  stdout: Bun.file(`${out}/api.log`), stderr: Bun.file(`${out}/api-error.log`),
});
let apiExited = false;
void api.exited.then(() => { apiExited = true; });
let vite: ReturnType<typeof Bun.spawn> | null = null;
let currentPage: import('@playwright/test').Page | null = null;
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
try {
  vite = Bun.spawn(['bun', 'x', 'vite', '--host', '127.0.0.1', '--port', '19805', '--strictPort'], {
    cwd: `${root}/frontend`, env: { ...process.env, VITE_API_PROXY_TARGET: apiBase, XLN_VITE_FORCE_HTTP: '1' },
    stdout: Bun.file(`${out}/vite.log`), stderr: Bun.file(`${out}/vite-error.log`),
  });
  if (orchestrated) {
    const { fundNativeOrchestratorFixture } = await import('./fund-orchestrator');
    await fundNativeOrchestratorFixture(data, apiBase, out);
  }
  const deadline = Date.now() + 30_000;
  let ready = false;
  let lastHealth: unknown = null;
  while (!apiExited && Date.now() < deadline) {
    const response = await fetch(`${apiBase}/api/health`, { signal: AbortSignal.timeout(1_000) }).catch(() => null);
    if (response?.ok) { const health = await response.json(); lastHealth = health; if (orchestrated ? health.systemOk === true : health.boot?.phase === 'ready' && health.system?.runtime === true && health.boot.error === null) { ready = true; break; } }
    await Bun.sleep(100);
  }
  await Bun.write(`${out}/startup-health.json`, JSON.stringify(lastHealth));
  assert(ready, `NATIVE_BROWSER_API_NOT_READY:exit=${apiExited ? await api.exited : 'running'}:log=${out}/api-error.log`);
  const viteDeadline = Date.now() + 20_000;
  while (!(await fetch(appBase).then(r => r.ok).catch(() => false))) {
    assert(Date.now() < viteDeadline, 'NATIVE_BROWSER_VITE_NOT_READY');
    await Bun.sleep(100);
  }
  browser = await chromium.launch();
  const page = await browser.newPage();
  currentPage = page;
  page.setDefaultTimeout(20_000);
  process.env.E2E_BASE_URL = appBase;
  process.env.E2E_API_BASE_URL = apiBase;
  const { gotoApp, createRuntimeIdentity } = await import('../../utils/e2e-demo-users');
  const consoleErrors: string[] = [];
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); if (message.type() === 'error' || message.type() === 'warning') console.log('NATIVE_BROWSER_CONSOLE', message.text()); });
  const httpErrors: string[] = [];
  page.on('response', response => { if (response.status() >= 400) { const error = `${response.status()} ${response.url()}`; httpErrors.push(error); console.error('NATIVE_BROWSER_HTTP_ERROR', error); } });
  const pageErrors: string[] = [];
  page.on('pageerror', error => { pageErrors.push(error.message); console.error('NATIVE_BROWSER_PAGE_ERROR', error.message); });
  await gotoApp(page);
  const wallet = await createRuntimeIdentity(page, 'native-tvm-browser',
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    { requireOnline: false, requiresOnboarding: false, jurisdiction: 'Native TVM' });
  console.log('NATIVE_BROWSER_WALLET', JSON.stringify(wallet));
  await page.screenshot({ path: `${out}/wallet-startup.png` });
  const { TronWeb } = await import('tronweb');
  const { getBytes, zeroPadValue } = await import('ethers');
  const { createEmptyBatch } = await import('../../../core/jurisdiction/machine/batch');
  const { prepareSignedBatch } = await import('../../../core/hanko/batch');
  const { createJAdapter } = await import('../../../core/jurisdiction/adapter');
  const token = await Bun.file(`${data}/token.json`).json();
  const privateKey = `0x${'1'.padStart(64, '0')}`;
  const tron = new TronWeb({ fullHost: graph.chain.defaultFullHost,
    solidityNode: graph.chain.defaultSolidityHost, privateKey: privateKey.slice(2) });
  const recipient = TronWeb.address.fromPrivateKey(privateKey.slice(2));
  assert(recipient);
  const adapter = await createJAdapter({ mode: 'tron', chainId: graph.chainId,
    rpcUrl: graph.chain.defaultRpc, tronFullHost: graph.chain.defaultFullHost,
    tronSolidityHost: graph.chain.defaultSolidityHost, privateKey,
    fromReplica: { contracts: graph.contracts, entityProviderDeploymentBlock: graph.entityProviderDeploymentBlock } });
  try {
    const before = await adapter.getErc20Balance(token.evm, '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf');
    const resumeFunded = process.argv.includes('--resume-funded');
    console.log('NATIVE_BROWSER_INITIAL_CHAIN', JSON.stringify({ reserve: String(await adapter.getReserves(wallet.entityId, 1)), nonce: String(await adapter.getEntityNonce(wallet.entityId)), externalBalance: String(before) }));
    assert.equal(await adapter.getReserves(wallet.entityId, 1), resumeFunded ? 1_000_000n : 0n, 'Fixture reserve must match explicit resume mode');
    const nonceBefore = await adapter.getEntityNonce(wallet.entityId);
    if (!resumeFunded) {
    const gas = await tron.trx.sendTransaction(TronWeb.address.fromHex(`41${wallet.signerId.slice(2)}`), 1_000_000_000);
    assert(gas.result, JSON.stringify(gas));
    assert(await adapter.getErc20Allowance(token.evm, '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf', graph.contracts.depository) >= 1_000_000n);
    const foundation = zeroPadValue('0x01', 32);
    const batch = createEmptyBatch();
    batch.externalTokenToReserve.push({ entity: wallet.entityId, contractAddress: token.evm,
      tokenType: 0, externalTokenId: 0n, internalTokenId: 1, amount: 1_000_000n });
    const signed = prepareSignedBatch(batch, foundation, getBytes(privateKey), BigInt(adapter.chainId),
      adapter.addresses.depository, await adapter.getEntityNonce(foundation));
    const fundingReceipt = await adapter.processBatch(signed.encodedBatch, signed.hankoData, signed.nextNonce);
    console.log('NATIVE_BROWSER_FIXTURE_FUNDED', JSON.stringify({ txHash: fundingReceipt.txHash, block: fundingReceipt.blockNumber }));
    }
    assert.equal(await adapter.getReserves(wallet.entityId, 1), 1_000_000n);
    const externalBeforeWithdrawal = await adapter.getErc20Balance(token.evm, '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf');
    await page.getByTestId('tab-assets').first().click();
    await page.getByTestId('asset-ledger-refresh').first().click();
    await page.getByTestId('asset-tab-move').first().click();
    await page.getByTestId('move-source-reserve').first().click();
    await page.getByTestId('move-target-external').first().click();
    console.log('NATIVE_BROWSER_ASSETS', await page.getByTestId('move-asset-symbol').innerHTML());
    await page.screenshot({ path: `${out}/native-withdrawal-assets.png` });
    const registry = await page.evaluate(async ({ entityId, signerId }) => {
      const { getXLN, getEnv } = await import('/src/lib/stores/xlnStore.ts');
      const { unwrapLiveRuntimeEnv } = await import('/src/lib/utils/runtime/liveRuntimeEnv.ts');
      const xln = await getXLN();
      const adapter = xln.getEntityJAdapter(unwrapLiveRuntimeEnv(getEnv()), entityId, signerId);
      if (!adapter) throw new Error('NATIVE_BROWSER_ADAPTER_MISSING');
      return { mode: adapter.mode, chainId: adapter.chainId, tokens: (await adapter.getTokenRegistry()).map(token => ({ tokenId: token.tokenId, address: token.address, decimals: token.decimals })), symbol: xln.getTokenInfo(1).symbol, watching: adapter.isWatching() };
    }, wallet);
    assert.equal(registry.mode, 'tron');
    assert.equal(registry.chainId, graph.chainId);
    const asset = registry.tokens.find(token => token.tokenId === 1);
    assert.equal(asset?.address.toLowerCase(), token.evm.toLowerCase());
    assert.equal(asset?.decimals, 6);
    await Bun.write(`${out}/browser-native-adapter.json`, JSON.stringify(registry));
    await page.getByTestId('move-asset-symbol').selectOption(registry.symbol);
    await page.getByTestId('move-amount').fill('1');
    await page.getByTestId('move-external-recipient').fill(recipient);
    console.log('NATIVE_BROWSER_MOVE_STATUS', await page.getByTestId('move-status').allTextContents());
    await page.screenshot({ path: `${out}/native-withdrawal-validation.png` });
    await expect(page.getByTestId('move-confirm').first()).toBeEnabled({ timeout: 10_000 });
    await page.screenshot({ path: `${out}/native-withdrawal-ready.png` });
    await page.getByTestId('move-confirm').first().click();
    await expect(page.getByTestId('settle-sign-broadcast').first()).toBeEnabled({ timeout: 20_000 });
    await page.evaluate(async () => {
      const { getEnv } = await import('/src/lib/stores/xlnStore.ts');
      const { unwrapLiveRuntimeEnv } = await import('/src/lib/utils/runtime/liveRuntimeEnv.ts');
      let remaining = 8;
      const timer = setInterval(() => {
        const env = unwrapLiveRuntimeEnv(getEnv());
        console.warn('NATIVE_SUBMIT_STATE', JSON.stringify({ height: env.state.height,
          preparing: env.infrastructure?.jPreparationTasks?.size,
          pending: env.infrastructure?.pendingCommittedJOutbox?.map(input => input.jTxs.map(tx => ({ type: tx.type, attempt: tx.data?.runtimeSubmitAttempt }))),
          mempool: env.runtimeMempool?.runtimeTxs?.map(tx => tx.type) }, (_, value) => typeof value === 'bigint' ? String(value) : value));
        if (--remaining === 0) clearInterval(timer);
      }, 1000);
    });
    await page.getByTestId('settle-sign-broadcast').first().click();
    await expect.poll(async () => String(await adapter.getReserves(wallet.entityId, 1)), { timeout: 30_000 }).toBe('0');
    assert.equal(await adapter.getErc20Balance(token.evm, '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf'), externalBeforeWithdrawal + 1_000_000n);
    assert.equal(await adapter.getEntityNonce(wallet.entityId), nonceBefore + 1n);
    console.log('NATIVE_BROWSER_ONCHAIN_WITHDRAWAL', JSON.stringify({ reserve: '0', nonce: String(nonceBefore + 1n), externalBalance: String(externalBeforeWithdrawal + 1_000_000n) }));
    // The native watcher only imports solidified receipts. Do not shut down the
    // node after merely observing its reversible latest state.
    await expect.poll(async () => page.evaluate(async ({entityId, signerId}) => {
      const { getEnv } = await import('/src/lib/stores/xlnStore.ts');
      const { unwrapLiveRuntimeEnv } = await import('/src/lib/utils/runtime/liveRuntimeEnv.ts');
      const env = unwrapLiveRuntimeEnv(getEnv());
      return String(env.state.eReplicas.get(`${entityId}:${signerId}`)?.state.reserves.get(1) ?? 'missing');
    }, wallet), { timeout: 30_000 }).toBe('0');
    await page.screenshot({ path: `${out}/native-withdrawal-complete.png` });
    await Bun.write(`${out}/result.json`, JSON.stringify({ wallet, chainId: adapter.chainId, mode: adapter.mode,
      reserve: '0', entityNonce: String(nonceBefore + 1n), recipient, externalBalanceBeforeFunding: String(before), externalBalanceBeforeWithdrawal: String(externalBeforeWithdrawal), externalBalanceAfter: String(externalBeforeWithdrawal + 1_000_000n), amount: '1000000' }));
    assert.deepEqual(pageErrors, [], 'Browser runtime must not raise uncaught errors');
    assert.deepEqual(httpErrors, [], 'Browser flow must not issue failing HTTP requests');
    assert.deepEqual(consoleErrors, [], 'Browser flow must not log errors');
    const sourceAfter = computeRepositoryCodeFingerprint({ root });
    await Bun.write(`${out}/source-after.json`, JSON.stringify({ sourceAfter, unchanged: sourceBefore.codeHash === sourceAfter.codeHash }));
    console.log('NATIVE_BROWSER_WITHDRAWAL_VERIFIED');
  } finally { await adapter.close(); }

} catch (error) {
  console.error('NATIVE_BROWSER_PRIMARY_FAILURE', error);
  if (currentPage) {
    const evidence = await Promise.allSettled([
      currentPage.screenshot({ path: `${out}/failure.png`, timeout: 3_000 }),
      currentPage.locator('body').innerText({ timeout: 3_000 }).then(text => Bun.write(`${out}/failure.txt`, text)),
    ]);
    for (const item of evidence) if (item.status === 'rejected') console.error('NATIVE_BROWSER_EVIDENCE_FAILURE', item.reason);
  }
  throw error;
} finally {
  await browser?.close();
  for (const child of [vite, api]) {
    if (!child) continue;
    child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000);
    await child.exited;
    clearTimeout(timeout);
  }
}

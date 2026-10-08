import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { keccak256 } from 'ethers';
import { createJAdapter, createXlnJsonRpcProvider } from '../../core/jurisdiction/adapter';
import { readStandLockHolder, standLockCapacity, standLockRoot } from '../../tools/stand-lock';
import { safeStringify } from '../../core/protocol/serialization';

const token = process.env['XLN_STAND_LOCK_TOKEN'];
assert(token && Array.from({ length: standLockCapacity() }, (_, slot) =>
  readStandLockHolder(standLockRoot(), slot)).some(holder => holder?.token === token));
const root = resolve(import.meta.dir, '../..');
const data = resolve(process.env['XLN_TRON_STAND_PATH'] || `${root}/db/native-tron-release-20260918`);
const path = `${data}/ethereum`;
await mkdir(path, { recursive: true });
const graphFile = Bun.file(`${path}/graph.json`);
const stateFile = Bun.file(`${path}/state.json`);
assert.equal(await graphFile.exists(), await stateFile.exists(),
  'Ethereum graph/state mismatch requires inspection; never redeploy over an uncertain ledger');
const graph = await graphFile.exists() ? await graphFile.json() : null;
const rpcUrl = 'http://127.0.0.1:18546';
const provider = createXlnJsonRpcProvider(rpcUrl, 31337);
const node = Bun.spawn(['anvil', '--host', '127.0.0.1', '--port', '18546', '--chain-id', '31337',
  '--mixed-mining', '--block-time', '1', '--block-gas-limit', '60000000', '--code-size-limit', '65536',
  '--state', `${path}/state.json`, '--preserve-historical-states', '--quiet'], {
  cwd: path, stdout: Bun.file(`${path}/node.stdout.log`), stderr: Bun.file(`${path}/node.stderr.log`),
});
let stopped = false;
void node.exited.then(() => { stopped = true; });
try {
  const deadline = Date.now() + 10_000;
  let lastError: unknown;
  let ready = false;
  while (!stopped && Date.now() < deadline) {
    try {
      const response = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }), signal: AbortSignal.timeout(1000) });
      const value = await response.json();
      assert.equal(value.result, '0x7a69');
      ready = true;
      break;
    } catch (error) { lastError = error; }
    await Bun.sleep(100);
  }
  assert(ready, `Ethereum RPC unavailable: ${String(lastError)}`);
  const adapter = await createJAdapter({ mode: 'rpc', chainId: 31337, rpcUrl,
    ...(graph ? { fromReplica: { contracts: graph.contracts,
      entityProviderDeploymentBlock: graph.entityProviderDeploymentBlock } } : {}) });
  try {
    if (!graph) await adapter.deployStack();
    const contracts = Object.fromEntries((['account', 'depository', 'entityProvider', 'deltaTransformer'] as const)
      .map(name => [name, adapter.addresses[name]]));
    const codeHashes = Object.fromEntries(await Promise.all(Object.entries(contracts).map(async ([name, address]) => {
      const code = await provider.getCode(address);
      assert.notEqual(code, '0x');
      return [name, keccak256(code)];
    })));
    if (graph) assert.deepEqual(codeHashes, graph.codeHashes);
    const result = { name: 'Private Ethereum', mode: 'rpc', chainId: 31337, rpc: rpcUrl, blockTimeMs: 1000,
      entityProviderDeploymentBlock: adapter.entityProviderDeploymentBlock, contracts, codeHashes,
      registry: await adapter.getTokenRegistry() };
    if (!graph) await Bun.write(`${path}/graph.json`, safeStringify(result, 2));
    await Bun.write(`${path}/readback.json`, safeStringify(result, 2));
  } finally { await adapter.close(); }
  const configuration = await Bun.file(`${data}/jurisdictions.json`).json();
  const ethereum = await Bun.file(`${path}/graph.json`).json();
  configuration.jurisdictions.ethereum = { name: ethereum.name, mode: 'rpc', chainId: ethereum.chainId,
    rpc: ethereum.rpc, blockTimeMs: ethereum.blockTimeMs, contracts: ethereum.contracts,
    entityProviderDeploymentBlock: ethereum.entityProviderDeploymentBlock,
    currency: 'ETH', explorer: '', status: 'active' };
  const configurationPath = `${data}/dual-jurisdictions.json`;
  const configurationText = JSON.stringify(configuration, null, 2);
  if (await Bun.file(configurationPath).exists()) assert.equal(await Bun.file(configurationPath).text(), configurationText);
  else await Bun.write(configurationPath, configurationText);
  const script = process.argv.includes('--automatic-withdraw') ? 'scripts/tron/withdrawal/automatic.ts' :
    process.argv.includes('--withdraw') ? 'scripts/tron/withdrawal/cross.ts' :
    process.argv.includes('--swap') ? 'scripts/tron/cross-swap.ts' : 'scripts/tron/cross-network.ts';
  const callbackAt = process.argv.indexOf('--exec');
  const command = callbackAt >= 0 ? process.argv.slice(callbackAt + 1) : ['bun', script,
    ...(process.argv.includes('--inspect') ? ['--inspect'] : []),
    ...(process.argv.includes('--restore') ? ['--restore'] : []),
    ...(process.argv.includes('--resume') ? ['--resume'] : [])];
  assert(command.length > 0, 'Ethereum stand callback required');
  const child = Bun.spawn(command, {
    cwd: root, stdout: 'inherit', stderr: 'inherit', env: { ...process.env,
      XLN_DB_PATH: `${data}/cross-runtime`, XLN_JURISDICTIONS_PATH: configurationPath },
  });
  assert.equal(await child.exited, 0, 'Cross-network Runtime failed');
} finally {
  await provider.destroy();
  if (!stopped) node.kill('SIGTERM');
  const deadline = setTimeout(() => { if (!stopped) node.kill('SIGKILL'); }, 15_000);
  await node.exited;
  clearTimeout(deadline);
  // A truncated shutdown snapshot cannot become the next run's starting state.
  const saved = await Bun.file(`${path}/state.json`).json();
  assert(saved && typeof saved === 'object');
}

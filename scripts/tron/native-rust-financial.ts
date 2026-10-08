/** Genuine TVM funding -> native Rust Entity batch -> solid receipt -> SIGKILL restore. */
import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { computeAddress, getBytes, id, zeroPadValue } from 'ethers';
import { createHash } from 'node:crypto';
import { computeCodeFingerprint } from '../../core/scripts/e2e/harness/e2e-isolated-runtime';
import { TronWeb } from 'tronweb';
import { deriveSignerAddressSync } from '../../core/account/crypto';
import { deriveManagedEntityIdentity } from '../../core/orchestrator/daemon-control';
import { buildRustHubGenesisConfig } from '../../core/orchestrator/process/rust-hub-genesis';
import { assertRustHubBinaryFresh, buildRustHubProcessPlan } from '../../core/orchestrator/process/hub-engine-plan';
import { canonicalEntitySeed } from '../../core/runtime/registration/entity-creation';
import { deriveEntityEncryptionPrivateKey } from '../../core/runtime/registration/entity-creation/crypto';
import { createJAdapter } from '../../core/jurisdiction/adapter';
import { createEmptyBatch } from '../../core/jurisdiction/machine/batch';
import { prepareSignedBatch } from '../../core/hanko/batch';
import { safeStringify } from '../../core/protocol/serialization';
import { createNativeRustExpiry } from './recovery/native-rust-expiry';
import { verifyNativeWalletSnapshot } from './recovery/wallet-snapshot';

const stand = process.env['XLN_TRON_STAND_PATH'];
const output = process.env['XLN_TRON_RUST_EVIDENCE'];
const seed = process.env['XLN_TRON_RUST_SEED'];
assert(stand && output && seed, 'explicit disposable stand, fresh evidence and seed required');
assert(process.env['XLN_STAND_LOCK_TOKEN'], 'stand lock required');
const data = resolve(output);
assert(!(await Bun.file(`${data}/genesis.json`).exists()), 'preserve existing financial evidence');
mkdirSync(data, { recursive: true });
const graph = await Bun.file(`${stand}/graph.json`).json();
const token = await Bun.file(`${stand}/token.json`).json();
const registry = await Bun.file(`${stand}/jurisdictions.json`).json();
const foundationKey = '1'.padStart(64, '0');
const adapter = await createJAdapter({ mode: 'tron', chainId: graph.chainId, rpcUrl: graph.chain.defaultRpc,
  tronFullHost: graph.chain.defaultFullHost, tronSolidityHost: graph.chain.defaultSolidityHost,
  privateKey: foundationKey, fromReplica: { contracts: graph.contracts, entityProviderDeploymentBlock: graph.entityProviderDeploymentBlock } });
const tokens = await adapter.getTokenRegistry();
assert.equal(tokens.length, 1);
assert.equal(tokens[0]?.address.toLowerCase(), token.evm.toLowerCase());
registry.jurisdictions.native.tokenRegistry = tokens.map(row => ({ ...row, externalTokenId: String(row.externalTokenId) }));
const expiry = process.env['XLN_TRON_RUST_EXPIRE'] === '1'
  ? createNativeRustExpiry({ data, fullHost: graph.chain.defaultFullHost, solidHost: graph.chain.defaultSolidityHost,
    rpc: graph.chain.defaultRpc, stop: () => stop() }) : undefined;
if (expiry) Object.assign(registry.jurisdictions.native, { rpc: expiry.rpc, tronFullHost: expiry.fullHost, tronSolidityHost: expiry.solidHost });
const signerLabel = 'h1-hub';
const identity = deriveManagedEntityIdentity({ name: 'H1', seed, signerLabel });
const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
const genesis = buildRustHubGenesisConfig({ name: 'H1', runtimeId, seed, signerLabel,
  jurisdictionsJson: JSON.stringify(registry), rpcUrls: {}, minFrameDelayMs: 0 });
writeFileSync(`${data}/runtime.seed`, `${seed}\n`, { mode: 0o600 });
writeFileSync(`${data}/entity.key`, `${deriveEntityEncryptionPrivateKey(Buffer.from(canonicalEntitySeed(seed).slice(2), 'hex'), identity.entityId)}\n`, { mode: 0o600 });
writeFileSync(`${data}/routes.json`, '[]');
writeFileSync(`${data}/jurisdictions.json`, JSON.stringify(registry));
writeFileSync(`${data}/genesis.json`, safeStringify(genesis, 2));
const plan = buildRustHubProcessPlan({ name: 'H1', apiHost: '127.0.0.1', apiPort: 18181,
  directHost: '127.0.0.1', directPort: 19181, dbPath: `${data}/runtime`, runtimeSeedFile: `${data}/runtime.seed`,
  entityKeyFile: `${data}/entity.key`, routesFile: `${data}/routes.json`, genesisFile: `${data}/genesis.json`,
  jurisdictionsPath: `${data}/jurisdictions.json`, runtimeSignerLabel: '1', entitySignerLabel: signerLabel,
  primaryEntityId: identity.entityId, workers: 1, binary: assertRustHubBinaryFresh(process.cwd()) });
const candidate = computeCodeFingerprint();
await Bun.write(`${data}/candidate.json`, JSON.stringify({ gitHead: candidate.gitHead, codeHash: candidate.codeHash,
  binaryHash: createHash('sha256').update(await Bun.file(plan.executable).bytes()).digest('hex'),
  driverHash: createHash('sha256').update(await Bun.file(import.meta.path).bytes()).digest('hex'),
  graphHash: createHash('sha256').update(await Bun.file(`${stand}/graph.json`).bytes()).digest('hex') }, null, 2));
const tronWeb = new TronWeb({ fullHost: graph.chain.defaultFullHost, solidityNode: graph.chain.defaultSolidityHost, privateKey: foundationKey });
const funding = await tronWeb.trx.sendTransaction(TronWeb.address.fromHex(`41${identity.signerId.slice(2)}`), 1_000_000_000);
assert.equal(funding.result, true, 'fund real Rust submit payer gas');
const amount = 100n;
assert.equal(await adapter.getReserves(identity.entityId, 1), 0n);
const externalBefore = await adapter.getErc20Balance(token.evm, identity.signerId);
const nonceBefore = await adapter.getEntityNonce(identity.entityId);
let child: ReturnType<typeof Bun.spawn> | undefined;
const start = (suffix: string) => {
  child = Bun.spawn([plan.executable, ...plan.args], { env: { ...process.env, XLN_JURISDICTIONS_PATH: `${data}/jurisdictions.json` },
    stdout: Bun.file(`${data}/rust-${suffix}.stdout.log`), stderr: Bun.file(`${data}/rust-${suffix}.stderr.log`) });
};
const stop = async () => { if (child && child.exitCode === null) { child.kill('SIGKILL'); await child.exited; } };
const get = async (path: string) => {
  const response = await fetch(`http://127.0.0.1:18181${path}`, { signal: AbortSignal.timeout(2_000) });
  assert(response.ok, `Rust API ${path}: ${response.status}`);
  return response.json();
};
const wait = async (label: string, predicate: () => Promise<boolean>) => {
  const deadline = Date.now() + 45_000;
  while (!(await predicate())) {
    assert(child && child.exitCode === null, `Rust exited: ${label}`);
    assert(Date.now() < deadline, `Rust deadline: ${label}`);
    await Bun.sleep(250);
  }
};
const ready = async () => {
  // Connection refusal is expected only before the genuine native HTTP listener binds.
  try { return (await get('/api/info')).deliveryReady === true; }
  catch (error) { if (error instanceof TypeError || (error instanceof Error && 'code' in error && error.code === 'ConnectionRefused')) return false; throw error; }
};
try {
  start('initial');
  await wait('native watcher catchup', ready);
  const walletGate = { adapter, entityId: identity.entityId, owner: computeAddress(`0x${foundationKey}`).toLowerCase(),
    tokenAddress: token.evm, spender: graph.contracts.depository.toLowerCase(), apiUrl: 'http://127.0.0.1:18181',
    solidityHost: graph.chain.defaultSolidityHost };
  const initialWalletHeight = await verifyNativeWalletSnapshot({ ...walletGate, evidencePath: `${data}/wallet-initial` });
  const fund = createEmptyBatch();
  fund.externalTokenToReserve.push({ entity: identity.entityId, contractAddress: token.evm, tokenType: 0, externalTokenId: 0n, internalTokenId: 1, amount });
  const foundation = zeroPadValue('0x01', 32);
  const signed = prepareSignedBatch(fund, foundation, getBytes(`0x${foundationKey}`), BigInt(adapter.chainId), adapter.addresses.depository, await adapter.getEntityNonce(foundation));
  const deposit = await adapter.processBatch(signed.encodedBatch, signed.hankoData, signed.nextNonce);
  await wait('Rust committed funded reserve', async () => (await get('/api/health')).bootstrapReserves.tokens.some(row => row.tokenId === 1 && row.current === String(amount)));
  const command = { commandId: 'native-tvm-financial-withdrawal', entityInputs: [{ entityId: identity.entityId, signerId: identity.signerId, entityTxs: [
    { type: 'r2e', data: { tokenId: 1, amount, receivingEntity: zeroPadValue(identity.signerId, 32) } },
    { type: 'j_broadcast', data: {} },
  ] }] };
  await Bun.write(`${data}/command.json`, safeStringify(command, 2));
  const response = await fetch('http://127.0.0.1:18181/api/control/runtime/entity-inputs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: safeStringify(command) });
  const accepted = await response.json();
  await Bun.write(`${data}/accepted.json`, JSON.stringify(accepted, null, 2));
  assert(response.ok, safeStringify(accepted));
  if (expiry) await expiry.recover(start);
  await wait('native financial receipt', async () => await adapter.getEntityNonce(identity.entityId) === nonceBefore + 1n);
  let logs: Awaited<ReturnType<typeof adapter.provider.getLogs>> = [];
  await wait('native indexed financial log', async () => {
    logs = await adapter.provider.getLogs({ address: graph.contracts.depository, fromBlock: deposit.blockNumber,
      toBlock: 'latest', topics: [id('HankoBatchProcessed(bytes32,bytes32,uint256)'), identity.entityId] });
    return logs.length > 0;
  });
  assert.equal(logs.length, 1, 'one actual native financial batch');
  const batchLog = logs[0];
  assert(batchLog);
  await wait('native financial solidification', async () => await adapter.getCurrentBlockNumber() >= batchLog.blockNumber);
  const receipt = await adapter.provider.getTransactionReceipt(batchLog.transactionHash);
  assert(receipt && receipt.status === 1 && receipt.blockHash === batchLog.blockHash);
  if (expiry) {
    assert.equal(receipt.hash, expiry.hashes().replacement);
    assert.equal(await adapter.provider.getTransactionReceipt(expiry.hashes().old), null);
  }
  const canonical = await adapter.provider.send('eth_getBlockByNumber', [`0x${receipt.blockNumber.toString(16)}`, false]);
  assert.equal(canonical.hash.toLowerCase(), receipt.blockHash.toLowerCase());
  assert.equal(await adapter.getReserves(identity.entityId, 1), 0n);
  assert.equal(await adapter.getErc20Balance(token.evm, identity.signerId), externalBefore + amount);
  await wait('Rust committed withdrawal', async () => (await get('/api/health')).bootstrapReserves.tokens.some(row => row.tokenId === 1 && row.current === '0'));
  const beforeRestart = await get('/api/info');
  await stop();
  start('restored');
  await wait('restore WAL and native watcher', ready);
  const afterRestart = await get('/api/info');
  await verifyNativeWalletSnapshot({ ...walletGate, evidencePath: `${data}/wallet-restored`, expiredSourceHeight: initialWalletHeight });
  assert(afterRestart.height >= beforeRestart.height);
  assert.equal(await adapter.getEntityNonce(identity.entityId), nonceBefore + 1n);
  assert.equal(await adapter.getReserves(identity.entityId, 1), 0n);
  assert.equal(await adapter.getErc20Balance(token.evm, identity.signerId), externalBefore + amount);
  await Bun.write(`${data}/result.json`, safeStringify({ chainId: graph.chainId, engine: 'rust', entityId: identity.entityId,
    deposit, receipt, amount, nonceBefore, nonceAfter: nonceBefore + 1n, externalBefore, externalAfter: externalBefore + amount,
    beforeRestart, afterRestart, solidifiedBlock: await adapter.getCurrentBlockNumber() }, 2));
  console.log('NATIVE_RUST_FINANCIAL_VERIFIED', identity.entityId);
} finally { await stop(); expiry?.close(); await adapter.close(); }

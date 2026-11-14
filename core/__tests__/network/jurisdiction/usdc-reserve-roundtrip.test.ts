import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { roundtripFixture, probeCommand, externalWallet, drainNativeBalance } from './usdc-reserve-roundtrip-support';
import { directoryDigests } from '../../orchestrator/standalone-deployment/standalone-deployment-readonly-support';
import { ERC20Mock__factory } from '../../../../jurisdictions/typechain-types/factories/ERC20Mock__factory';

let fixture: Awaited<ReturnType<typeof roundtripFixture>>;
let snapshot: string;
beforeAll(async () => {
  fixture = await roundtripFixture();
  await fixture.provider.send('evm_setIntervalMining', [1]);
}, 180_000);
beforeEach(async () => {
  snapshot = await fixture.provider.send('evm_snapshot', []);
});
afterEach(async () => {
  await fixture.provider.send('evm_revert', [snapshot]);
});
afterAll(async () => {
  await fixture.close();
});

test('CLI proves an exact one-USDC reserve roundtrip with confirmed raw balances and native fees', async () => {
  const before = await directoryDigests(fixture.nativeDirectory);
  const result = await probeCommand(fixture);
  if (result.code !== 0) throw new Error(`ROUNDTRIP_COMMAND_FAILED:${result.code}:${result.stderr}`);
  const report = JSON.parse(result.stdout);
  expect(report.status).toBe('complete');
  expect(report.amount).toBe('1000000');
  expect(report.snapshots.initial.token).toBe('1000000');
  expect(report.snapshots.initial.reserve).toBe('0');
  expect(report.snapshots.deposited.token).toBe('0');
  expect(report.snapshots.deposited.reserve).toBe('1000000');
  expect(report.snapshots.restored.token).toBe('1000000');
  expect(report.snapshots.restored.reserve).toBe('0');
  expect(report.transactions.map((tx: { stage: string }) => tx.stage)).toEqual(['approval', 'deposit', 'withdrawal']);
  expect(report.native.unaccountedDeltaWei).toBe('0');
  expect(BigInt(report.native.feesWei)).toBeGreaterThan(0n);
  expect(report.confirmations).toBe(12);
  expect(report.probe.sha).toMatch(/^[0-9a-f]{40}$/);
  expect(Object.keys(report.probe.sources)).toHaveLength(7);
  const approval = await fixture.provider.getTransaction(report.transactions[0].hash);
  expect(ERC20Mock__factory.createInterface().decodeFunctionData('approve', approval!.data)[1]).toBe(1_000_000n);
  expect(await directoryDigests(fixture.nativeDirectory)).toEqual(before);
  await writeFile(result.evidence, result.stdout);
  console.log(`USDC_ROUNDTRIP_LOCAL_EVIDENCE:${result.evidence}`);
}, 180_000);

test('a separately funded external signer uses an existing allowance and pays only deposit and withdrawal fees', async () => {
  const wallet = externalWallet(fixture);
  const token = ERC20Mock__factory.connect(fixture.request.stablecoin.address, fixture.signer);
  await (await token.transfer(wallet.address, 1_000_000n)).wait();
  await (await token.connect(wallet).approve(fixture.deployment.manifest.contracts.depository, 2_000_000n)).wait();
  const result = await probeCommand(fixture, { key: wallet.privateKey });
  if (result.code !== 0) throw new Error(result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  expect(report.status).toBe('complete');
  expect(report.signer.toLowerCase()).not.toBe(fixture.deployment.manifest.deployer.toLowerCase());
  expect(report.transactions.map((tx: { stage: string }) => tx.stage)).toEqual(['deposit', 'withdrawal']);
  expect(report.snapshots.initial.allowance).toBe('2000000');
  expect(report.snapshots.restored.allowance).toBe('1000000');
  expect(report.snapshots.restored.token).toBe('1000000');
  expect(report.snapshots.restored.reserve).toBe('0');
  expect(report.native.unaccountedDeltaWei).toBe('0');
}, 90_000);

test.each([
  { name: 'wrong expected chain', options: { chainId: 11155111 }, error: 'USDC_ROUNDTRIP_LOCAL_NETWORK_INVALID' },
  {
    name: 'wrong expected token',
    options: { token: '0x0000000000000000000000000000000000000001' },
    error: 'USDC_ROUNDTRIP_TOKEN_BINDING_MISMATCH',
  },
  { name: 'weakened confirmations', options: { confirmations: 1 }, error: 'USDC_ROUNDTRIP_CONFIRMATIONS_INVALID' },
])('preflight rejects $name without spending', async ({ options, error }) => {
  const nonce = await fixture.signer.getNonce('pending');
  const result = await probeCommand(fixture, options);
  const report = JSON.parse(result.stdout);
  expect(result.code).toBe(1);
  expect(report.failure).toContain(error);
  expect(report.transactions).toEqual([]);
  expect(await fixture.signer.getNonce('pending')).toBe(nonce);
});

test('preflight rejects insufficient token funding before approval', async () => {
  const wallet = externalWallet(fixture);
  const nonce = await wallet.getNonce('pending');
  const result = await probeCommand(fixture, { key: wallet.privateKey });
  const report = JSON.parse(result.stdout);
  expect(result.code).toBe(1);
  expect(report.failure).toContain('USDC_ROUNDTRIP_TOKEN_FUNDING_INSUFFICIENT');
  expect(report.snapshots.initial.token).toBe('0');
  expect(report.transactions).toEqual([]);
  expect(await wallet.getNonce('pending')).toBe(nonce);
});

test('changed current contract code is rejected before signing an approval', async () => {
  const nonce = await fixture.signer.getNonce('pending');
  await fixture.provider.send('anvil_setCode', [
    fixture.deployment.manifest.contracts.deltaTransformer,
    '0x60006000f3',
  ]);
  const result = await probeCommand(fixture);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout).failure).toContain('STACK_MANAGER_BYTECODE_MISMATCH:deltaTransformer');
  expect(JSON.parse(result.stdout).transactions).toEqual([]);
  expect(await fixture.signer.getNonce('pending')).toBe(nonce);
});

test('a real native-funding loss after deposit preserves known hashes and never retries the financial operation', async () => {
  const result = await probeCommand(fixture, {
    afterDeposit: async hash => {
      await fixture.provider.waitForTransaction(hash, 1, 10_000);
      await drainNativeBalance(fixture.signer);
    },
  });
  const report = JSON.parse(result.stdout);
  expect(result.code).toBe(1);
  expect(report.stage).toBe('withdrawal');
  expect(report.failure).toContain('USDC_ROUNDTRIP_NATIVE_FUNDING_INSUFFICIENT');
  expect(report.transactions.map((tx: { stage: string }) => tx.stage)).toEqual(['approval', 'deposit']);
  expect(report.snapshots.failure.token).toBe('0');
  expect(report.snapshots.failure.reserve).toBe('1000000');
  expect(
    report.transactions.every(
      (tx: { hash: string; status: string }) => /^0x[0-9a-f]{64}$/.test(tx.hash) && tx.status === 'confirmed',
    ),
  ).toBe(true);
  expect(await fixture.provider.getBalance(fixture.signer.address)).toBe(0n);
  const nonce = await fixture.signer.getNonce('pending');
  const repeated = await probeCommand(fixture);
  expect(JSON.parse(repeated.stdout).failure).toContain('USDC_ROUNDTRIP_REQUIRES_CLEAN_DEBT_FREE_RESERVE');
  expect(JSON.parse(repeated.stdout).transactions).toEqual([]);
  expect(await fixture.signer.getNonce('pending')).toBe(nonce);
}, 90_000);

import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JsonRpcProvider, Wallet } from 'ethers';
import { Depository__factory } from '../../../../jurisdictions/typechain-types';
import { requireBoundaryRecord } from '../../../protocol/boundary-validation';
import { safeParse, safeStringify } from '../../../protocol/serialization';
import { createUsdcFixture } from './usdc-session/fixture';
import { privateFundingLimits } from './usdc-session/funding-limits';

const records = (value: unknown) => {
  if (!Array.isArray(value)) throw new Error('TEST_TOPUP_RECORD_LIST_MISSING');
  return value.map((row: unknown) => requireBoundaryRecord(row, 'TEST_TOPUP_RECORD_INVALID'));
};

test('funding CLI tops up an existing target reserve and recovers its exact deposit without spending on the source chain', async () => {
  const fixture = await createUsdcFixture({ reserves: [1_000_001n, 100_199n], operators: 'defer' });
  const { root } = fixture;
  const rpcs = [fixture.rpcUpstreams.get('/rpc')!, fixture.rpcUpstreams.get('/rpc2')!];
  const providers = rpcs.map(rpc => new JsonRpcProvider(rpc, undefined, { cacheTimeout: -1 }));
  const funder = Wallet.fromPhrase('test test test test test test test test test test test junk');
  const env = {
    ...fixture.roleEnv('user'),
    ETH_SEPOLIA_RPC: rpcs[0],
    ARB_SEPOLIA_RPC: rpcs[1],
    USDC_POC_FUNDER_PRIVATE_KEY: funder.privateKey,
  };
  const entry = 'jurisdictions/scripts/usdc-cross-j-preflight/funding/index.ts';
  const launch = (name: string, path: string, args: string[]) => {
    const child = fixture.launch(
      name,
      path,
      [...args, '--directory', root, '--output', join(root, name + '.json')],
      env,
    );
    return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
  };
  const nonces = () => Promise.all(providers.map(provider => provider.getTransactionCount(funder.address)));
  const record = (name: string) =>
    requireBoundaryRecord(safeParse(readFileSync(join(root, name + '.json'), 'utf8')), 'TEST_TOPUP_RECORD_INVALID');
  try {
    const { chains, expiresAt } = privateFundingLimits();
    const target = chains[1]!;
    const limits = join(root, 'topup-limits.json');
    const targetLimit = {
      ...target,
      amount: '799602',
      hubTopupWei: '0',
      totalNativeOutflowLimitWei: target.totalFeeLimitWei,
      calls: { approval: target.calls.approval, deposit: target.calls.deposit },
    };
    const prepare = (name: string) =>
      launch(name, entry, ['prepare', '--funder-address', funder.address, '--limits-file', limits]);
    const initial = await nonces();
    writeFileSync(limits, safeStringify({ expiresAt, chains: [targetLimit] }));
    expect((await prepare('implicit-topup')).code).not.toBe(0);
    expect(readFileSync(join(root, 'implicit-topup.log'), 'utf8')).toContain('USDC_FUNDING_RESERVE_BASELINE_MISMATCH');
    expect(await nonces()).toEqual(initial);
    writeFileSync(limits, safeStringify({ expiresAt, chains: [{ ...targetLimit, expectedHubReserve: '100199' }] }));
    const prepared = await prepare('topup-prepared');
    expect(prepared.code, readFileSync(join(root, 'topup-prepared.log'), 'utf8')).toBe(0);
    const manifest = record('topup-prepared');
    const manifestChains = records(manifest['chains']);
    expect(manifest['approved']).toBeFalse();
    expect(manifestChains).toHaveLength(1);
    expect(manifestChains[0]!['hubReserveBefore']).toBe('100199');
    expect(await nonces()).toEqual(initial);

    const run = (name: string, authority: unknown, fault = false) => {
      const path = join(root, name + '-authority.json');
      writeFileSync(path, safeStringify(authority), { mode: 0o600 });
      const args = ['run', '--authority-file', path, '--key-env', 'USDC_POC_FUNDER_PRIVATE_KEY'];
      return fault
        ? launch(name, 'core/__tests__/fixtures/usdc-poc/fault-funding.ts', ['421614:deposit', ...args])
        : launch(name, entry, args);
    };
    const approved = { ...manifest, approved: true };
    const tampered = { ...approved, chains: [{ ...manifestChains[0], hubReserveBefore: '100198' }] };
    expect((await run('wrong-reserve', tampered)).code).not.toBe(0);
    expect(readFileSync(join(root, 'wrong-reserve.log'), 'utf8')).toContain('USDC_FUNDING_CHAIN_ACCOUNTING_MISMATCH');
    expect(await nonces()).toEqual(initial);
    expect(await run('cut-topup', approved, true)).toEqual({ code: null, signal: 'SIGKILL' });
    expect((await run('topup-funded', approved)).code).toBe(0);
    const funded = records(record('topup-funded')['chains'])[0]!;
    expect(requireBoundaryRecord(funded['before'], 'TEST_TOPUP_BEFORE')['hubReserve']).toBe(100_199n);
    expect(requireBoundaryRecord(funded['after'], 'TEST_TOPUP_AFTER')['hubReserve']).toBe(899_801n);
    expect(funded['usdcAtomic']).toBe(799_602n);
    expect(funded['nativeValueWei']).toBe(0n);
    const receipts = records(funded['receipts']);
    expect(receipts.map(row => row['stage'])).toEqual(['approval', 'deposit']);
    expect(await nonces()).toEqual([initial[0]!, initial[1]! + 2]);
    const sourceDepository = Depository__factory.connect(fixture.chains[0]!.contracts.depository, providers[0]);
    const sourceHub = fixture.identities.find(identity => identity.role === 'hub')!.chains[0]!;
    expect(await sourceDepository._reserves(sourceHub.entityId, 1)).toBe(1_000_001n);
    expect((await run('topup-reconfirmed', approved)).code).toBe(0);
    const reconfirmed = records(record('topup-reconfirmed')['chains'])[0]!;
    expect(records(reconfirmed['receipts']).map(row => row['hash'])).toEqual(receipts.map(row => row['hash']));
    expect(await nonces()).toEqual([initial[0]!, initial[1]! + 2]);
    console.log(`USDC_TARGET_TOPUP_LOCAL_EVIDENCE:${root}`);
  } finally {
    for (const provider of providers) provider.destroy();
    await fixture.close();
  }
}, 90_000);

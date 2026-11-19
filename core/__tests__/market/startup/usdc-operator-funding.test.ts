import { expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JsonRpcProvider, Wallet } from 'ethers';
import { Depository__factory, ERC20Mock__factory } from '../../../../jurisdictions/typechain-types';
import { safeParse, safeStringify } from '../../../protocol/serialization';
import { requireBoundaryRecord } from '../../../protocol/boundary-validation';
import { requireSameRestoredProof } from '../../../scenarios/usdc-poc/recovery/evidence';
import { createUsdcFixture, stopFixtureChildren, until } from './usdc-session/fixture';
import { privateDemoFundingLimits, privateFundingLimits } from './usdc-session/funding-limits';
import type { ChildProcess } from 'node:child_process';

const exited = (child: ChildProcess): Promise<number | null> =>
  new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(code));
  });
const record = (path: string) =>
  requireBoundaryRecord(safeParse(readFileSync(path, 'utf8')), 'TEST_FUNDING_RECORD_INVALID');

for (const demo of [false, true]) test(demo
  ? 'one-run demo funding executes nine bounded calls, resumes user-transfer crashes and restores the funded Hub WAL'
  : 'operator funding executes six bounded calls, resumes two crashes and restores the same funded Hub WAL', async () => {
  const fixture = await createUsdcFixture({ reserves: [0n, 0n], operators: 'defer' });
  const { root, stores, apiBase } = fixture;
  const direct = [fixture.rpcUpstreams.get('/rpc')!, fixture.rpcUpstreams.get('/rpc2')!];
  const providers = direct.map(rpc => new JsonRpcProvider(rpc, undefined, { cacheTimeout: -1 }));
  const funder = Wallet.fromPhrase('test test test test test test test test test test test junk');
  const env = {
    ...fixture.roleEnv('user'),
    ETH_SEPOLIA_RPC: direct[0],
    ARB_SEPOLIA_RPC: direct[1],
    USDC_POC_FUNDER_PRIVATE_KEY: funder.privateKey,
  };
  const entry = 'jurisdictions/scripts/usdc-cross-j-preflight/funding/index.ts';
  const fundingRoot = demo ? join(root, 'demo-funding') : root;
  const user = fixture.identities.find(identity => identity.role === 'user')!;
  const limits = demo ? privateDemoFundingLimits(user.chains.map(chain => chain.signerId)) : privateFundingLimits();
  const vaultArgs = demo ? ['--user-vault', join(root, 'user')] : [];
  const completed = demo ? [5, 4] : [3, 3];
  const authorityPath = join(root, 'funding-authority.json');
  const limitsPath = join(root, 'funding-limits.json');
  const args = [
    'run',
    '--directory',
    fundingRoot,
    ...vaultArgs,
    '--authority-file',
    authorityPath,
    '--key-env',
    'USDC_POC_FUNDER_PRIVATE_KEY',
  ];
  const launchRun = (name: string, selected = authorityPath, selectedEnv = env) =>
    fixture.launch(
      name,
      entry,
      [
        'run', '--directory', fundingRoot, ...vaultArgs,
        '--authority-file',
        selected,
        '--key-env',
        'USDC_POC_FUNDER_PRIVATE_KEY',
        '--output',
        join(root, `${name}.json`),
      ],
      selectedEnv,
    );
  const nonces = () => Promise.all(providers.map(p => p.getTransactionCount(funder.address, 'latest')));
  let supervisor: ChildProcess | undefined;
  try {
    if (demo) {
      mkdirSync(fundingRoot, { mode: 0o700 });
      copyFileSync(join(root, 'jurisdictions.json'), join(fundingRoot, 'jurisdictions.json'));
      for (const role of ['hub', 'mm']) symlinkSync(join(root, role), join(fundingRoot, role));
    }
    writeFileSync(limitsPath, safeStringify(limits));
    const initial = await nonces();
    expect(
      await exited(
        fixture.launch(
          'prepare-funding',
          entry,
          [
            'prepare',
            '--directory',
            fundingRoot,
            ...vaultArgs,
            '--funder-address',
            funder.address,
            '--limits-file',
            limitsPath,
            '--output',
            authorityPath,
          ],
          env,
        ),
      ),
    ).toBe(0);
    const proposal = record(authorityPath);
    expect(proposal['approved']).toBeFalse();
    expect(await exited(launchRun('unapproved-funding'))).not.toBe(0);
    expect(readFileSync(join(root, 'unapproved-funding.log'), 'utf8')).toContain('USDC_EXECUTION_AUTHORITY_MISSING');
    for (const [name, patch, message] of [
      ['expired-funding', { approved: true, expiresAt: 0 }, 'USDC_EXECUTION_AUTHORITY_EXPIRED'],
      [
        'stale-funding',
        { approved: true, candidateDigest: '0'.repeat(64) },
        'USDC_EXECUTION_AUTHORITY_CANDIDATE_CHANGED',
      ],
    ] as const) {
      const selected = join(root, `${name}-authority.json`);
      writeFileSync(selected, safeStringify({ ...proposal, ...patch }));
      expect(await exited(launchRun(name, selected))).not.toBe(0);
      expect(readFileSync(join(root, `${name}.log`), 'utf8')).toContain(message);
    }
    expect(await nonces()).toEqual(initial);
    // Approval below is confined to these two private Anvil instances.
    writeFileSync(authorityPath, safeStringify({ ...proposal, approved: true }, 2), { mode: 0o600 });
    expect(
      await exited(
        launchRun('wrong-funder', authorityPath, { ...env, USDC_POC_FUNDER_PRIVATE_KEY: `0x${'11'.repeat(32)}` }),
      ),
    ).not.toBe(0);
    expect(readFileSync(join(root, 'wrong-funder.log'), 'utf8')).toContain('USDC_FUNDING_SIGNER_ADDRESS_MISMATCH');
    expect(await nonces()).toEqual(initial);
    const cuts = demo
      ? [['11155111:user-principal-transfer', 4, 0], ['421614:user-native-topup', 5, 4]] as const
      : [['11155111:approval', 1, 0], ['421614:deposit', 3, 2]] as const;
    for (const [point, sourceUsed, targetUsed] of cuts) {
      const child = fixture.launch(
        `cut-${point.replace(':', '-')}`,
        'core/__tests__/fixtures/usdc-poc/fault-funding.ts',
        [point, ...args, '--output', join(root, 'cut-funding.json')],
        env,
      );
      expect(await exited(child)).toBeNull();
      expect(child.signalCode).toBe('SIGKILL');
      expect(await nonces()).toEqual([initial[0]! + sourceUsed, initial[1]! + targetUsed]);
    }
    expect(await exited(launchRun('funded'))).toBe(0);
    const result = record(join(root, 'funded.json'));
    expect(result['status']).toBe('funded-on-chain');
    expect(await nonces()).toEqual(initial.map((value, index) => value + completed[index]!));
    for (const [index, chain] of fixture.chains.entries()) {
      const depos = Depository__factory.connect(chain.contracts.depository, providers[index]!);
      const token = ERC20Mock__factory.connect(chain.tokens.USDC.address, providers[index]!);
      const hub = fixture.identities.find(value => value.role === 'hub')!.chains[index]!;
      expect(await depos._reserves(hub.entityId, 1)).toBe(BigInt(limits.chains[index]!.amount));
      expect(await providers[index]!.getBalance(hub.signerId)).toBe(
        index === 0 ? 1_000_000_000_000_000n : 100_000_000_000_000n,
      );
      for (const role of fixture.identities) {
        const amount = demo && role.role === 'user' && index === 0 ? 1_000_000n : 0n;
        expect(await token.balanceOf(role.chains[index]!.signerId)).toBe(amount);
      }
      if (demo) {
        expect(await providers[index]!.getBalance(user.chains[index]!.signerId)).toBe(
          index === 0 ? 2_000_000_000_000_000n : 100_000_000_000_000n,
        );
      }
    }
    expect(await exited(launchRun('funding-reconfirmed'))).toBe(0);
    expect(await nonces()).toEqual(initial.map((value, index) => value + completed[index]!));
    await fixture.startOperators();
    expect(
      await exited(
        fixture.launch(
          'accounts',
          'core/__tests__/fixtures/usdc-poc/fund-user.ts',
          [root, apiBase, '--accounts-only'],
          fixture.roleEnv('user'),
        ),
      ),
    ).toBe(0);
    await stopFixtureChildren(fixture.operators);
    const beforePath = join(root, 'hub-before-restore.json');
    expect(
      await exited(
        fixture.launch(
          'inspect-funded-hub',
          'jurisdictions/scripts/usdc-cross-j-preflight/operators/session/inspect.ts',
          [root, 'hub', beforePath],
          { ...fixture.roleEnv('hub'), POC_API_BASE: apiBase },
        ),
      ),
    ).toBe(0);
    supervisor = fixture.launch(
      'funded-session',
      'jurisdictions/scripts/usdc-cross-j-preflight/operators/session/index.ts',
      [
        '--directory',
        root,
        '--hub-store',
        stores.hub,
        '--mm-store',
        stores.mm,
        '--user-store',
        stores.user,
        '--api-base',
        apiBase,
        '--hub-port',
        String(fixture.hubPort),
        '--mm-port',
        String(fixture.mmPort),
        '--external-gateway',
        '--operators-only',
      ],
      env,
    );
    let session = '';
    await until('funded-session-ready', async () => {
      if (supervisor!.exitCode !== null) throw Error(`TEST_FUNDED_SESSION_EXIT:${root}`);
      const sessions = join(root, 'sessions');
      if (!existsSync(sessions)) return false;
      const names = readdirSync(sessions).filter(name => existsSync(join(sessions, name, 'session.json')));
      if (names.length !== 1) return false;
      session = join(sessions, names[0]!);
      return true;
    });
    const before = record(beforePath),
      after = record(join(session, 'hub-restored.json'));
    requireSameRestoredProof(before, after);
    expect(after['reserves']).toEqual(before['reserves']);
    if (!Array.isArray(after['reserves'])) throw Error('TEST_RESTORED_RESERVES_MISSING');
    for (const [index, chain] of fixture.chains.entries()) {
      const hub = fixture.identities
        .find(value => value.role === 'hub')!
        .chains.find(value => value.chainId === chain.chainId)!;
      const rows = after['reserves'].map(value => requireBoundaryRecord(value, 'TEST_RESERVE_ROW'));
      const own = rows.find(row => row['entityId'] === hub.entityId);
      expect(own).toBeDefined();
      expect(own!['reserves']).toEqual([[1, BigInt(limits.chains[index]!.amount)]]);
    }
    expect(await nonces()).toEqual(initial.map((value, index) => value + completed[index]!));
    writeFileSync(
      join(root, 'funding-runtime-proof.json'),
      safeStringify({ before, after, matched: true, originalStores: stores, publicFinancialBroadcasts: 0 }, 2),
    );
    console.log(`USDC_OPERATOR_FUNDING_LOCAL_EVIDENCE:${root}`);
  } finally {
    if (supervisor && supervisor.exitCode === null && supervisor.signalCode === null) {
      const stopped = exited(supervisor);
      supervisor.kill('SIGTERM');
      await stopped;
    }
    for (const provider of providers) provider.destroy();
    await fixture.close();
  }
}, 240_000);

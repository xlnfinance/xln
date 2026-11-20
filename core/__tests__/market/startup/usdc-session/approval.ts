import { JsonRpcProvider, NonceManager, Wallet } from 'ethers';
import { ERC20Mock__factory } from '../../../../../jurisdictions/typechain-types';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { requireBoundaryRecord } from '../../../../protocol/boundary-validation';
import { safeParse, safeStringify } from '../../../../protocol/serialization';
import type { createUsdcFixture } from './fixture';

export type UsdcFixture = Awaited<ReturnType<typeof createUsdcFixture>>;
export const executionEntry = 'jurisdictions/scripts/usdc-cross-j-preflight/execution/index.ts';
export const readReport = (path: string) =>
  requireBoundaryRecord(safeParse(readFileSync(path, 'utf8')), 'TEST_RUN_REPORT');

export const issueAuthority = async (fixture: UsdcFixture, authority: string, ttlMs = 600_000): Promise<void> => {
  const { root, apiBase, stores, roleEnv, launch } = fixture;
  await new Promise<void>((resolve, reject) =>
    launch(
      'accounts',
      'core/__tests__/fixtures/usdc-poc/fund-user.ts',
      [root, apiBase, '--accounts-only'],
      roleEnv('user'),
    ).once('exit', code => (code === 0 ? resolve() : reject(new Error(`TEST_ACCOUNTS_FAILED:${root}`)))),
  );
  const cap = {
    gasLimit: '2000000',
    maxFeePerGasWei: '5000000000',
    maxPriorityFeePerGasWei: '1000000000',
    totalFeeLimitWei: '150000000000000000',
  };
  const limits = join(root, 'limits.json');
  writeFileSync(
    limits,
    safeStringify({
      expiresAt: Date.now() + 600_000,
      runIds: ['demo-01'],
      'source-user': cap,
      'target-hub': cap,
      'target-user': cap,
    }),
  );
  await new Promise<void>((resolve, reject) =>
    launch(
      'prepare',
      executionEntry,
      [
        'prepare',
        '--directory',
        root,
        '--user-store',
        stores.user,
        '--api-base',
        apiBase,
        '--limits-file',
        limits,
        '--output',
        authority,
      ],
      roleEnv('user'),
    ).once('exit', code => (code === 0 ? resolve() : reject(new Error(`TEST_PREPARE_FAILED:${root}`)))),
  );
  writeFileSync(authority, safeStringify({ ...readReport(authority), approved: true, expiresAt: Date.now() + ttlMs }));
};

const walletPhrase = 'test test test test test test test test test test test junk';

export const fundRun = async (fixture: UsdcFixture, source: JsonRpcProvider, target: JsonRpcProvider) => {
  const sponsor = new NonceManager(Wallet.fromPhrase(walletPhrase, source));
  const targetSponsor = new NonceManager(Wallet.fromPhrase(walletPhrase, target));
  const targetHub = fixture.identities.find(identity => identity.role === 'hub')!.chains[1]!;
  const recipient = fixture.identities.find(identity => identity.role === 'user')!.chains[1]!;
  const sourceSigner = fixture.identities.find(identity => identity.role === 'user')!.chains[0]!.signerId;
  const token = ERC20Mock__factory.connect(fixture.chains[0]!.tokens.USDC.address, sponsor);
  await Promise.all([
    (async () => {
      await (await sponsor.sendTransaction({ to: sourceSigner, value: 10n ** 17n })).wait();
      await (await token.transfer(sourceSigner, 1_000_000n)).wait();
    })(),
    (async () => {
      for (const address of [targetHub.signerId, recipient.signerId])
        await (await targetSponsor.sendTransaction({ to: address, value: 10n ** 17n })).wait();
    })(),
  ]);
};

import { expect, test } from 'bun:test';
import { getCreateAddress, toBeHex, zeroPadValue } from 'ethers';
import { readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { EntityProvider__factory } from '../../../../../jurisdictions/typechain-types/factories/EntityProvider__factory';
import type { JurisdictionStackManifest } from '../../../../jurisdiction/adapter/stack-manager/types';
import { startStandaloneNode } from '../support/standalone-deployment-support';
import { until } from '../../stack-manager-recovery/stack-manager-resume-support';

type Fixture = Awaited<ReturnType<typeof startStandaloneNode>>;
type Child = ReturnType<Fixture['start']>;
const readJson = async (path: string) => JSON.parse(await readFile(path, 'utf8'));

const awaitVerification = async (fixture: Fixture, child: Child, name: string): Promise<void> => {
  await until(async () => child.exitCode !== null || (await fixture.read(`${name}.log`)).includes('XLN_DEPLOY_PHASE:verifying'), name);
  if (child.exitCode !== null) throw new Error(await fixture.read(`${name}.log`));
};

const finishAtTwelve = async (fixture: Fixture, child: Child): Promise<void> => {
  const inclusion = BigInt(await fixture.provider.send('eth_blockNumber', []));
  await fixture.provider.send('anvil_mine', ['0xa']);
  expect(BigInt(await fixture.provider.send('eth_blockNumber', [])) - inclusion + 1n).toBe(11n);
  await Bun.sleep(500);
  expect(child.exitCode).toBeNull();
  expect((await readJson(join(fixture.nativeDirectory, 'result.json'))).status).toBe('running');
  expect(await Bun.file(fixture.catalog).exists()).toBeFalse();
  await fixture.provider.send('anvil_mine', ['0x1']);
  expect(await child.exited).toBe(0);
};

const verifyAuthority = async (fixture: Fixture, result: { manifest: JurisdictionStackManifest }, otherInitialNonce: number): Promise<void> => {
  const providerAddress = result.manifest.contracts.entityProvider;
  expect(providerAddress).toBe(getCreateAddress({ from: fixture.signer.address, nonce: fixture.initialNonce + 2 }));
  expect(providerAddress).not.toBe(getCreateAddress({ from: fixture.signer.address, nonce: otherInitialNonce + 2 }));
  const ep = EntityProvider__factory.connect(providerAddress, fixture.provider);
  expect(await ep.entityActionNonces(zeroPadValue(toBeHex(1), 32))).toBe(1n);
  expect(result.manifest.registeredTokens['USDC']).toEqual({ address: fixture.request.stablecoin.address, tokenId: 1, decimals: 6 });
};

const invocationOutcomes = async (directory: string) => {
  const names = await readdir(join(directory, 'invocations'));
  return Promise.all(names.map(name => readJson(join(directory, 'invocations', name, 'result.json'))));
};

test.each([{ cut: 4, extraNonce: 0, otherInitialNonce: 4 }, { cut: 11, extraNonce: 3, otherInitialNonce: 1 }])(
  'native task resumes operation $cut mined before receipt observation without duplicate actions',
  async ({ cut, extraNonce, otherInitialNonce }) => {
    const fixture = await startStandaloneNode(cut, extraNonce);
    let child = fixture.start('new', 'native-interrupted');
    try {
      expect(fixture.initialNonce).toBe(1 + extraNonce);
      await until(async () => fixture.killed() || child.exitCode !== null, `native-cut-${cut}`);
      expect(await child.exited).not.toBe(0);
      expect(fixture.killed()).toBeTrue();
      const cutEvidence = JSON.parse(await fixture.read('cut.json'));
      expect(cutEvidence.cut).toBe(cut);
      expect(cutEvidence.receipt.status).toBe('0x1');
      const atCut = Number(BigInt(await fixture.provider.send('eth_getTransactionCount', [fixture.signer.address, 'latest'])));
      expect(atCut).toBe(fixture.initialNonce + cut);
      const originalJournal = await readFile(join(fixture.nativeDirectory, 'journal.jsonl'), 'utf8');
      const originalInvocation = await readJson(join(fixture.nativeDirectory, 'result.json'));
      expect(originalInvocation.status).toBe('running');
      expect(await Bun.file(fixture.catalog).exists()).toBeFalse();
      const listingPath = join(fixture.nativeDirectory, 'manifest.json.listing.json');
      const originalListing = cut === 11 ? await readFile(listingPath, 'utf8') : null;
      const sendsAtCut = fixture.submissions();

      child = fixture.start('resume', 'native-resumed');
      await awaitVerification(fixture, child, 'native-resumed');
      await finishAtTwelve(fixture, child);
      const result = await readJson(join(fixture.nativeDirectory, 'result.json'));
      expect(result.status).toBe('complete');
      expect(result.manifest.deploymentId).toBe('resume-usdc');
      expect(result.expenses.broadcasts).toBe(11);
      expect(result.expenses.mined).toBe(11);
      expect(fixture.submissions() - sendsAtCut).toBe(11 - cut);
      expect(Number(BigInt(await fixture.provider.send('eth_getTransactionCount', [fixture.signer.address, 'latest'])))).toBe(fixture.initialNonce + 11);
      expect((await readFile(join(fixture.nativeDirectory, 'journal.jsonl'), 'utf8')).startsWith(originalJournal)).toBeTrue();
      if (originalListing !== null) expect(await readFile(listingPath, 'utf8')).toBe(originalListing);
      await verifyAuthority(fixture, result, otherInitialNonce);
      const interrupted = await readJson(join(originalInvocation.invocation, 'result.json'));
      expect(interrupted.status).toBe('interrupted');
      expect(interrupted.invocation).toBe(originalInvocation.invocation);
      expect(interrupted.ownerPid).toBe(originalInvocation.ownerPid);
      expect(interrupted.deploymentId).toBe(originalInvocation.deploymentId);
      expect(interrupted.chainId).toBe(originalInvocation.chainId);
      expect(interrupted.mode).toBe('new');

      const completedJournal = await readFile(join(fixture.nativeDirectory, 'journal.jsonl'), 'utf8');
      const completedListing = await readFile(listingPath, 'utf8');
      const sendsBeforeRerun = fixture.submissions();
      await rm(join(fixture.nativeDirectory, 'manifest.json'));
      child = fixture.start('resume', 'native-completed-rerun');
      expect(await child.exited).toBe(0);
      const rerun = await readJson(join(fixture.nativeDirectory, 'result.json'));
      expect(rerun.status).toBe('complete');
      expect(rerun.manifest).toEqual(result.manifest);
      expect(rerun.expenses).toEqual(result.expenses);
      expect(await readJson(join(fixture.nativeDirectory, 'manifest.json'))).toEqual(result.manifest);
      expect(fixture.submissions()).toBe(sendsBeforeRerun);
      expect(Number(BigInt(await fixture.provider.send('eth_getTransactionCount', [fixture.signer.address, 'latest'])))).toBe(fixture.initialNonce + 11);
      expect(await readFile(listingPath, 'utf8')).toBe(completedListing);
      expect(await readFile(join(fixture.nativeDirectory, 'journal.jsonl'), 'utf8')).toBe(completedJournal);
      expect((await invocationOutcomes(fixture.nativeDirectory)).map(outcome => outcome.status).sort()).toEqual(['complete', 'complete', 'interrupted']);
      expect(await Bun.file(fixture.catalog).exists()).toBeFalse();
      console.log(`STANDALONE_RESUME_EVIDENCE:${fixture.nativeDirectory}:cut=${cut}:initialNonce=${fixture.initialNonce}:operations=11:depth=12`);
    } finally {
      if (child.exitCode === null) { child.kill('SIGTERM'); await child.exited; }
      await fixture.close();
    }
  },
  180_000,
);

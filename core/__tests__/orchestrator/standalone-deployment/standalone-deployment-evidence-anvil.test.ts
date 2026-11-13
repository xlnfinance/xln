import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ERC20Mock__factory } from '../../../../jurisdictions/typechain-types/factories/ERC20Mock__factory';
import { buffersEqual, safeStringify } from '../../../protocol/serialization';
import { until } from '../stack-manager-recovery/stack-manager-resume-support';
import { launchDeployment } from './standalone-deployment-process-support';
import { startStandaloneNode } from './standalone-deployment-support';
import { finish, readJson } from './standalone-deployment-transactions-support';

type Saved = Readonly<{ bytes: Buffer; sha256: string }>;
type Options = NonNullable<Parameters<typeof launchDeployment>[2]>;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const saveBytes = async (path: string): Promise<Saved | null> => {
  try {
    const bytes = await readFile(path);
    return { bytes, sha256: hash(bytes) };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
};
const unchanged = async (path: string, saved: Saved | null): Promise<void> => {
  const current = await saveBytes(path);
  if (saved === null) {
    expect(current).toBeNull();
    return;
  }
  expect(current).not.toBeNull();
  expect(buffersEqual(current!.bytes, saved.bytes)).toBeTrue();
  expect(current!.sha256).toBe(saved.sha256);
};
const changeDigest = (digests: Record<string, string>, choose: (path: string) => boolean) => {
  const path = Object.keys(digests).find(choose);
  if (!path) throw new Error('EVIDENCE_TEST_DIGEST_NOT_FOUND');
  digests[path] = digests[path] === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
};

test('native resume binds sealed evidence and ignores endpoint credentials and derived files', async () => {
  const fixture = await startStandaloneNode(0);
  let session = launchDeployment(fixture, 'evidence-original', { rpcUrl: fixture.directRpcUrl });
  try {
    const originalResult = await finish(fixture, session);
    await session.stop();
    const sealPath = join(fixture.nativeDirectory, 'manifest.json.execution.json');
    const journalPath = join(fixture.nativeDirectory, 'journal.jsonl');
    const originalOutcomePath = join(originalResult.invocation, 'result.json');
    const seal = (await saveBytes(sealPath))!;
    const journal = (await saveBytes(journalPath))!;
    const outcome = (await saveBytes(originalOutcomePath))!;
    const identity = await readJson(sealPath);
    const parameters = await readJson(fixture.parameters);
    const originalJournal = journal.bytes.toString('utf8');
    const nonce = await fixture.provider.send('eth_getTransactionCount', [fixture.signer.address, 'pending']);

    const rejected = async (name: string, pattern: RegExp, options: Options = {}) => {
      const before = fixture.submissions();
      const sealedBefore = await saveBytes(sealPath);
      const journalBefore = await saveBytes(journalPath);
      session = launchDeployment(fixture, name, { mode: 'resume', ...options });
      await until(async () => session.outcome() !== undefined || fixture.submissions() > before, name);
      expect(session.outcome()).not.toBeUndefined();
      expect(await session.exited).not.toBe(0);
      expect(await session.log()).toMatch(pattern);
      expect(fixture.submissions()).toBe(before);
      expect(await fixture.provider.send('eth_getTransactionCount', [fixture.signer.address, 'pending'])).toBe(nonce);
      await unchanged(sealPath, sealedBefore);
      await unchanged(journalPath, journalBefore);
      await unchanged(originalOutcomePath, outcome);
      expect(await Bun.file(fixture.catalog).exists()).toBeFalse();
      await session.stop();
    };
    const mutated = async (name: string, path: string, bytes: string | null, pattern: RegExp) => {
      const original = (await saveBytes(path))!;
      if (bytes === null) await rm(path);
      else await writeFile(path, bytes);
      try {
        await rejected(name, pattern);
      } finally {
        await writeFile(path, original.bytes);
      }
    };
    const identityError = /STACK_MANAGER_EXECUTION_IDENTITY_MISMATCH/;
    await mutated('identity-missing', sealPath, null, /XLN_DEPLOY_FAILED:ENOENT:/);
    await mutated('identity-invalid-json', sealPath, '{invalid-json', /XLN_DEPLOY_FAILED:HARDHAT_DEPLOYMENT_ERROR:/);
    await mutated(
      'identity-truncated-json',
      sealPath,
      seal.bytes.toString('utf8').slice(0, -2),
      /XLN_DEPLOY_FAILED:HARDHAT_DEPLOYMENT_ERROR:/,
    );

    const identityMutations: ReadonlyArray<readonly [string, (value: typeof identity) => void]> = [
      [
        'obsolete',
        value => {
          value.schemaVersion = 0;
        },
      ],
      [
        'source',
        value => {
          changeDigest(value.sources, () => true);
        },
      ],
      [
        'artifact',
        value => {
          changeDigest(value.artifacts, path => path.endsWith('.json') && !path.includes('/build-info/'));
        },
      ],
      [
        'compiler-artifact',
        value => {
          changeDigest(value.artifacts, path => path.includes('/build-info/') && path.endsWith('.json'));
        },
      ],
      [
        'graph',
        value => {
          value.graphVersion = 'obsolete-graph';
        },
      ],
      [
        'policy',
        value => {
          value.policy.executionConfirmations += 1;
        },
      ],
    ];
    for (const [name, mutate] of identityMutations) {
      const changed = structuredClone(identity);
      mutate(changed);
      await mutated(`identity-${name}`, sealPath, safeStringify(changed), identityError);
    }

    await mutated(
      'wrong-chain',
      fixture.parameters,
      safeStringify({ ...parameters, chainId: 31338 }),
      /STACK_MANAGER_CHAIN_ID_MISMATCH/,
    );
    const other = await fixture.provider.getSigner(1);
    await mutated(
      'wrong-foundation',
      fixture.parameters,
      safeStringify({ ...parameters, foundationRecipient: await other.getAddress() }),
      /FOUNDATION_LISTING_SIGNER_MISMATCH/,
    );
    const otherToken = await new ERC20Mock__factory(other).deploy('Other USD Coin', 'USDC', 6, 1_000_000n);
    await otherToken.waitForDeployment();
    await mutated(
      'wrong-existing-token',
      fixture.parameters,
      safeStringify({ ...parameters, stablecoin: { kind: 'existing', address: await otherToken.getAddress() } }),
      identityError,
    );
    await rejected('existing-namespace-new', /STACK_MANAGER_DEPLOYMENT_ATTEMPT_EXISTS/, { mode: 'new' });
    await rejected('wrong-attempt-resume', identityError, { deploymentId: 'another-attempt' });

    await mutated('journal-missing', journalPath, null, /STACK_MANAGER_IGNITION_JOURNAL_MISSING/);
    await mutated(
      'journal-invalid-json',
      journalPath,
      `${originalJournal}{invalid-json\n`,
      /STACK_MANAGER_IGNITION_JOURNAL_INVALID/,
    );
    const messages = originalJournal
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    const sent = messages.find(message => message.type === 'TRANSACTION_SEND');
    expect(sent).toBeDefined();
    sent.nonce += 1;
    await mutated(
      'journal-valid-json-corrupt',
      journalPath,
      `${messages.map(message => safeStringify(message)).join('\n')}\n`,
      /STACK_MANAGER_(?:SENDER_NONCE_CONFLICT|IGNITION_[A-Z_]+)/,
    );
    // Only namespace metadata changes: every recorded execution and receipt stays native.
    const nativeHex = Buffer.from(identity.deploymentId).toString('hex');
    const foreignHex = Buffer.from('foreign-attempt').toString('hex');
    const foreignJournal = originalJournal.replaceAll(`_${nativeHex}#`, `_${foreignHex}#`);
    expect(foreignJournal).not.toBe(originalJournal);
    await mutated('journal-foreign-futures', journalPath, foreignJournal, /STACK_MANAGER_IGNITION_ATTEMPT_MISMATCH/);

    const catalogPoison = '{catalog-must-not-be-read';
    await writeFile(fixture.catalog, catalogPoison);
    try {
      const before = fixture.submissions();
      session = launchDeployment(fixture, 'credential-transport-resume', {
        mode: 'resume',
        rpcUrl: `${fixture.request.rpcUrl}/?api-key=rotated-public-anvil-test-key`,
      });
      expect(await session.exited).toBe(0);
      const resumed = await readJson(join(fixture.nativeDirectory, 'result.json'));
      expect(resumed.manifest).toEqual(originalResult.manifest);
      expect(resumed.expenses.attemptTransactionFeesWei).toBe(originalResult.expenses.attemptTransactionFeesWei);
      expect(resumed.expenses.receipts).toEqual(originalResult.expenses.receipts);
      expect(fixture.submissions()).toBe(before);
      expect(await fixture.provider.send('eth_getTransactionCount', [fixture.signer.address, 'pending'])).toBe(nonce);
      expect(await readFile(fixture.catalog, 'utf8')).toBe(catalogPoison);
      await unchanged(sealPath, seal);
      await unchanged(journalPath, journal);
      await unchanged(originalOutcomePath, outcome);
      await session.stop();
    } finally {
      await rm(fixture.catalog);
    }

    await fixture.provider.send('anvil_setBalance', [fixture.signer.address, '0x0']);
    await rm(join(fixture.nativeDirectory, 'manifest.json'));
    await rm(join(fixture.nativeDirectory, 'result.json'));
    const before = fixture.submissions();
    session = launchDeployment(fixture, 'zero-balance-derived-files-resume', { mode: 'resume' });
    expect(await session.exited).toBe(0);
    const regenerated = await readJson(join(fixture.nativeDirectory, 'result.json'));
    expect(regenerated.manifest).toEqual(originalResult.manifest);
    expect(regenerated.expenses.attemptTransactionFeesWei).toBe(originalResult.expenses.attemptTransactionFeesWei);
    expect(regenerated.expenses.receipts).toEqual(originalResult.expenses.receipts);
    expect(regenerated.expenses.balance.currentWei).toBe('0');
    expect(await readJson(join(fixture.nativeDirectory, 'manifest.json'))).toEqual(originalResult.manifest);
    expect(fixture.submissions()).toBe(before);
    expect(await fixture.provider.getBalance(fixture.signer.address)).toBe(0n);
    expect(await fixture.provider.send('eth_getTransactionCount', [fixture.signer.address, 'pending'])).toBe(nonce);
    await unchanged(sealPath, seal);
    await unchanged(journalPath, journal);
    await unchanged(originalOutcomePath, outcome);
    expect(await Bun.file(fixture.catalog).exists()).toBeFalse();
    console.log(`STANDALONE_EVIDENCE_BINDING:${fixture.nativeDirectory}:seal=${seal.sha256}:journal=${journal.sha256}`);
  } finally {
    await session.stop();
    await fixture.close();
  }
}, 180_000);

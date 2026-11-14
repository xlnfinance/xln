import { expect, test } from 'bun:test';
import { link, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { safeStringify } from '../../../protocol/serialization';
import { startStandaloneNode } from './standalone-deployment-support';
import { launchDeployment } from './standalone-deployment-process-support';
import { finish } from './standalone-deployment-transactions-support';
import { committedDeploymentConfig, directoryDigests, verifyCli } from './standalone-deployment-readonly-support';

const rejectsTamper = async (
  fixture: Awaited<ReturnType<typeof startStandaloneNode>>,
  path: string,
  change: (source: string) => string,
  code: string,
): Promise<void> => {
  const original = await readFile(path, 'utf8');
  try {
    await writeFile(path, change(original));
    const rejected = await verifyCli(fixture);
    expect(rejected.code).not.toBe(0);
    expect(rejected.stderr).toContain(code);
    expect(rejected.stdout).not.toContain('"status": "verified"');
  } finally {
    await writeFile(path, original);
  }
};

test('read-only CLI verifies the original sealed eleven-operation stack without a key, writes only a new report and rejects corrupt inputs', async () => {
  const source = await committedDeploymentConfig();
  const fixture = await startStandaloneNode(0);
  const session = launchDeployment(fixture, 'readonly-original', {
    config: source.config,
    environment: source.environment,
  });
  try {
    const deployed = await finish(fixture, session);
    const before = await directoryDigests(fixture.nativeDirectory);
    const nonce = await fixture.provider.getTransactionCount(fixture.signer.address);
    const sends = fixture.submissions();
    const reportPath = join(fixture.directory, 'readonly-report.json');
    const verified = await verifyCli(fixture, fixture.nativeDirectory, reportPath);
    if (verified.code !== 0) throw new Error(verified.stderr);
    const report = JSON.parse(verified.stdout);
    expect(report.operation).toBe('read-only-existing-stack-verification');
    expect(report.status).toBe('verified');
    expect(report.executionCandidate.sha).toBe(source.sha);
    expect(report.verificationCandidate.sources['jurisdictions/scripts/deployment/operator/readonly.ts']).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(report.currentOperation).toEqual({ signatures: 0, broadcasts: 0 });
    expect(report.checks.nativeIdentityAndOperations).toBe(11);
    expect(report.manifest).toEqual(deployed.manifest);
    expect(report.deploymentExpenses.attemptTransactionFeesWei).toBe(deployed.expenses.attemptTransactionFeesWei);
    expect(report.deploymentExpenses.balance.currentWei).toBe(
      String(await fixture.provider.getBalance(fixture.signer.address)),
    );
    expect(await readFile(reportPath, 'utf8')).toBe(verified.stdout);
    expect(await directoryDigests(fixture.nativeDirectory)).toEqual(before);

    const seal = join(fixture.nativeDirectory, 'manifest.json.execution.json');
    await rejectsTamper(
      fixture,
      seal,
      value => {
        const changed = JSON.parse(value);
        changed.graphVersion = 'foreign-graph';
        return safeStringify(changed);
      },
      'XLN_VERIFY_EXECUTION_IDENTITY_MISMATCH',
    );
    await rejectsTamper(
      fixture,
      seal,
      value => {
        const changed = JSON.parse(value);
        changed.sources['core/hanko/codec.ts'] = '0'.repeat(64);
        return safeStringify(changed);
      },
      'XLN_VERIFY_SOURCE_HASH_MISMATCH',
    );
    await rejectsTamper(
      fixture,
      seal,
      value => {
        const changed = JSON.parse(value);
        delete changed.sources['core/hanko/codec.ts'];
        return safeStringify(changed);
      },
      'XLN_VERIFY_SOURCE_INVENTORY_MISMATCH',
    );
    const artifact = join(fixture.nativeDirectory, 'manifest.json.artifacts/contracts/Account.sol/Account.json');
    await rejectsTamper(fixture, artifact, value => `${value}\n`, 'XLN_VERIFY_ARTIFACT_HASH_MISMATCH');
    const snapshot = join(fixture.nativeDirectory, 'manifest.json.artifacts');
    const movedSnapshot = join(fixture.directory, 'original-artifacts');
    await rename(snapshot, movedSnapshot);
    try {
      await symlink(movedSnapshot, snapshot);
      const rejected = await verifyCli(fixture);
      expect(rejected.code).not.toBe(0);
      expect(rejected.stderr).toContain('XLN_VERIFY_ARTIFACT_SNAPSHOT_INVALID');
    } finally {
      await rm(snapshot);
      await rename(movedSnapshot, snapshot);
    }
    await rejectsTamper(
      fixture,
      join(fixture.nativeDirectory, 'journal.jsonl'),
      value => value.replaceAll(Buffer.from('resume-usdc').toString('hex'), Buffer.from('foreign-id').toString('hex')),
      'STACK_MANAGER_IGNITION_ATTEMPT_MISMATCH',
    );
    await rejectsTamper(
      fixture,
      join(fixture.nativeDirectory, 'manifest.json'),
      value => {
        const changed = JSON.parse(value);
        changed.foundationRecipient = '0x0000000000000000000000000000000000000001';
        return safeStringify(changed);
      },
      'XLN_VERIFY_EXECUTION_IDENTITY_MISMATCH',
    );
    await rejectsTamper(
      fixture,
      join(fixture.nativeDirectory, 'manifest.json'),
      value => {
        const changed = JSON.parse(value);
        changed.evmContracts.shareDepositoryBinding.transactionHash =
          changed.evmContracts.deltaTransformerBinding.transactionHash;
        return safeStringify(changed);
      },
      'XLN_VERIFY_NATIVE_OPERATIONS_MISMATCH',
    );

    const alias = join(fixture.directory, 'native-alias');
    await symlink(fixture.nativeDirectory, alias);
    const hardlink = join(fixture.directory, 'seal-alias.json');
    await link(seal, hardlink);
    for (const output of [
      join(fixture.nativeDirectory, 'new-report.json'),
      join(alias, 'new-report.json'),
      seal,
      hardlink,
      reportPath,
    ]) {
      const rejected = await verifyCli(fixture, fixture.nativeDirectory, output);
      expect(rejected.code).not.toBe(0);
      expect(rejected.stderr).toMatch(/XLN_VERIFY_OUTPUT_(OVERWRITES_INPUT|ALREADY_EXISTS)/);
    }
    expect(await directoryDigests(fixture.nativeDirectory)).toEqual(before);
    expect(fixture.submissions()).toBe(sends);
    expect(await fixture.provider.getTransactionCount(fixture.signer.address)).toBe(nonce);
  } finally {
    await session.stop();
    await fixture.close();
    await source.close();
  }
}, 180_000);

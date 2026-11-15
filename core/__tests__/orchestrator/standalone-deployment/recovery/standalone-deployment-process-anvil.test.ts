import { expect, test } from 'bun:test';
import { closeSync, openSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { startStandaloneNode } from '../support/standalone-deployment-support';
import { launchDeployment, launchUnrelatedProcess } from '../support/standalone-deployment-process-support';
import { until, privateKey } from '../../stack-manager-recovery/stack-manager-resume-support';
import { safeStringify } from '../../../../protocol/serialization';
import { runBoundedCommand } from '../../../../../scripts/verification/process';

type Fixture = Awaited<ReturnType<typeof startStandaloneNode>>;
type Session = ReturnType<typeof launchDeployment>;
const otherKey = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const readJson = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
const resultPath = (fixture: Fixture) => join(fixture.nativeDirectory, 'result.json');

const awaitVerification = async (session: Session): Promise<void> => {
  await until(
    async () => session.outcome() !== undefined || (await session.log()).includes('XLN_DEPLOY_PHASE:verifying'),
    'process-verifying',
  );
  if (session.outcome() !== undefined) throw new Error(await session.log());
};

const assertCompetitors = async (fixture: Fixture, resultBytes: string, sends: number) => {
  const parameters = join(fixture.directory, 'parameters-copy.json');
  await writeFile(parameters, await readFile(fixture.parameters));
  const competitors = [
    { mode: 'resume' as const },
    { deploymentId: 'other-id', directory: join(fixture.directory, 'other-id') },
    { parameters, directory: join(fixture.directory, 'other-output') },
    { key: otherKey, parameters, directory: join(fixture.directory, 'other-signer') },
  ];
  const outcomes = [];
  for (const [index, options] of competitors.entries()) {
    const competitor = launchDeployment(fixture, `competitor-${index}`, options);
    try {
      await until(
        async () => competitor.outcome() !== undefined || fixture.submissions() !== sends,
        `competitor-${index}`,
      );
      expect(fixture.submissions(), `competitor ${index} must send zero transactions`).toBe(sends);
      const code = await competitor.exited;
      expect(code).not.toBe(0);
      expect(await competitor.log()).toMatch(/XLN_DEPLOY_(SIGNER_CHAIN|ATTEMPT)_ACTIVE/);
      expect(await readFile(resultPath(fixture), 'utf8')).toBe(resultBytes);
      outcomes.push({ index, code, additionalSends: fixture.submissions() - sends });
    } finally {
      await competitor.stop();
    }
  }
  return outcomes;
};

const assertStaleObserver = async (fixture: Fixture, original: Session, resultBytes: string, sends: number) => {
  const ownerPath = join(
    process.cwd(),
    'jurisdictions/.xln-deployment-locks/attempts/deployment-resume-usdc/owner.json',
  );
  const actualOwner = await readFile(ownerPath, 'utf8');
  const staleOwner = safeStringify({
    ...JSON.parse(actualOwner),
    pid: original.pid,
    started: original.started,
    pgid: original.pid,
  });
  await writeFile(ownerPath, staleOwner);
  const observer = launchDeployment(fixture, 'stale-observer', { mode: 'resume' });
  try {
    expect(await observer.exited).not.toBe(0);
    expect(await Bun.file(ownerPath).exists()).toBeTrue();
    expect(await readFile(ownerPath, 'utf8')).toBe(staleOwner);
    expect(await observer.log()).toContain('XLN_DEPLOY_ATTEMPT_ACTIVE');
    expect(fixture.submissions()).toBe(sends);
    expect(await readFile(resultPath(fixture), 'utf8')).toBe(resultBytes);
  } finally {
    await observer.stop();
    await mkdir(dirname(ownerPath), { recursive: true });
    await writeFile(ownerPath, actualOwner);
  }
};

const raceResume = async (fixture: Fixture, sends: number) => {
  const sessions = ['resume-a', 'resume-b'].map(name => launchDeployment(fixture, name, { mode: 'resume' }));
  try {
    await until(
      async () =>
        sessions.some(session => session.outcome() !== undefined) &&
        (await Promise.all(sessions.map(session => session.log()))).some(log =>
          log.includes('XLN_DEPLOY_PHASE:verifying'),
        ),
      'resume-race',
    );
    const loser = sessions.find(session => session.outcome() !== undefined)!;
    const winner = sessions.find(session => session.outcome() === undefined)!;
    expect(await loser.exited).not.toBe(0);
    expect(await loser.log()).toContain('XLN_DEPLOY_ATTEMPT_ACTIVE');
    expect((await readJson(resultPath(fixture))).status).toBe('running');
    expect(fixture.submissions()).toBe(sends);
    await fixture.provider.send('anvil_mine', ['0xb']);
    expect(await winner.exited).toBe(0);
    return { winnerPid: winner.pid, loserPid: loser.pid, loserCode: await loser.exited };
  } finally {
    for (const session of sessions) await session.stop();
  }
};

const assertCompletion = async (fixture: Fixture, originalBytes: string, sends: number, initialBalance: bigint) => {
  const result = await readJson(resultPath(fixture));
  expect(result.status).toBe('complete');
  expect(result.expenses.broadcasts).toBe(11);
  expect(result.expenses.mined).toBe(11);
  expect(fixture.submissions()).toBe(sends);
  expect(BigInt(await fixture.provider.send('eth_getTransactionCount', [fixture.signer.address, 'latest']))).toBe(
    BigInt(fixture.initialNonce + 11),
  );
  expect(initialBalance - (await fixture.provider.getBalance(fixture.signer.address))).toBe(
    BigInt(result.expenses.attemptTransactionFeesWei),
  );
  expect((await readJson(join(JSON.parse(originalBytes).invocation, 'result.json'))).status).toBe('interrupted');
  expect(await Bun.file(fixture.catalog).exists()).toBeFalse();
  const journalPath = join(fixture.nativeDirectory, 'journal.jsonl');
  const journal = await readFile(journalPath, 'utf8');
  const rerun = launchDeployment(fixture, 'completed-rerun', { mode: 'resume' });
  try {
    expect(await rerun.exited).toBe(0);
    const repeated = await readJson(resultPath(fixture));
    expect(repeated.manifest).toEqual(result.manifest);
    expect(repeated.expenses).toEqual(result.expenses);
    expect(await readFile(journalPath, 'utf8')).toBe(journal);
    expect(fixture.submissions()).toBe(sends);
  } finally {
    await rerun.stop();
  }
  return result;
};

test('lost launcher retains native ownership across parameters, output paths, signer lanes and resume', async () => {
  const fixture = await startStandaloneNode(0);
  const initialBalance = await fixture.provider.getBalance(fixture.signer.address);
  const decoy = launchUnrelatedProcess();
  const original = launchDeployment(fixture, 'original');
  try {
    await awaitVerification(original);
    const originalBytes = await readFile(resultPath(fixture), 'utf8');
    const owner = JSON.parse(originalBytes).owner;
    expect(owner.pid).not.toBe(original.pid);
    expect(owner.pgid).toBe(original.pid);
    process.kill(original.pid, 'SIGKILL');
    expect(await original.exited).not.toBe(0);
    expect(() => process.kill(owner.pid, 0)).not.toThrow();
    const sends = fixture.submissions();
    expect(sends).toBe(11);
    const competitors = await assertCompetitors(fixture, originalBytes, sends);
    await assertStaleObserver(fixture, original, originalBytes, sends);
    const journal = await readFile(join(fixture.nativeDirectory, 'journal.jsonl'), 'utf8');
    await original.stop();
    expect(() => process.kill(decoy.pid, 0)).not.toThrow();
    const race = await raceResume(fixture, sends);
    expect((await readFile(join(fixture.nativeDirectory, 'journal.jsonl'), 'utf8')).startsWith(journal)).toBeTrue();
    const result = await assertCompletion(fixture, originalBytes, sends, initialBalance);
    expect(() => process.kill(decoy.pid, 0)).not.toThrow();
    await writeFile(
      join(fixture.directory, 'process-proof.json'),
      safeStringify(
        {
          owner,
          launcherPid: original.pid,
          competitors,
          staleGroupRejected: true,
          race,
          unrelatedSurvived: true,
          operations: 11,
          resumeSends: fixture.submissions() - sends,
          nativeFeeWei: result.expenses.attemptTransactionFeesWei,
          receipts: result.expenses.receipts,
        },
        2,
      ),
    );
    console.log(`STANDALONE_PROCESS_EVIDENCE:${fixture.directory}/process-proof.json`);
  } finally {
    await original.stop();
    await decoy.stop();
    await fixture.close();
  }
}, 180_000);

test('native timeout stops only its owned process groups and resumes the retained journal without sends', async () => {
  const fixture = await startStandaloneNode(0);
  const initialBalance = await fixture.provider.getBalance(fixture.signer.address);
  const decoy = launchUnrelatedProcess();
  const log = openSync(join(fixture.directory, 'timeout.log'), 'wx', 0o600);
  // The existing bounded runner owns the real launcher/Hardhat descendants.
  // This process never receives enough blocks to finish before its deadline.
  const environment = {
    DEPLOYER_PRIVATE_KEY: process.env['DEPLOYER_PRIVATE_KEY'],
    XLN_STACK_MANAGER_RPC_URL: process.env['XLN_STACK_MANAGER_RPC_URL'],
    XLN_STACK_MANAGER_CHAIN_ID: process.env['XLN_STACK_MANAGER_CHAIN_ID'],
  };
  Object.assign(process.env, {
    DEPLOYER_PRIVATE_KEY: privateKey,
    XLN_STACK_MANAGER_RPC_URL: fixture.request.rpcUrl,
    XLN_STACK_MANAGER_CHAIN_ID: '31337',
  });
  try {
    const outcome = await runBoundedCommand(
      [
        'bunx',
        'hardhat',
        'xln-deploy',
        '--network',
        'stack-manager',
        '--parameters',
        fixture.parameters,
        '--deployment-id',
        'resume-usdc',
        '--mode',
        'new',
        '--deployment-dir',
        fixture.nativeDirectory,
      ],
      join(process.cwd(), 'jurisdictions'),
      log,
      8_000,
    );
    expect(outcome.timedOut).toBeTrue();
    expect(outcome.error).toBeNull();
    expect(outcome.cleanup).not.toBeNull();
    for (const group of outcome.cleanup!.groups) expect(() => process.kill(-group, 0)).toThrow();
    expect(() => process.kill(decoy.pid, 0)).not.toThrow();
    expect(await readFile(join(fixture.directory, 'timeout.log'), 'utf8')).toContain('XLN_DEPLOY_PHASE:verifying');
    const originalBytes = await readFile(resultPath(fixture), 'utf8');
    expect(JSON.parse(originalBytes).status).toBe('running');
    const sends = fixture.submissions();
    expect(sends).toBe(11);
    const resumed = launchDeployment(fixture, 'timeout-resumed', { mode: 'resume' });
    try {
      await awaitVerification(resumed);
      await fixture.provider.send('anvil_mine', ['0xb']);
      expect(await resumed.exited).toBe(0);
    } finally {
      await resumed.stop();
    }
    const result = await assertCompletion(fixture, originalBytes, sends, initialBalance);
    await writeFile(
      join(fixture.directory, 'timeout-proof.json'),
      safeStringify(
        {
          timedOut: outcome.timedOut,
          cleanup: outcome.cleanup,
          unrelatedSurvived: true,
          operations: 11,
          resumeSends: fixture.submissions() - sends,
          nativeFeeWei: result.expenses.attemptTransactionFeesWei,
          receipts: result.expenses.receipts,
        },
        2,
      ),
    );
    console.log(`STANDALONE_TIMEOUT_EVIDENCE:${fixture.directory}/timeout-proof.json`);
  } finally {
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    closeSync(log);
    await decoy.stop();
    await fixture.close();
  }
}, 60_000);

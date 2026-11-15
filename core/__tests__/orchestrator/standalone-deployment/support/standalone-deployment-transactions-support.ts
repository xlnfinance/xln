import { expect } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startStandaloneNode } from './standalone-deployment-support';
import { launchDeployment } from './standalone-deployment-process-support';
import { until } from '../../stack-manager-recovery/stack-manager-resume-support';

export type Fixture = Awaited<ReturnType<typeof startStandaloneNode>>;
export type Session = ReturnType<typeof launchDeployment>;
export const readJson = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
export const journalMessages = async (fixture: Fixture): Promise<any[]> => {
  const file = Bun.file(join(fixture.nativeDirectory, 'journal.jsonl'));
  if (!(await file.exists())) return [];
  return (await file.text())
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
};
export const sends = async (fixture: Fixture) =>
  (await journalMessages(fixture)).filter(message => message.type === 'TRANSACTION_SEND');

export const waitForSends = async (fixture: Fixture, session: Session, count: number) => {
  await until(
    async () => session.outcome() !== undefined || (await sends(fixture)).length >= count,
    `transaction-send-${count}`,
  );
  if (session.outcome() !== undefined) throw new Error(await session.log());
  return sends(fixture);
};

export const awaitVerification = async (session: Session) => {
  await until(
    async () => session.outcome() !== undefined || (await session.log()).includes('XLN_DEPLOY_PHASE:verifying'),
    'transactions-verifying',
  );
  if (session.outcome() !== undefined) throw new Error(await session.log());
};
export const finish = async (fixture: Fixture, session: Session) => {
  await awaitVerification(session);
  await fixture.provider.send('anvil_mine', ['0xb']);
  expect(await session.exited).toBe(0);
  const result = await readJson(join(fixture.nativeDirectory, 'result.json'));
  expect(result.status).toBe('complete');
  expect(result.expenses.mined).toBe(11);
  expect(BigInt(await fixture.provider.send('eth_getTransactionCount', [fixture.signer.address, 'latest']))).toBe(
    BigInt(fixture.initialNonce + 11),
  );
  return result;
};

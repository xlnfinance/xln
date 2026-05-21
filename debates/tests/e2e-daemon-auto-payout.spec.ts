import { expect, test } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { rmSync } from 'node:fs';

const SERVICE_ENTITY = '0xdebadebadebadebadebadebadebadebadebadebadebadebadebadebadebadeb';
const PAYOUT_ENTITY = '0x3333333333333333333333333333333333333333333333333333333333333333';

const waitForOutput = (proc: ChildProcessWithoutNullStreams, text: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${text}`)), 10_000);
    const onData = (chunk: Buffer) => {
      if (!chunk.toString().includes(text)) return;
      clearTimeout(timeout);
      proc.stdout.off('data', onData);
      resolve();
    };
    proc.stdout.on('data', onData);
    proc.once('exit', code => {
      clearTimeout(timeout);
      reject(new Error(`Process exited before ${text}: ${code}`));
    });
  });

const waitForHealth = async (baseUrl: string): Promise<void> => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch {
      // server is still booting
    }
    await new Promise(resolve => setTimeout(resolve, 125));
  }
  throw new Error(`Timed out waiting for ${baseUrl}`);
};

test('live daemon mode auto-payout queues an XLN HTLC withdrawal to the winner', async ({ browser }) => {
  const daemonPort = 18117;
  const debatesPort = 8117;
  const dbPath = './db-tmp/debates-daemon-e2e.sqlite';
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });

  const daemon = spawn('bun', ['tests/fixtures/fake-daemon.js', String(daemonPort)], { cwd: process.cwd() });
  await waitForOutput(daemon, 'listening');

  const server = spawn('bun', ['server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DEBATES_PORT: String(debatesPort),
      DEBATES_DB_PATH: dbPath,
      DEBATES_DEV_MODE: '1',
      DEBATES_OFFLINE_XLN: '0',
      DEBATES_DAEMON_WS: `ws://127.0.0.1:${daemonPort}/rpc`,
      DEBATES_DAEMON_AUTH_SEED: 'test-seed',
      DEBATES_DAEMON_AUTH_AUDIENCE: SERVICE_ENTITY,
      DEBATES_AI_SERVER_URL: 'http://127.0.0.1:1',
      DEBATES_AI_TIMEOUT_MS: '250',
    },
  });

  try {
    await waitForHealth(`http://127.0.0.1:${debatesPort}`);

    const creator = await browser.newContext();
    const counterparty = await browser.newContext();
    const pageA = await creator.newPage();
    const pageB = await counterparty.newPage();

    await pageA.goto(`http://127.0.0.1:${debatesPort}/`);
    await pageA.getByTestId('dev-fund').click();
    await pageA.getByTestId('statement').fill('Linux beats Windows for senior infrastructure engineers.');
    await pageA.getByTestId('side-a').fill('Linux is the better infrastructure engineering workstation');
    await pageA.getByTestId('side-b').fill('Windows is the better infrastructure engineering workstation');
    await pageA.getByTestId('context').fill('Evaluate production parity, automation, security, hardware, cost, and onboarding.');
    await pageA.getByTestId('stake').fill('10');
    await pageA.getByTestId('rounds').selectOption('1');
    await pageA.getByTestId('auto-payout-a').fill(PAYOUT_ENTITY);
    await pageA.getByTestId('create-challenge').click();

    const invite = await pageA.getByTestId('invite-link').inputValue();
    await pageB.goto(invite);
    await pageB.getByTestId('dev-fund').click();
    await pageB.getByTestId('accept-challenge').click();

    await pageA.reload();
    await pageA.getByTestId('message-body').fill('Linux wins because infrastructure engineers need production parity, SSH-native workflows, reproducible automation, containers, package managers, and low-friction debugging on the same operating model as deployed cloud systems.');
    await pageA.getByTestId('submit-message').click();

    await pageB.reload();
    await pageB.getByTestId('message-body').fill('Windows is familiar and has broad hardware support.');
    await pageB.getByTestId('submit-message').click();

    await pageA.reload();
    await expect(pageA.getByTestId('challenge-status')).toHaveText('ready_for_judging');
    await pageA.getByTestId('run-judges').click();

    await expect(pageA.getByTestId('verdict-panel')).toBeVisible();
    await expect(pageA.getByText('Winner: Side A')).toBeVisible();
    await expect(pageA.getByTestId('auto-payout-status')).toContainText('sent');
    const slug = new URL(pageA.url()).pathname.split('/').pop();
    const detail = await pageA.request.get(`http://127.0.0.1:${debatesPort}/api/challenges/${slug}`);
    expect((await detail.json()).challenge.verdict.payout.autoPayout.hashlock).toContain('fake_hashlock');
    await pageA.getByTestId('dev-ledger').locator('summary').click();
    await pageA.getByTestId('dev-ledger').getByText('withdrawal_reserved').waitFor({ timeout: 10_000 });

    await creator.close();
    await counterparty.close();
  } finally {
    server.kill('SIGTERM');
    daemon.kill('SIGTERM');
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
  }
});

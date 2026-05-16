import { expect, test } from '@playwright/test';

const aArguments = [
  'Linux wins because professional developers need reproducible tooling, package managers, SSH-first workflows, containers, and direct parity with production servers. The evidence is daily: most cloud workloads run on Linux, so the workstation matches the deployment target. However, Windows adds translation layers and policy friction.',
  'The counterargument fails on compatibility. A developer can run Windows-only software in a VM, but Windows cannot match native Linux package repositories, shell automation, and low-friction server debugging. Therefore Linux has the stronger professional default for backend, infra, security, and AI work.',
  'Closing: the question is professional development, not consumer familiarity. Linux provides lower cost, stronger automation, better security posture, and direct production alignment. The evidence and risk tradeoff both point to Linux.',
];

const bArguments = [
  'Windows is familiar and has broad hardware support. It also supports many commercial tools.',
  'Windows can run WSL and has good vendor support.',
  'Windows remains easier for some teams to onboard.',
];

test('paid XLN Debate lifecycle: create, accept, argue, judge, withdraw', async ({ browser, baseURL }) => {
  const creator = await browser.newContext();
  const counterparty = await browser.newContext();
  const pageA = await creator.newPage();
  const pageB = await counterparty.newPage();

  await pageA.goto('/');
  await expect(pageA.getByRole('heading', { name: 'XLN Debates' })).toBeVisible();
  await pageA.getByTestId('deposit-instructions').click();
  await expect(pageA.getByTestId('deposit-box')).toContainText('uid:');
  await pageA.getByTestId('dev-fund').click();
  await expect(pageA.getByTestId('balance-USDC')).toHaveText('250 USDC');

  await pageA.getByTestId('statement').fill('Linux beats Windows for senior infrastructure engineers.');
  await pageA.getByTestId('side-a').fill('Linux is the better infrastructure engineering workstation');
  await pageA.getByTestId('side-b').fill('Windows is the better infrastructure engineering workstation');
  await pageA.getByTestId('context').fill('Evaluate production parity, automation, security, hardware, cost, and onboarding.');
  await pageA.getByTestId('stake').fill('10');
  await pageA.getByTestId('rounds').selectOption('3');
  await pageA.getByTestId('board').selectOption('classic3');
  await pageA.getByTestId('create-challenge').click();

  await expect(pageA.getByTestId('challenge-status')).toHaveText('waiting_for_counterparty');
  const invite = await pageA.getByTestId('invite-link').inputValue();
  expect(invite).toContain('/c/');

  await pageB.goto(invite.replace(baseURL || 'http://127.0.0.1:8097', ''));
  await pageB.getByTestId('dev-fund').click();
  await expect(pageB.getByTestId('balance-USDC')).toHaveText('250 USDC');
  await pageB.getByTestId('accept-challenge').click();
  await expect(pageB.getByTestId('challenge-status')).toHaveText('active');

  await pageA.reload();
  await expect(pageA.getByTestId('challenge-status')).toHaveText('active');

  for (let round = 0; round < 3; round += 1) {
    await pageA.getByTestId('message-body').fill(aArguments[round]!);
    await pageA.getByTestId('submit-message').click();
    await expect(pageA.getByText(aArguments[round]!.slice(0, 36))).toBeVisible();

    await pageB.reload();
    await pageB.getByTestId('message-body').fill(bArguments[round]!);
    await pageB.getByTestId('submit-message').click();
    await expect(pageB.getByText(bArguments[round]!.slice(0, 32))).toBeVisible();

    await pageA.reload();
  }

  await expect(pageA.getByTestId('challenge-status')).toHaveText('ready_for_judging');
  await pageA.getByTestId('run-judges').click();
  await expect(pageA.getByTestId('verdict-panel')).toBeVisible();
  await expect(pageA.getByText('Winner: Side A')).toBeVisible();

  pageA.once('dialog', async dialog => {
    expect(dialog.message()).toContain('Withdrawal finalized');
    await dialog.accept();
  });
  await pageA.getByTestId('target-entity').fill('0x1111111111111111111111111111111111111111111111111111111111111111');
  await pageA.getByTestId('withdraw-amount').fill('20');
  await pageA.getByTestId('withdraw').click();

  await pageA.getByText('withdrawal_reserved').waitFor({ timeout: 10_000 });

  await creator.close();
  await counterparty.close();
});

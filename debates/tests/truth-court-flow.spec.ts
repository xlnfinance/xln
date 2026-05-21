import { expect, test } from '@playwright/test';

const sideAArguments = [
  'Enterprise contracts should come first because this startup needs proof of urgent budget, high willingness to pay, and a repeatable sales narrative. The evidence is concrete: one serious deployment can expose procurement blockers, integration scope, security review, payback period, and renewal risk faster than hundreds of weak signups.',
  'The self-serve objection misses the decision rule. For this market, truth comes from painful workflows with money attached. Enterprise pilots force direct objections, measurable ROI, buyer access, and reference customers, so the company learns what must be true to win.',
];

const sideBArguments = [
  'Self-serve growth is faster because more users can try the product without sales calls.',
  'Enterprise deals can be slow and distract the team.',
];

test('full truth-court flow: weighted model council, custom skills, threshold flags, round verdicts, and final ruling', async ({ browser }) => {
  const creator = await browser.newContext();
  const counterparty = await browser.newContext();
  const pageA = await creator.newPage();
  const pageB = await counterparty.newPage();

  await pageA.goto('/');
  await pageA.getByTestId('dev-fund').click();

  await pageA.getByTestId('custom-skill-label').fill('Startup Shark');
  await pageA.getByTestId('custom-skill-prompt').fill('Judge like a strict Shark Tank investor. Reward urgent customer pain, buyer proof, margins, distribution, retention, and direct answers to objections.');
  await pageA.getByTestId('save-custom-skill').click();
  await expect(pageA.locator('form[data-action="create-challenge"] select[name="chiefSkill"]')).toContainText('Startup Shark custom');

  const form = pageA.locator('form[data-action="create-challenge"]');
  await form.getByTestId('statement').fill('This startup should prioritize enterprise contracts over self-serve growth.');
  await form.getByTestId('side-a').fill('Enterprise first creates stronger proof');
  await form.getByTestId('side-b').fill('Self-serve first creates faster learning');
  await form.getByTestId('context').fill('Evaluate urgency, willingness to pay, sales cycle, activation speed, retention, concentration risk, product learning, and founder focus.');
  await form.getByTestId('stake').fill('0');
  await form.getByTestId('rounds').selectOption('2');
  await form.getByTestId('limit').fill('420');
  await form.getByTestId('threshold').fill('650');
  await form.getByTestId('chief-label').fill('Chief Product Justice');
  await form.locator('select[name="chiefModel"]').selectOption('custom');
  await form.locator('input[name="chiefModelCustom"]').fill('gemma3-chief-local');
  await form.locator('select[name="chiefSkill"]').selectOption({ label: 'Startup Shark custom' });
  await form.getByTestId('chief-standard').fill('Aggregate the Associate Bench by weight, require 650 truth points, and publish a plain-language binding ruling.');
  await form.locator('[data-testid="council-size"]').selectOption('5');

  const row1 = form.locator('.council-row').nth(0);
  await row1.locator('select[name="councilModel1"]').selectOption('custom');
  await row1.locator('input[name="councilModel1Custom"]').fill('gemma4-local-preview');
  await row1.locator('select[name="councilSkill1"]').selectOption({ label: 'Startup Shark custom' });
  await row1.locator('input[name="councilWeight1"]').fill('3');

  const row2 = form.locator('.council-row').nth(1);
  await row2.locator('select[name="councilModel2"]').selectOption('qwen3-235b-mlx');
  await row2.locator('select[name="councilSkill2"]').selectOption('custom');
  await row2.locator('input[name="councilWeight2"]').fill('2');
  await row2.locator('summary').click();
  await row2.locator('input[name="councilCustomSkillLabel2"]').fill('Board Skeptic');
  await row2.locator('textarea[name="councilCustomSkillPrompt2"]').fill('Judge like a skeptical board member. Reward quantified risks, distribution discipline, and honest downside control.');

  const row3 = form.locator('.council-row').nth(2);
  await row3.locator('select[name="councilModel3"]').selectOption('gemma3-27b-mlx');
  await row3.locator('select[name="councilSkill3"]').selectOption('clarity');
  await row3.locator('input[name="councilWeight3"]').fill('1');

  await form.getByTestId('create-challenge').click();
  await expect(pageA.getByTestId('challenge-status')).toHaveText('waiting_for_counterparty');
  await expect(pageA.getByTestId('judge-board-card')).toHaveCount(5);
  await expect(pageA.getByText('weight x3')).toBeVisible();
  await expect(pageA.getByText('gemma4-local-preview')).toBeVisible();
  await expect(pageA.getByText('650 pts')).toBeVisible();

  const slug = new URL(pageA.url()).pathname.split('/').pop();
  const detailAfterCreate = await pageA.request.get(`/api/challenges/${slug}`);
  const created = (await detailAfterCreate.json()).challenge;
  expect(created.rules.winThreshold).toBe(650);
  expect(created.rules.chiefJudge.label).toBe('Chief Product Justice');
  expect(created.rules.chiefJudge.model).toBe('gemma3-chief-local');
  expect(created.rules.chiefJudge.skillLabel).toBe('Startup Shark');
  expect(created.rules.chiefJudge.decisionStandard).toContain('650 truth points');
  expect(created.rules.resolution.answerType).toBe('YES_NO');
  expect(created.rules.resolution.claim).toContain('enterprise contracts');
  expect(created.rules.questionGuardrailPrompt).toContain('XLN Court Framing Agent');
  expect(created.messageLimitChars).toBe(420);
  expect(created.judgeBoard.map((judge: { weight: number }) => judge.weight)).toEqual([3, 2, 1, 1, 1]);
  expect(created.judgeBoard[0].model).toBe('gemma4-local-preview');
  expect(created.judgeBoard[1].label).toContain('Board Skeptic');

  const invite = await pageA.getByTestId('invite-link').inputValue();
  await pageB.goto(invite);
  await pageB.getByTestId('accept-challenge').click();
  await expect(pageB.getByTestId('challenge-status')).toHaveText('active');

  await pageA.reload();
  await expect(pageA.getByTestId('message-body')).toHaveAttribute('maxlength', '420');
  await pageA.getByTestId('message-body').fill(sideAArguments[0]!);
  await pageA.getByTestId('submit-message').click();

  await pageB.reload();
  await pageB.getByTestId('message-body').fill(sideBArguments[0]!);
  await pageB.getByTestId('submit-message').click();
  await expect(pageB.getByTestId('round-score-panel')).toBeVisible({ timeout: 15_000 });
  await expect(pageB.getByTestId('threshold-race')).toContainText('650', { timeout: 15_000 });
  await expect(pageB.getByTestId('judge-flag')).toHaveCount(5, { timeout: 15_000 });
  await expect(pageB.getByTestId('judge-flag').first()).toContainText('x3');
  await expect(pageB.getByTestId('judge-flag').first().locator('.score-towers')).toBeVisible();
  await expect(pageB.getByTestId('judge-flag').first()).toContainText('point edge');
  await expect(pageB.getByTestId('chief-judge')).toContainText('Chief Judge');
  await expect(pageB.getByTestId('chief-judge')).toContainText('Chief Product Justice');
  await expect(pageB.getByTestId('chief-judge')).toContainText('weighted judge points');

  await pageA.reload();
  await pageA.getByTestId('message-body').fill(sideAArguments[1]!);
  await pageA.getByTestId('submit-message').click();

  await pageB.reload();
  await pageB.getByTestId('message-body').fill(sideBArguments[1]!);
  await pageB.getByTestId('submit-message').click();

  await pageA.reload();
  await expect(pageA.getByTestId('challenge-status')).toHaveText('ready_for_judging');
  await pageA.getByTestId('run-judges').click();
  await expect(pageA.getByTestId('verdict-panel')).toBeVisible({ timeout: 15_000 });
  await expect(pageA.getByTestId('threshold-race').first()).toContainText('650');
  await expect(pageA.getByTestId('jury-flags').first()).toBeVisible();
  await expect(pageA.locator('.score-column').first()).toBeVisible();
  await expect(pageA.getByTestId('chief-judge')).toContainText('Chief Judge');
  await expect(pageA.getByTestId('chief-judge')).toContainText('Chief Product Justice');
  await expect(pageA.getByTestId('chief-judge')).toContainText('Final verdict');
  await expect(pageA.getByTestId('verdict-panel')).toContainText('Side A wins');

  const finalDetail = await pageA.request.get(`/api/challenges/${slug}`);
  const finalized = (await finalDetail.json()).challenge;
  expect(finalized.verdict.payout.threshold).toBe(650);
  expect(finalized.verdict.payout.thresholdMet).toBe(true);
  expect(finalized.verdict.payout.totalWeight).toBe(8);

  await creator.close();
  await counterparty.close();
});

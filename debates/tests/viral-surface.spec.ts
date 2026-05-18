import { expect, test } from '@playwright/test';

test('public verdict pages expose OG metadata and share-card SVG', async ({ page, request }) => {
  await page.goto('/');
  await page.getByTestId('seed-demo').click();

  await page.locator('.feed-row').filter({ hasText: 'Side A 866-742 (+124)' }).click();
  await expect(page.getByTestId('verdict-panel')).toBeVisible();
  const slug = new URL(page.url()).pathname.split('/').pop();
  expect(slug).toBeTruthy();

  const html = await request.get(`/v/${slug}`);
  expect(html.ok()).toBe(true);
  const body = await html.text();
  expect(body).toContain('property="og:image"');
  expect(body).toContain(`/api/challenges/${slug}/card.svg`);
  expect(body).toContain('name="twitter:card" content="summary_large_image"');

  const head = await request.head(`/api/challenges/${slug}/card.svg`);
  expect(head.ok()).toBe(true);
  expect(head.headers()['content-type']).toContain('image/svg+xml');

  const svg = await request.get(`/api/challenges/${slug}/card.svg`);
  expect(svg.ok()).toBe(true);
  const svgBody = await svg.text();
  expect(svgBody).toContain('XLN Debates');
  expect(svgBody).toContain('Decisive:');
  expect(svgBody).toContain('866 - 742');

  const embed = await request.get(`/embed/v/${slug}`);
  expect(embed.ok()).toBe(true);
  const embedBody = await embed.text();
  expect(embedBody).toContain('XLN Debates Embed');
  expect(embedBody).toContain('settled via XLN');
});

test('AI Gladiator generates a finalized exhibition match', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('AI vs AI gladiator')).toBeVisible();
  await expect(page.getByText('Product Superset')).toBeVisible();
  await page.getByTestId('gladiator-topic').fill('SQLite is a better default database than Postgres for early-stage products.');
  await page.getByTestId('run-gladiator').click();

  await expect(page.getByTestId('verdict-panel')).toBeVisible({ timeout: 20_000 });
  await expect(page).toHaveURL(/\/v\//);
  await expect(page.getByText('Winner: Side')).toBeVisible();
  await expect(page.locator('.transcript')).toContainText('4/4');
  await expect(page.getByTestId('verdict-card')).toBeVisible();
  await expect(page.getByText('Public verdict card')).toBeVisible();
});

test('settle a post creates a shareable verdict from a URL', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('settle-url').fill('https://example.com/post/open-models');
  await page.getByTestId('settle-post').click();

  await expect(page.getByTestId('verdict-panel')).toBeVisible({ timeout: 20_000 });
  await expect(page).toHaveURL(/\/v\//);
  await expect(page.getByRole('heading', { name: 'The central claim in this post withstands adversarial scrutiny' })).toBeVisible();
  await expect(page.getByText('Public verdict card')).toBeVisible();
});

test('model registry and custom skills are available in the council builder', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('select[name="sideAModel"]')).toContainText('Gemma 3');
  await expect(page.locator('input[name="sideAModelCustom"]')).toBeVisible();

  await page.getByTestId('custom-skill-label').fill('Startup Shark');
  await page.getByTestId('custom-skill-prompt').fill('Judge like a strict startup investor. Reward traction, margin, distribution, customer pain, and direct answers to hard objections.');
  await page.getByTestId('save-custom-skill').click();

  await expect(page.locator('select[name="councilSkill1"]').first()).toContainText('Startup Shark custom');
});

test('custom model ids, saved skills, and inline skills persist into a human challenge council', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('dev-fund').click();

  await page.getByTestId('custom-skill-label').fill('Startup Shark');
  await page.getByTestId('custom-skill-prompt').fill('Judge like a strict startup investor. Reward traction, margin, distribution, customer pain, and direct answers to hard objections.');
  await page.getByTestId('save-custom-skill').click();
  await expect(page.locator('form[data-action="create-challenge"] select[name="councilSkill1"]')).toContainText('Startup Shark custom');

  const creator = page.locator('form[data-action="create-challenge"]');
  await creator.getByTestId('statement').fill('This startup should prioritize enterprise contracts over self-serve growth.');
  await creator.getByTestId('side-a').fill('Enterprise contracts create better proof and revenue quality');
  await creator.getByTestId('side-b').fill('Self-serve growth creates faster learning and distribution');
  await creator.getByTestId('context').fill('Evaluate traction, payback period, sales motion, concentration risk, activation, and founder focus.');
  await creator.getByTestId('stake').fill('0');

  await creator.locator('select[name="councilModel1"]').selectOption('custom');
  await creator.locator('input[name="councilModel1Custom"]').fill('gemma4-local-preview');
  await creator.locator('select[name="councilSkill1"]').selectOption({ label: 'Startup Shark custom' });

  await creator.locator('select[name="councilSkill2"]').selectOption('custom');
  const secondCouncilRow = creator.locator('.council-row').nth(1);
  await secondCouncilRow.locator('summary').click();
  await secondCouncilRow.locator('input[name="councilCustomSkillLabel2"]').fill('Boardroom Skeptic');
  await secondCouncilRow.locator('textarea[name="councilCustomSkillPrompt2"]').fill('Challenge every claim like a disciplined public-company board member. Reward crisp numbers, downside control, and honest risk framing.');

  await creator.getByTestId('create-challenge').click();
  await expect(page.getByTestId('challenge-status')).toHaveText('waiting_for_counterparty');
  await expect(page.getByText('Startup Shark 1')).toBeVisible();
  await expect(page.getByText('gemma4-local-preview')).toBeVisible();
  await expect(page.getByText('Boardroom Skeptic 2')).toBeVisible();
});

test('AI model registry endpoint returns local/fallback models for the UI', async ({ request }) => {
  const response = await request.get('/api/ai/models');
  expect(response.ok()).toBe(true);
  const body = await response.json();
  expect(body.ok).toBe(true);
  expect(body.models.map((model: { id: string }) => model.id)).toContain('gemma3-27b-mlx');
  expect(body.models.map((model: { id: string }) => model.id)).toContain('qwen3-235b-mlx');
});

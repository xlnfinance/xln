import { expect, test } from '@playwright/test';

test('demo seed creates five finalized court cases with 1000-point verdict margins', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('seed-demo').click();

  await expect(page.getByText('Public Arena')).toBeVisible();
  await expect(page.locator('.feed-row').filter({ hasText: 'Side A 866-742 (+124)' })).toBeVisible();
  await expect(page.locator('.feed-row').filter({ hasText: 'Side B 718-794 (+76)' })).toBeVisible();
  await expect(page.locator('.feed-row').filter({ hasText: 'Side A 901-684 (+217)' })).toBeVisible();
  await expect(page.locator('.feed-row').filter({ hasText: 'Side B 733-821 (+88)' })).toBeVisible();
  await expect(page.locator('.feed-row').filter({ hasText: 'Side A 842-711 (+131)' })).toBeVisible();

  await page.locator('.feed-row').filter({ hasText: 'Side A 866-742 (+124)' }).click();
  await expect(page.getByTestId('verdict-panel')).toBeVisible();
  await expect(page.getByText('Winner: Side A')).toBeVisible();
  await expect(page.locator('.judge-panel.verdict')).toContainText('Side A wins 866-742 by a 124-point margin');
  await expect(page.getByTestId('chief-judge')).toContainText('Side A wins 866-742 by a 124-point margin');
  await expect(page.locator('.score-card')).toContainText('Side A');
  await expect(page.locator('.score-card')).toContainText('866');
  await expect(page.locator('.score-card')).toContainText('Margin');
  await expect(page.locator('.score-card')).toContainText('124');
  await expect(page.getByTestId('verdict-card')).toBeVisible();

  const slug = new URL(page.url()).pathname.split('/').pop();
  const card = await page.request.get(`/api/challenges/${slug}/card.svg`);
  expect(card.ok()).toBe(true);
  expect(card.headers()['content-type']).toContain('image/svg+xml');
  expect(await card.text()).toContain('XLN Debates');

  await page.getByTestId('rematch').click();
  await expect(page.getByTestId('challenge-status')).toHaveText('waiting_for_counterparty');
  await expect(page.getByTestId('invite-link')).toHaveValue(/\/c\//);
});

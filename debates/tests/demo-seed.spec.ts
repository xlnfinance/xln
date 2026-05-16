import { expect, test } from '@playwright/test';

test('demo seed creates five finalized court cases with 1000-point verdict margins', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('seed-demo').click();

  await expect(page.getByText('Public Arena')).toBeVisible();
  await expect(page.getByText('Side A 866-742 (+124)')).toBeVisible();
  await expect(page.getByText('Side B 718-794 (+76)')).toBeVisible();
  await expect(page.getByText('Side A 901-684 (+217)')).toBeVisible();
  await expect(page.getByText('Side B 733-821 (+88)')).toBeVisible();
  await expect(page.getByText('Side A 842-711 (+131)')).toBeVisible();

  await page.locator('.feed-row').filter({ hasText: 'Side A 866-742 (+124)' }).click();
  await expect(page.getByTestId('verdict-panel')).toBeVisible();
  await expect(page.getByText('Winner: Side A')).toBeVisible();
  await expect(page.getByText('Side A wins 866-742 by a 124-point margin')).toBeVisible();
  await expect(page.locator('.score-card')).toContainText('Side A');
  await expect(page.locator('.score-card')).toContainText('866');
  await expect(page.locator('.score-card')).toContainText('Margin');
  await expect(page.locator('.score-card')).toContainText('124');
});

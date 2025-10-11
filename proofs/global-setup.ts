import { test as base } from '@playwright/test';

// Extended test with global beforeEach setup
export const test = base.extend({});

// Global setup that runs before each test
test.beforeEach(async ({ page }) => {
  // Ensure consistent viewport across all tests
  await page.setViewportSize({ width: 1920, height: 1080 });
});

// Re-export expect for convenience
export { expect } from '@playwright/test';

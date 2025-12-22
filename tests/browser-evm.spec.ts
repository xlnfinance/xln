import { test, expect } from '@playwright/test';

test('BrowserEVM - Deploy and call Depository.sol', async ({ page }) => {
  // Start local server if needed
  // For now, assume we're running `bun run serve` or similar

  await page.goto('http://localhost:3000/test-browser-evm.html');

  // Wait for status to show success (max 30s for large contract deployment)
  const status = page.locator('#status');
  await expect(status).toContainText('SUCCESS', { timeout: 30000 });

  // Verify logs contain expected output
  const log = page.locator('#log');
  const logText = await log.textContent();

  expect(logText).toContain('Loaded Depository.sol');
  expect(logText).toContain('Created EthereumJS VM');
  expect(logText).toContain('Funded deployer');
  expect(logText).toContain('Deployed at: 0x');
  expect(logText).toContain('Gas used:');
  expect(logText).toContain('Transaction executed');
  expect(logText).toContain('Logs emitted: 1');

  // Check console for errors
  const errors: string[] = [];
  page.on('console', msg => {
    if (msg.type() === 'error') {
      errors.push(msg.text());
    }
  });

  expect(errors).toHaveLength(0);
});

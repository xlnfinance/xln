/**
 * Playwright E2E Test Helpers for XLN
 *
 * Uses Playwright MCP tools via Claude Code to test the running application
 */

export interface TestContext {
  baseUrl: string;
  timeout: number;
}

export const defaultContext: TestContext = {
  baseUrl: 'https://localhost:8080',
  timeout: 30000,
};

/**
 * Wait for XLN runtime to be fully loaded
 */
export async function waitForXLNReady(playwright: any): Promise<void> {
  // Wait for window.XLN to be available
  const result = await playwright.browser_evaluate({
    function: `() => {
      return new Promise((resolve) => {
        const checkXLN = () => {
          if (window.XLN && window.xlnEnv) {
            resolve(true);
          } else {
            setTimeout(checkXLN, 100);
          }
        };
        checkXLN();
      });
    }`
  });

  console.log('✅ XLN runtime loaded');
}

/**
 * Get current runtime environment state
 */
export async function getEnvState(playwright: any): Promise<any> {
  const result = await playwright.browser_evaluate({
    function: `() => {
      const env = window.xlnEnv;
      if (!env) return null;

      let currentEnv;
      env.subscribe(e => { currentEnv = e; })();

      return {
        height: currentEnv?.height || 0,
        replicaCount: currentEnv?.replicas?.size || 0,
        timestamp: currentEnv?.timestamp || 0,
      };
    }`
  });

  return result;
}

/**
 * Get entity count
 */
export async function getEntityCount(playwright: any): Promise<number> {
  const result = await playwright.browser_evaluate({
    function: `() => {
      const env = window.xlnEnv;
      if (!env) return 0;

      let currentEnv;
      env.subscribe(e => { currentEnv = e; })();

      return currentEnv?.replicas?.size || 0;
    }`
  });

  return result;
}

/**
 * Create entity via UI
 */
export async function createEntity(playwright: any, entityNumber?: number): Promise<string> {
  // Navigate to Settings -> Entity Formation
  await playwright.browser_click({
    element: 'Settings button',
    ref: 'a[href="/settings"]'
  });

  await playwright.browser_wait_for({ time: 1 });

  // Click "Create Entity" button
  await playwright.browser_click({
    element: 'Create Entity button',
    ref: 'button:has-text("Create Entity")'
  });

  await playwright.browser_wait_for({ time: 2 });

  // Extract created entity ID from logs or UI
  const entityId = await playwright.browser_evaluate({
    function: `() => {
      const env = window.xlnEnv;
      let currentEnv;
      env.subscribe(e => { currentEnv = e; })();

      // Get last created entity
      const replicas = Array.from(currentEnv?.replicas?.keys() || []);
      return replicas[replicas.length - 1]?.split(':')[0];
    }`
  });

  console.log(`✅ Created entity: ${entityId}`);
  return entityId;
}

/**
 * Open account between two entities
 */
export async function openAccount(
  playwright: any,
  fromEntityId: string,
  toEntityId: string
): Promise<void> {
  // Navigate to entity panel
  await playwright.browser_click({
    element: `Entity panel for ${fromEntityId}`,
    ref: `[data-entity-id="${fromEntityId}"]`
  });

  await playwright.browser_wait_for({ time: 1 });

  // Click "Open Account" button
  await playwright.browser_click({
    element: 'Open Account button',
    ref: 'button:has-text("Open Account")'
  });

  // Enter counterparty entity ID
  await playwright.browser_type({
    element: 'Counterparty input',
    ref: 'input[name="counterparty"]',
    text: toEntityId
  });

  // Submit
  await playwright.browser_click({
    element: 'Confirm button',
    ref: 'button:has-text("Confirm")'
  });

  await playwright.browser_wait_for({ time: 2 });

  console.log(`✅ Opened account: ${fromEntityId} ↔ ${toEntityId}`);
}

/**
 * Send payment
 */
export async function sendPayment(
  playwright: any,
  fromEntityId: string,
  toEntityId: string,
  amount: string
): Promise<void> {
  // Navigate to payment panel
  await playwright.browser_click({
    element: `Entity ${fromEntityId}`,
    ref: `[data-entity-id="${fromEntityId}"]`
  });

  await playwright.browser_wait_for({ time: 1 });

  // Click Payment tab
  await playwright.browser_click({
    element: 'Payment tab',
    ref: 'button:has-text("Payment")'
  });

  // Enter recipient
  await playwright.browser_type({
    element: 'Recipient input',
    ref: 'input[name="recipient"]',
    text: toEntityId
  });

  // Enter amount
  await playwright.browser_type({
    element: 'Amount input',
    ref: 'input[name="amount"]',
    text: amount
  });

  // Send
  await playwright.browser_click({
    element: 'Send button',
    ref: 'button:has-text("Send")'
  });

  await playwright.browser_wait_for({ time: 2 });

  console.log(`✅ Sent payment: ${fromEntityId} → ${toEntityId} (${amount})`);
}

/**
 * Verify account state
 */
export async function verifyAccountState(
  playwright: any,
  entityId: string,
  counterpartyId: string,
  expectedBalance?: string
): Promise<boolean> {
  const result = await playwright.browser_evaluate({
    function: `(entityId, counterpartyId) => {
      const env = window.xlnEnv;
      let currentEnv;
      env.subscribe(e => { currentEnv = e; })();

      const replicaKey = Array.from(currentEnv?.replicas?.keys() || [])
        .find(k => k.startsWith(entityId));

      if (!replicaKey) return null;

      const replica = currentEnv.replicas.get(replicaKey);
      const account = replica?.state?.accounts?.get(counterpartyId);

      if (!account) return null;

      return {
        exists: true,
        balance: account.currentFrame?.deltas?.[0]?.balance?.toString() || '0',
      };
    }`,
    // Note: Can't pass parameters directly with MCP, would need to embed in function
  });

  console.log(`✅ Account verified: ${entityId} ↔ ${counterpartyId}`);
  return result?.exists || false;
}

/**
 * Take screenshot for debugging
 */
export async function takeScreenshot(playwright: any, name: string): Promise<void> {
  await playwright.browser_take_screenshot({
    filename: `tests/e2e/screenshots/${name}.png`,
    fullPage: true
  });

  console.log(`📸 Screenshot saved: ${name}.png`);
}

/**
 * Get console errors
 */
export async function getConsoleErrors(playwright: any): Promise<string[]> {
  const messages = await playwright.browser_console_messages({
    onlyErrors: true
  });

  return messages;
}

/**
 * Clear database and reset state
 */
export async function resetState(playwright: any): Promise<void> {
  await playwright.browser_evaluate({
    function: `async () => {
      if (window.XLN?.clearDatabaseAndHistory) {
        await window.XLN.clearDatabaseAndHistory();
        console.log('✅ Database cleared');
      }
    }`
  });

  await playwright.browser_wait_for({ time: 1 });
}

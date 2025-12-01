import { test, expect } from '@playwright/test';

/**
 * AI Chat E2E Tests
 *
 * Prerequisites:
 * - Frontend dev server: bun run dev (https://localhost:8080)
 * - AI server: cd ~/ai && bun run server.ts (http://localhost:3031)
 * - Ollama: ollama serve (http://localhost:11434)
 */

test.describe('AI Chat - Basic Text Chat', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/ai');
    // Wait for page to load - check for chat header
    await expect(page.locator('.chat-header')).toBeVisible({ timeout: 10000 });
  });

  test('page loads with correct elements', async ({ page }) => {
    // Check header exists
    await expect(page.locator('.chat-header')).toBeVisible();

    // Check textarea exists (the input is a textarea, not input)
    const textarea = page.locator('textarea');
    await expect(textarea).toBeVisible();

    // Check send button exists
    const sendButton = page.locator('.send-btn');
    await expect(sendButton).toBeVisible();

    // Check model selector exists
    const modelSelect = page.locator('select').first();
    await expect(modelSelect).toBeVisible();

    // Check MIC and CAM buttons exist
    await expect(page.locator('.icon-btn').first()).toBeVisible();
  });

  test('can send a message and receive response', async ({ page }) => {
    // Type a simple message in textarea
    const textarea = page.locator('textarea');
    await textarea.fill('What is 2+2? Reply with just the number.');

    // Click send
    const sendButton = page.locator('.send-btn');
    await sendButton.click();

    // User message should appear
    await expect(page.locator('.message.user')).toContainText('2+2', { timeout: 10000 });

    // Wait for assistant response (may take a while with local LLM)
    const assistantMessage = page.locator('.message.assistant');
    await expect(assistantMessage).toBeVisible({ timeout: 120000 });

    // Response should have some content
    const content = page.locator('.message.assistant .message-content');
    await expect(content).not.toBeEmpty({ timeout: 120000 });
  });

  test('can change model selection', async ({ page }) => {
    const modelSelect = page.locator('select').first();

    // Get available options
    const options = await modelSelect.locator('option').allTextContents();
    expect(options.length).toBeGreaterThan(0);

    // Should be able to select a different model
    if (options.length > 1) {
      await modelSelect.selectOption({ index: 1 });
    }
  });

  test('council mode toggle works', async ({ page }) => {
    // Find council mode checkbox
    const councilToggle = page.locator('.council-toggle input[type="checkbox"]');
    await expect(councilToggle).toBeVisible();

    // Toggle it on
    await councilToggle.check();
    expect(await councilToggle.isChecked()).toBe(true);

    // Model selector should be disabled in council mode
    const modelSelect = page.locator('.model-selector select');
    await expect(modelSelect).toBeDisabled();

    // Toggle back off
    await councilToggle.uncheck();
    expect(await councilToggle.isChecked()).toBe(false);
    await expect(modelSelect).toBeEnabled();
  });
});

test.describe('AI Chat - Camera', () => {
  test('camera toggle button exists', async ({ page }) => {
    await page.goto('/ai');
    await expect(page.locator('.chat-header')).toBeVisible({ timeout: 10000 });

    // Look for camera button by title attribute
    const cameraButton = page.locator('button[title="Camera vision"]');
    await expect(cameraButton).toBeVisible();
    await expect(cameraButton).toContainText('CAM');
  });
});

test.describe('AI Chat - Voice', () => {
  test('voice toggle button exists', async ({ page }) => {
    await page.goto('/ai');
    await expect(page.locator('.chat-header')).toBeVisible({ timeout: 10000 });

    // Look for microphone button by title containing "Voice"
    const voiceButton = page.locator('button[title*="Voice"]');
    await expect(voiceButton).toBeVisible();
    // Button shows "MIC" when inactive, "..." when listening
    const text = await voiceButton.textContent();
    expect(text === 'MIC' || text === '...').toBe(true);
  });
});

test.describe('AI Server API', () => {
  test('models endpoint returns available models', async ({ request }) => {
    const response = await request.get('http://localhost:3031/api/models');
    expect(response.ok()).toBeTruthy();

    const data = await response.json();
    expect(data.models).toBeDefined();
    expect(Array.isArray(data.models)).toBeTruthy();
    expect(data.models.length).toBeGreaterThan(0);
    expect(data.default_model).toBeDefined();
  });

  test('chat endpoint accepts messages and returns response', async ({ request }) => {
    const response = await request.post('http://localhost:3031/api/chat', {
      data: {
        model: 'qwen3-coder:latest',
        messages: [{ role: 'user', content: 'Say "test" and nothing else' }],
        stream: false
      }
    });
    expect(response.ok()).toBeTruthy();

    const data = await response.json();
    // API returns {content, model} not {message: {content}}
    expect(data.content).toBeDefined();
    expect(typeof data.content).toBe('string');
    expect(data.content.length).toBeGreaterThan(0);
  });

  test('Ollama is running', async ({ request }) => {
    const response = await request.get('http://localhost:11434/api/tags');
    expect(response.ok()).toBeTruthy();

    const data = await response.json();
    expect(data.models).toBeDefined();
    expect(Array.isArray(data.models)).toBeTruthy();
  });
});

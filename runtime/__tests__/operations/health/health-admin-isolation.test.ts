import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const readSource = (relativePath: string): string =>
  readFileSync(resolve(process.cwd(), relativePath), 'utf8');

test('health admin route reads only health/debug surfaces and links to QA', () => {
  const route = readSource('frontend/src/routes/health/+page.svelte');
  const qaLinkPanel = readSource('frontend/src/lib/components/Health/HealthQaLinkPanel.svelte');

  for (const forbidden of [
    "from '$lib/qa/apiClient'",
    'QaRunsPanel',
    'QaCockpitEmbedPanel',
    'QaProtectedImage',
    '/api/qa/',
    'api/qa/',
  ]) {
    expect(route).not.toContain(forbidden);
  }

  expect(route).toContain("fetch('/api/health')");
  expect(route).toContain('runtimeQueryClient.readActivity({ limit: 1000, scanLimit: 1000 })');
  expect(route).toContain('runtimeQueryClient.readEntities({ limit: 1000 })');
  expect(route).toContain('HealthQaLinkPanel');
  expect(qaLinkPanel).toContain('href="/qa"');
  expect(qaLinkPanel).not.toContain('fetch(');
  expect(qaLinkPanel).not.toContain('<iframe');
});

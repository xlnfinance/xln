import { expect, test } from 'bun:test';

import { maybeHandleQaRequest } from '../qa/api';
import { listQaStoryScreenshots, resolveQaStoryScreenshotPath } from '../qa/report';

test('qa stories catalog indexes real e2e screenshots', async () => {
  const stories = await listQaStoryScreenshots(20);
  const e2eStory = stories.find(story => story.source === 'e2e-screenshots');

  expect(e2eStory).toBeDefined();
  expect(e2eStory?.url.startsWith('/api/qa/story-image?')).toBe(true);
  expect(e2eStory?.relativePath.includes('..')).toBe(false);
  expect(e2eStory?.sizeBytes ?? 0).toBeGreaterThan(0);
});

test('qa story image resolver rejects path traversal', async () => {
  await expect(resolveQaStoryScreenshotPath('e2e-screenshots', '../package.json')).rejects.toThrow(
    'INVALID_QA_STORY_IMAGE_PATH',
  );
});

test('qa stories api returns screenshot catalog', async () => {
  const response = await maybeHandleQaRequest(
    new Request('http://127.0.0.1:8080/api/qa/stories?limit=3'),
    '/api/qa/stories',
    { 'content-type': 'application/json' },
  );
  expect(response).not.toBeNull();
  expect(response?.status).toBe(200);

  const payload = await response?.json() as {
    ok?: boolean;
    stories?: Array<{ source?: string; url?: string }>;
  };
  expect(payload.ok).toBe(true);
  expect(payload.stories?.length).toBeGreaterThan(0);
  expect(payload.stories?.[0]?.url?.startsWith('/api/qa/')).toBe(true);
});

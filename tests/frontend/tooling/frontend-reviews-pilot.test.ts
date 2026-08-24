import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  getReviewText,
  REVIEW_MODELS,
  REVIEW_PROMPTS,
} from '../../../frontend/src/lib/reviews/reviews-model';

const ROOT = resolve(import.meta.dir, '../../..');

describe('React reviews pilot', () => {
  test('preserves the canonical five-prompt, four-model matrix', () => {
    expect(REVIEW_PROMPTS.map(({ title }) => title)).toEqual([
      'Explain xln to a 5-year-old',
      "Why Lightning failed but xln won't",
      'xln vs all rollups in one tweet',
      'The RCPAN invariant for mathematicians',
      'Convince a bank CEO to pilot xln',
    ]);
    expect(REVIEW_MODELS.map(({ id }) => id)).toEqual(['sonnet-4', 'gpt-4', 'gemini-2', 'claude-opus']);
    expect(REVIEW_MODELS.every(({ reviews }) => reviews.length === REVIEW_PROMPTS.length)).toBe(true);
    expect(REVIEW_MODELS.flatMap(({ reviews }) => reviews).every((review) => review.length > 0)).toBe(true);
  });

  test('selects one synchronized perspective per model and rejects invalid indexes', () => {
    expect(getReviewText(REVIEW_MODELS[0], 0)).toContain("Lightning's inbound liquidity wall");
    expect(getReviewText(REVIEW_MODELS[3], 4)).toContain('Remove trust assumptions');
    expect(() => getReviewText(REVIEW_MODELS[0], -1)).toThrow('REVIEW_PROMPT_INDEX_INVALID:-1');
    expect(() => getReviewText(REVIEW_MODELS[0], REVIEW_PROMPTS.length)).toThrow('REVIEW_PROMPT_INDEX_INVALID:5');
    expect(() => getReviewText(REVIEW_MODELS[0], 1.5)).toThrow('REVIEW_PROMPT_INDEX_INVALID:1.5');
  });

  test('keeps React and Svelte on the shared review content source', () => {
    const reactSource = readFileSync(resolve(ROOT, 'frontend/apps/site/src/reviews-page.tsx'), 'utf8');
    const svelteSource = readFileSync(resolve(ROOT, 'frontend/src/routes/reviews/+page.svelte'), 'utf8');

    expect(reactSource).toContain("from '$lib/reviews/reviews-model'");
    expect(reactSource).toContain('aria-live="polite"');
    expect(reactSource).not.toContain('fetch(');
    expect(svelteSource).toContain("from '$lib/reviews/reviews-model'");
    expect(svelteSource).not.toContain('const REVIEWS');
  });
});

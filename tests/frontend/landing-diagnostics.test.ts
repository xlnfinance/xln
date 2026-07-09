import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const landingSource = () => readFileSync('frontend/src/lib/components/Landing/LandingPage.svelte', 'utf8');
const chartSource = () => readFileSync('frontend/src/lib/components/Landing/ComparativeChart.svelte', 'utf8');

describe('landing diagnostics', () => {
  test('surfaces superprompt load failures without raw console output', () => {
    const source = landingSource();

    expect(source).not.toContain('console.error');
    expect(source).not.toContain('console.warn');
    expect(source).toContain('data-testid="superprompt-load-error"');
    expect(source).toContain('SUPERPROMPT_LOAD_FAILED');
    expect(source).toContain('on:click={(event) => copySuperprompt(event)}');
  });

  test('surfaces comparative result load failures without raw console output', () => {
    const source = chartSource();

    expect(source).not.toContain('console.error');
    expect(source).not.toContain('console.warn');
    expect(source).toContain('data-testid="comparative-results-error"');
    expect(source).toContain('COMPARATIVE_RESULTS_LOAD_FAILED');
  });
});

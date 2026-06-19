import { describe, expect, test } from 'bun:test';

import { isCanonicalAccountOpener } from '../orchestrator/mesh-common';

const entityId = (byte: string): string => `0x${byte.repeat(32)}`;

describe('mesh account bootstrap ownership', () => {
  test('assigns exactly one canonical opener per bilateral account', () => {
    const lower = entityId('11');
    const upper = entityId('22');

    expect(isCanonicalAccountOpener(lower, upper)).toBe(true);
    expect(isCanonicalAccountOpener(upper, lower)).toBe(false);
    expect(isCanonicalAccountOpener(lower.toUpperCase(), upper)).toBe(true);
    expect(isCanonicalAccountOpener(lower, lower)).toBe(false);
  });
});

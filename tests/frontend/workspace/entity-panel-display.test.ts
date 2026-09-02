import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  formatAddress,
  isPlaceholderEntityName,
  shortHash,
} from '../../../frontend/packages/ui/src/entity-workspace-display';

describe('entity panel display helpers', () => {
  test('detects placeholder names without hiding human labels', () => {
    expect(isPlaceholderEntityName('')).toBe(true);
    expect(isPlaceholderEntityName('Signer 12')).toBe(true);
    expect(isPlaceholderEntityName('Entity deadbeef')).toBe(true);
    expect(isPlaceholderEntityName('Grace Tron')).toBe(false);
  });

  test('formats long ids and empty hash values for compact UI slots', () => {
    expect(formatAddress('0x1234567890abcdef1234567890abcdef12345678')).toBe('0x12345678...345678');
    expect(formatAddress('short-id')).toBe('short-id');
    expect(shortHash('')).toBe('-');
    expect(shortHash('0x1234567890abcdef1234567890abcdef12345678')).toBe('0x12345678...345678');
  });

  test('keeps the legacy display module as a shared-package facade', () => {
    const shared = readFileSync('frontend/packages/ui/src/entity-workspace-display.ts', 'utf8');
    const facade = readFileSync('frontend/src/lib/components/Entity/workspace/entity-panel-display.ts', 'utf8');
    expect(shared).not.toContain('frontend/src');
    expect(shared).not.toContain('$lib');
    expect(facade.trim()).toBe("export * from '../../../../../packages/ui/src/entity-workspace-display';");
  });
});

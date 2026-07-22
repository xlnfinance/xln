import { describe, expect, test } from 'bun:test';

import { getInstallReadinessSummary, INSTALL_CHANNELS } from '../../frontend/src/lib/install/platforms';

describe('install channel manifest', () => {
  test('covers every requested delivery surface without presenting pending artifacts as downloads', () => {
    expect(INSTALL_CHANNELS.map(channel => channel.id)).toEqual(['web', 'cli', 'desktop', 'mobile', 'extension']);
    expect(getInstallReadinessSummary(INSTALL_CHANNELS)).toEqual({
      total: 5,
      available: 1,
      prepared: 3,
      pending: 1,
    });
    expect(INSTALL_CHANNELS.filter(channel => channel.status === 'available').map(channel => channel.id)).toEqual([
      'web',
    ]);
  });

  test('states the mutable-server risk and keeps the unpublished Bun command visibly non-operational', () => {
    const web = INSTALL_CHANNELS.find(channel => channel.id === 'web');
    const cli = INSTALL_CHANNELS.find(channel => channel.id === 'cli');

    expect(web?.trustBoundary).toContain('mutable origin');
    expect(web?.limits).toContain('Not recommended for value-bearing use');
    expect(cli?.command).toBe('bunx xlnfinance@0.1.15');
    expect(cli?.commandNote).toContain('unavailable');
  });
});

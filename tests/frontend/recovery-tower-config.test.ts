import { expect, test } from 'bun:test';

import { resolveDefaultRecoveryTowerUrls } from '../../frontend/src/lib/stores/vaultStore';

test('resolveDefaultRecoveryTowerUrls uses same-origin production tower by default', () => {
  expect(resolveDefaultRecoveryTowerUrls({
    hostname: 'xln.finance',
    globalUrls: undefined,
    localUrls: undefined,
  })).toEqual(['https://xln.finance']);
});

test('resolveDefaultRecoveryTowerUrls stays disabled by default on localhost', () => {
  expect(resolveDefaultRecoveryTowerUrls({
    hostname: 'localhost',
    globalUrls: undefined,
    localUrls: undefined,
  })).toEqual([]);
});

import { describe, expect, test } from 'bun:test';

import { getWatcherStartBlock } from '../jadapter/helpers';

describe('jadapter helper cursors', () => {
  test('uses matching jReplica blockNumber as watcher cursor source', () => {
    const env = {
      activeJurisdiction: 'Arrakis',
      jReplicas: new Map([
        ['Arrakis', { name: 'Arrakis', blockNumber: 17n, depositoryAddress: '0xaaa' }],
        ['Wakanda', { name: 'Wakanda', blockNumber: 44n, depositoryAddress: '0xbbb' }],
      ]),
    } as any;

    expect(getWatcherStartBlock(env, '0xaaa')).toBe(18);
  });

  test('falls back to active jurisdiction block when no depository address is provided', () => {
    const env = {
      activeJurisdiction: 'Wakanda',
      jReplicas: new Map([
        ['Arrakis', { name: 'Arrakis', blockNumber: 22n, depositoryAddress: '0xaaa' }],
        ['Wakanda', { name: 'Wakanda', blockNumber: 19n, depositoryAddress: '0xbbb' }],
      ]),
    } as any;

    expect(getWatcherStartBlock(env)).toBe(20);
  });

  test('falls back to genesis when no jurisdiction replica is present', () => {
    const env = {
      jReplicas: new Map(),
    } as any;

    expect(getWatcherStartBlock(env)).toBe(1);
  });
});

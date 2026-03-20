import { describe, expect, test } from 'bun:test';

import { getSelfSignerFinalizedJHeight, getWatcherStartBlock } from '../jadapter/helpers';

describe('jadapter helper cursors', () => {
  test('uses self-signer finalized J height as watcher cursor source', () => {
    const env = {
      runtimeId: '0xsigner-self',
      eReplicas: new Map([
        [
          '0xentity-a:0xsigner-self',
          {
            signerId: '0xsigner-self',
            state: { lastFinalizedJHeight: 17 },
          },
        ],
        [
          '0xentity-b:0xsigner-peer',
          {
            signerId: '0xsigner-peer',
            state: { lastFinalizedJHeight: 44 },
          },
        ],
      ]),
    } as any;

    expect(getSelfSignerFinalizedJHeight(env)).toBe(17);
    expect(getWatcherStartBlock(env)).toBe(18);
  });

  test('chooses the minimum finalized height when multiple self-signer replicas exist', () => {
    const env = {
      runtimeId: '0xsigner-self',
      eReplicas: new Map([
        [
          '0xentity-a:0xsigner-self',
          {
            signerId: '0xsigner-self',
            state: { lastFinalizedJHeight: 22 },
          },
        ],
        [
          '0xentity-b:0xsigner-self',
          {
            signerId: '0xsigner-self',
            state: { lastFinalizedJHeight: 19 },
          },
        ],
      ]),
    } as any;

    expect(getSelfSignerFinalizedJHeight(env)).toBe(19);
    expect(getWatcherStartBlock(env)).toBe(20);
  });

  test('falls back to genesis when no self-signer replica is present', () => {
    const env = {
      runtimeId: '0xsigner-self',
      eReplicas: new Map([
        [
          '0xentity-a:0xsigner-peer',
          {
            signerId: '0xsigner-peer',
            state: { lastFinalizedJHeight: 91 },
          },
        ],
      ]),
    } as any;

    expect(getSelfSignerFinalizedJHeight(env)).toBe(0);
    expect(getWatcherStartBlock(env)).toBe(1);
  });
});

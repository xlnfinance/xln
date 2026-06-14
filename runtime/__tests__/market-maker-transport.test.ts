import { describe, expect, test } from 'bun:test';
import { areMarketMakerHubTransportsReady } from '../orchestrator/mm-transport';

describe('market maker transport readiness', () => {
  test('accepts the official relay connection without requiring all direct hub peers', () => {
    expect(areMarketMakerHubTransportsReady(
      {
        connected: true,
        directPeers: [
          { runtimeId: '0x1111111111111111111111111111111111111111', open: false },
        ],
      },
      [
        { runtimeId: '0x1111111111111111111111111111111111111111' },
        { runtimeId: '0x2222222222222222222222222222222222222222' },
      ],
    )).toBe(true);
  });

  test('accepts direct-only operation only when every visible hub direct peer is open', () => {
    expect(areMarketMakerHubTransportsReady(
      {
        connected: false,
        directPeers: [
          { runtimeId: '0x1111111111111111111111111111111111111111', open: true },
          { runtimeId: '0x2222222222222222222222222222222222222222', open: true },
        ],
      },
      [
        { runtimeId: '0x1111111111111111111111111111111111111111' },
        { runtimeId: '0x2222222222222222222222222222222222222222' },
      ],
    )).toBe(true);

    expect(areMarketMakerHubTransportsReady(
      {
        connected: false,
        directPeers: [
          { runtimeId: '0x1111111111111111111111111111111111111111', open: true },
          { runtimeId: '0x2222222222222222222222222222222222222222', open: false },
        ],
      },
      [
        { runtimeId: '0x1111111111111111111111111111111111111111' },
        { runtimeId: '0x2222222222222222222222222222222222222222' },
      ],
    )).toBe(false);
  });
});

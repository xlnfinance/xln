import { describe, expect, test } from 'bun:test';

import { normalizeWalletEntryPath, parseWalletScenarioPreview } from '../apps/wallet/src/wallet-entry';

describe('wallet entry contract', () => {
  test('accepts canonical wallet routes and normalizes native root', () => {
    expect(() => normalizeWalletEntryPath('/', 'browser')).toThrow('REACT_WALLET_ROUTE_UNKNOWN:/');
    expect(normalizeWalletEntryPath('/', 'desktop')).toBe('/app');
    expect(normalizeWalletEntryPath('/address/0xabc/', 'browser')).toBe('/address/0xabc');
  });

  test('parses an exact write-disabled scenario preview handoff', () => {
    expect(parseWalletScenarioPreview('?locktest=1&scenarioPreview=1&scenario=hub-collapse&frame=10'))
      .toEqual({ scenarioId: 'hub-collapse', frame: 10 });
    expect(parseWalletScenarioPreview('?scenario=hub-collapse')).toBeNull();
    expect(() => parseWalletScenarioPreview('?scenarioPreview=1&scenario=hub-collapse&frame=10'))
      .toThrow('REACT_WALLET_SCENARIO_PREVIEW_LOCK_REQUIRED');
    expect(() => parseWalletScenarioPreview('?locktest=1&scenarioPreview=1&scenario=hub-collapse&frame=bad'))
      .toThrow('REACT_WALLET_SCENARIO_PREVIEW_FRAME_INVALID');
  });
});

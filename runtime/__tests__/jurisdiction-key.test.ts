import { describe, expect, test } from 'bun:test';

import { normalizeJurisdictionKey, selectWritableJurisdictionKey } from '../jurisdiction-key';

describe('jurisdiction key selection', () => {
  test('prefers an explicit primary jurisdiction key', () => {
    expect(selectWritableJurisdictionKey({
      base: {
        status: 'active',
        contracts: { depository: '0x1', entityProvider: '0x2' },
      },
      ethereum: {
        primary: true,
        status: 'active',
        contracts: { depository: '0x3', entityProvider: '0x4' },
      },
    })).toBe('ethereum');
  });

  test('prefers an exact writable rpc match over primary fallback', () => {
    expect(selectWritableJurisdictionKey({
      ethereum: {
        primary: true,
        rpc: 'http://127.0.0.1:8545',
        contracts: { depository: '0x1', entityProvider: '0x2' },
      },
      base: {
        rpc: 'http://localhost:8546',
        contracts: { depository: '0x3', entityProvider: '0x4' },
      },
    }, undefined, ['http://127.0.0.1:8546'])).toBe('base');
  });

  test('falls back to active usable entry, then first key, then generic primary', () => {
    expect(selectWritableJurisdictionKey({
      pending: { status: 'pending' },
      usable: {
        status: 'active',
        contracts: { depository: '0x1', entityProvider: '0x2' },
      },
    })).toBe('usable');
    expect(selectWritableJurisdictionKey({ existing: { status: 'pending' } })).toBe('existing');
    expect(selectWritableJurisdictionKey({}, 'Base Mainnet')).toBe('base-mainnet');
    expect(selectWritableJurisdictionKey({})).toBe('primary');
  });

  test('normalizes runtime map keys without network-name hardcodes', () => {
    expect(normalizeJurisdictionKey('Base Mainnet')).toBe('base-mainnet');
    expect(normalizeJurisdictionKey('')).toBe('primary');
  });
});

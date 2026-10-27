import { expect, test } from 'bun:test';
import { getAssetUsdMicros } from '../../../frontend/src/lib/utils/assetPricing';
import { CATALOG_TOKENS } from '../../../core/jurisdiction/machine/config/default-tokens';
import { requireBigInt } from '../../../frontend/src/lib/utils/boundary/index';
import { parseAssistantSseLine } from '../../../frontend/src/lib/ai/xln-assistant-client';
import { resolveJurisdictionChainId } from '../../../frontend/src/lib/stores/vault/vault-bootstrap';
import type { JurisdictionConfig } from '../../../core/api/public/runtime-module';

test('monetary previews preserve exact values and reject missing, fractional and malformed amounts', () => {
  expect(requireBigInt('900719925474099312345', 'MONEY_INVALID')).toBe(900719925474099312345n);
  expect(requireBigInt(0n, 'MONEY_INVALID')).toBe(0n);
  for (const value of [undefined, null, '', '1junk', '1.5', 0.5, Number.MAX_SAFE_INTEGER + 1])
    expect(() => requireBigInt(value, 'MONEY_INVALID')).toThrow('MONEY_INVALID');
});

test('SSE rejects malformed data while preserving metadata and the completion marker', () => {
  expect(parseAssistantSseLine(': keepalive')).toEqual({ content: '', done: false });
  expect(parseAssistantSseLine('data: [DONE]').done).toBe(true);
  expect(parseAssistantSseLine('data: {"content":"hello"}').content).toBe('hello');
  expect(() => parseAssistantSseLine('data: {broken')).toThrow('AI_STREAM_EVENT_INVALID');
});

test('jurisdiction bootstrap never invents or truncates a chain identity', () => {
  for (const chainId of [undefined, 0, -1, 1.5, NaN])
    expect(() => resolveJurisdictionChainId({ chainId } as JurisdictionConfig, 'test')).toThrow('CHAIN_ID_INVALID');
  expect(resolveJurisdictionChainId({ chainId: 31337 } as JurisdictionConfig, 'test')).toBe(31337);
});


test('every current configured asset has a canonical nonzero reference price, including TRX', () => {
  for (const token of CATALOG_TOKENS) expect(getAssetUsdMicros(token.symbol)).toBeGreaterThan(0n);
  expect(getAssetUsdMicros('TRX')).toBe(120_000n);
});

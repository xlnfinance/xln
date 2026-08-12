import { describe, expect, test } from 'bun:test';

import {
  createProviderScopedEntityId,
  parseUniversalEntityId,
} from '../../../entity/id';

describe('universal Entity id parser', () => {
  test('parses canonical, numbered, short, and named forms explicitly', () => {
    const full = `0x${'12'.repeat(32)}`;
    expect(parseUniversalEntityId(full).entityId).toBe(full);
    expect(parseUniversalEntityId('#5')).toMatchObject({
      inputType: 'numbered',
      shortId: '5',
      needsProfileLookup: false,
    });
    expect(parseUniversalEntityId('#abcd')).toMatchObject({
      inputType: 'short',
      shortId: 'ABCD',
      needsProfileLookup: true,
    });
    expect(parseUniversalEntityId('@alice')).toMatchObject({
      inputType: 'named',
      shortId: 'alice',
      needsProfileLookup: true,
    });
  });

  test('accepts a full 0x provider scope and binds it into the Entity id', () => {
    const provider = '0x1111111111111111111111111111111111111111';
    const entityId = `0x${'22'.repeat(32)}`;
    const parsed = parseUniversalEntityId(`${provider}:${entityId}`);
    expect(parsed).toMatchObject({
      provider,
      inputType: 'provider-scoped',
      needsProfileLookup: false,
    });
    expect(parsed.entityId).toBe(createProviderScopedEntityId(provider, entityId));
  });

  test('fails closed on malformed input instead of inventing a raw-hex id', () => {
    expect(() => parseUniversalEntityId('')).toThrow('ENTITY_ID_EMPTY');
    expect(() => parseUniversalEntityId('not valid!')).toThrow(
      'ENTITY_ID_FORMAT_INVALID:not valid!',
    );
    expect(() => parseUniversalEntityId('0x123')).toThrow(
      'ENTITY_ID_FORMAT_INVALID:0x123',
    );
  });
});

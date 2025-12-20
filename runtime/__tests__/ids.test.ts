/**
 * Unit tests for identity system (ids.ts)
 * Run with: bun test runtime/ids.test.ts
 */

import { describe, expect, test } from 'bun:test';
import {
  // Type constructors
  toEntityId,
  toSignerId,
  toJId,
  toEpAddress,

  // Validators
  isValidEntityId,
  isValidSignerId,
  isValidJId,
  isValidEpAddress,

  // ReplicaKey operations
  parseReplicaKey,
  formatReplicaKey,
  createReplicaKey,
  extractEntityId,
  extractSignerId,

  // Display formatting
  formatEntityDisplay,
  formatSignerDisplay,
  formatReplicaDisplay,

  // Entity type detection
  isNumberedEntity,
  isLazyEntity,
  detectEntityType,
  getEntityDisplayNumber,

  // URI operations
  parseReplicaUri,
  formatReplicaUri,

  // Constants
  XLN_URI_SCHEME,
  DEFAULT_RUNTIME_HOST,
  MAX_NUMBERED_ENTITY,
} from './ids';

describe('Identity System - Type Constructors', () => {
  test('toEntityId creates branded EntityId', () => {
    const entityId = toEntityId('0x0000000000000000000000000000000000000000000000000000000000000001');
    expect(entityId).toBe('0x0000000000000000000000000000000000000000000000000000000000000001');
  });

  test('toSignerId creates branded SignerId', () => {
    const signerId = toSignerId('alice');
    expect(signerId).toBe('alice');
  });

  test('toJId creates branded JId', () => {
    const jId = toJId('1');
    expect(jId).toBe('1');
  });

  test('toEpAddress creates branded address', () => {
    const addr = toEpAddress('0x1234567890123456789012345678901234567890');
    expect(addr).toBe('0x1234567890123456789012345678901234567890');
  });
});

describe('Identity System - Validators', () => {
  test('isValidEntityId accepts valid 66-char hex', () => {
    expect(isValidEntityId('0x0000000000000000000000000000000000000000000000000000000000000001')).toBe(true);
    expect(isValidEntityId('0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890')).toBe(true);
  });

  test('isValidEntityId rejects invalid formats', () => {
    expect(isValidEntityId('')).toBe(false);
    expect(isValidEntityId('0x123')).toBe(false);
    expect(isValidEntityId('not-hex')).toBe(false);
  });

  test('isValidSignerId accepts non-empty strings', () => {
    expect(isValidSignerId('alice')).toBe(true);
    expect(isValidSignerId('0x1234')).toBe(true);
  });

  test('isValidSignerId rejects empty strings', () => {
    expect(isValidSignerId('')).toBe(false);
  });

  test('isValidJId accepts valid chain IDs', () => {
    expect(isValidJId('1')).toBe(true);
    expect(isValidJId('31337')).toBe(true);
  });

  test('isValidJId rejects invalid formats', () => {
    expect(isValidJId('')).toBe(false);
  });

  test('isValidEpAddress accepts valid 42-char hex', () => {
    expect(isValidEpAddress('0x1234567890123456789012345678901234567890')).toBe(true);
  });

  test('isValidEpAddress rejects invalid formats', () => {
    expect(isValidEpAddress('')).toBe(false);
    expect(isValidEpAddress('0x123')).toBe(false);
  });
});

describe('Identity System - ReplicaKey Operations', () => {
  const testEntityId = '0x0000000000000000000000000000000000000000000000000000000000000001';
  const testSignerId = 'alice';
  const testKeyString = `${testEntityId}:${testSignerId}`;

  test('parseReplicaKey extracts entityId and signerId', () => {
    const key = parseReplicaKey(testKeyString);
    expect(key.entityId).toBe(testEntityId);
    expect(key.signerId).toBe(testSignerId);
  });

  test('parseReplicaKey throws on invalid format (no colon)', () => {
    expect(() => parseReplicaKey('invalid-no-colon')).toThrow('FINTECH-SAFETY');
  });

  test('formatReplicaKey creates correct string', () => {
    const key = { entityId: toEntityId(testEntityId), signerId: toSignerId(testSignerId) };
    expect(formatReplicaKey(key)).toBe(testKeyString);
  });

  test('createReplicaKey creates structured key', () => {
    const key = createReplicaKey(testEntityId, testSignerId);
    expect(key.entityId).toBe(testEntityId);
    expect(key.signerId).toBe(testSignerId);
  });

  test('extractEntityId returns entity portion', () => {
    expect(extractEntityId(testKeyString)).toBe(testEntityId);
  });

  test('extractSignerId returns signer portion', () => {
    expect(extractSignerId(testKeyString)).toBe(testSignerId);
  });

  test('parseReplicaKey handles signer with colons', () => {
    // Edge case: signer ID contains colons (e.g., IPv6 address)
    const complexKey = `${testEntityId}:signer:with:colons`;
    const key = parseReplicaKey(complexKey);
    expect(key.entityId).toBe(testEntityId);
    expect(key.signerId).toBe('signer:with:colons');
  });

  test('parseReplicaKey roundtrips correctly', () => {
    const original = '0x0000000000000000000000000000000000000000000000000000000000000042:bob';
    const parsed = parseReplicaKey(original);
    const formatted = formatReplicaKey(parsed);
    expect(formatted).toBe(original);
  });
});

describe('Identity System - Display Formatting', () => {
  test('formatEntityDisplay formats numbered entities', () => {
    const entityId = toEntityId('0x0000000000000000000000000000000000000000000000000000000000000001');
    const display = formatEntityDisplay(entityId);
    expect(display).toContain('#1');
  });

  test('formatSignerDisplay handles short names', () => {
    expect(formatSignerDisplay(toSignerId('alice'))).toBe('alice');
  });

  test('formatSignerDisplay handles long names', () => {
    const longName = 'verylongsigneridthatexceedslimit';
    const display = formatSignerDisplay(toSignerId(longName));
    // Returns full name - truncation handled at display layer
    expect(display).toBe(longName);
  });

  test('formatReplicaDisplay combines entity and signer', () => {
    const key = createReplicaKey(
      '0x0000000000000000000000000000000000000000000000000000000000000001',
      'alice'
    );
    const display = formatReplicaDisplay(key);
    expect(display).toContain('#1');
    expect(display).toContain('alice');
  });
});

describe('Identity System - Entity Type Detection', () => {
  test('isNumberedEntity detects numbered entities', () => {
    // Entity #1 (low number = numbered)
    const numbered = toEntityId('0x0000000000000000000000000000000000000000000000000000000000000001');
    expect(isNumberedEntity(numbered)).toBe(true);
  });

  test('isLazyEntity detects lazy (hash) entities', () => {
    // Random hash (lazy entity)
    const lazy = toEntityId('0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890');
    expect(isLazyEntity(lazy)).toBe(true);
  });

  test('detectEntityType returns correct type', () => {
    const numbered = toEntityId('0x0000000000000000000000000000000000000000000000000000000000000001');
    const lazy = toEntityId('0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890');

    expect(detectEntityType(numbered)).toBe('numbered');
    expect(detectEntityType(lazy)).toBe('lazy');
  });

  test('getEntityDisplayNumber returns number for numbered entities', () => {
    const entity1 = toEntityId('0x0000000000000000000000000000000000000000000000000000000000000001');
    expect(getEntityDisplayNumber(entity1)).toBe(1);

    const entity42 = toEntityId('0x000000000000000000000000000000000000000000000000000000000000002a');
    expect(getEntityDisplayNumber(entity42)).toBe(42);
  });
});

describe('Identity System - URI Operations', () => {
  const testUri = {
    runtimeHost: 'localhost:8080',
    jId: toJId('31337'),
    epAddress: toEpAddress('0x1234567890123456789012345678901234567890'),
    entityId: toEntityId('0x0000000000000000000000000000000000000000000000000000000000000001'),
    signerId: toSignerId('alice'),
  };

  test('formatReplicaUri creates valid URI', () => {
    const uri = formatReplicaUri(testUri);
    expect(uri).toContain(XLN_URI_SCHEME);
    expect(uri).toContain('localhost:8080');
    expect(uri).toContain('31337');
    expect(uri).toContain('alice');
  });

  test('parseReplicaUri extracts all components', () => {
    const uriString = formatReplicaUri(testUri);
    const parsed = parseReplicaUri(uriString);

    expect(parsed.runtimeHost).toBe(testUri.runtimeHost);
    expect(parsed.jId).toBe(testUri.jId);
    expect(parsed.epAddress).toBe(testUri.epAddress);
    expect(parsed.entityId).toBe(testUri.entityId);
    expect(parsed.signerId).toBe(testUri.signerId);
  });

  test('parseReplicaUri throws on invalid scheme', () => {
    expect(() => parseReplicaUri('http://invalid/path')).toThrow('FINTECH-SAFETY');
  });

  test('DEFAULT_RUNTIME_HOST is localhost:8080', () => {
    expect(DEFAULT_RUNTIME_HOST).toBe('localhost:8080');
  });
});

describe('Identity System - Constants', () => {
  test('MAX_NUMBERED_ENTITY is 1 million', () => {
    expect(MAX_NUMBERED_ENTITY).toBe(1_000_000n);
  });

  test('XLN_URI_SCHEME is xln://', () => {
    expect(XLN_URI_SCHEME).toBe('xln://');
  });
});

describe('Identity System - Edge Cases', () => {
  test('entity #0 is treated as lazy (zero hash)', () => {
    // Entity 0 is a special case - it's the zero hash, not a valid numbered entity
    const entity0 = toEntityId('0x0000000000000000000000000000000000000000000000000000000000000000');
    expect(isNumberedEntity(entity0)).toBe(false);
    expect(isLazyEntity(entity0)).toBe(true);
  });

  test('empty signer throws on parseReplicaKey', () => {
    const entityId = '0x0000000000000000000000000000000000000000000000000000000000000001';
    // Empty signer after colon
    expect(() => parseReplicaKey(`${entityId}:`)).toThrow('FINTECH-SAFETY');
  });
});

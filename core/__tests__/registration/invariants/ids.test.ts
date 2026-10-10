/**
 * Unit tests for the protocol-owned identity modules.
 * Run with: bun test core/__tests__/registration/invariants/ids.test.ts
 */

import { describe, expect, test } from 'bun:test';
import {
  // Type constructors
  toEntityId,
  toSignerId,
  toJId,
  toRuntimeId,

  // Validators
  isValidEntityId,
  isValidSignerId,

  // ReplicaKey operations
  parseReplicaKey,
  formatReplicaKey,
  createReplicaKey,
  extractEntityId,
  extractSignerId,

  // Entity type detection
  isNumberedEntity,
  detectEntityType,

  // Constants
  MAX_NUMBERED_ENTITY,
} from '../../../protocol/identity/index.js';
import { formatEntityDisplay } from '../../../protocol/identity/identity-display.js';

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

  test('RuntimeId requires canonical lowercase address bytes', () => {
    const runtimeId = `0x${'ab'.repeat(20)}`;
    expect(toRuntimeId(runtimeId)).toBe(runtimeId);
    expect(() => toRuntimeId(`0x${'AB'.repeat(20)}`)).toThrow('Invalid RuntimeId');
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

  test('toJId rejects an empty jurisdiction id', () => {
    expect(() => toJId('')).toThrow('FINTECH-SAFETY');
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

});

describe('Identity System - Entity Type Detection', () => {
  test('isNumberedEntity detects numbered entities', () => {
    // Entity #1 (low number = numbered)
    const numbered = toEntityId('0x0000000000000000000000000000000000000000000000000000000000000001');
    expect(isNumberedEntity(numbered)).toBe(true);
  });

  test('detectEntityType returns correct type', () => {
    const numbered = toEntityId('0x0000000000000000000000000000000000000000000000000000000000000001');
    const lazy = toEntityId('0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890');

    expect(detectEntityType(numbered)).toBe('numbered');
    expect(detectEntityType(lazy)).toBe('lazy');
  });

});

describe('Identity System - Constants', () => {
  test('MAX_NUMBERED_ENTITY is 1 million', () => {
    expect(MAX_NUMBERED_ENTITY).toBe(1_000_000n);
  });
});

describe('Identity System - Edge Cases', () => {
  test('entity #0 is treated as lazy (zero hash)', () => {
    // Entity 0 is a special case - it's the zero hash, not a valid numbered entity
    const entity0 = toEntityId('0x0000000000000000000000000000000000000000000000000000000000000000');
    expect(isNumberedEntity(entity0)).toBe(false);
    expect(detectEntityType(entity0)).toBe('lazy');
  });

  test('empty signer throws on parseReplicaKey', () => {
    const entityId = '0x0000000000000000000000000000000000000000000000000000000000000001';
    // Empty signer after colon
    expect(() => parseReplicaKey(`${entityId}:`)).toThrow('FINTECH-SAFETY');
  });
});

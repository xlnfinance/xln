import { describe, expect, test } from 'bun:test';

import { createEmptyEnv } from '../../../runtime';
import {
  assertRuntimeEntityInputsEnvelopeSource,
  signRuntimeEntityInputsEnvelope,
} from '../../../runtime/admit/entity-input-envelope-auth.ts';
import type { UnsignedRuntimeEntityInputsEnvelope } from '../../../runtime/types';

const setup = () => {
  const source = createEmptyEnv('entity-input-envelope-auth:source');
  const target = createEmptyEnv('entity-input-envelope-auth:target');
  target.quietRuntimeLogs = true;
  if (!source.runtimeId || !target.runtimeId) throw new Error('TEST_RUNTIME_ID_MISSING');
  const body: UnsignedRuntimeEntityInputsEnvelope = {
    sourceRuntimeId: source.runtimeId,
    sourceRuntimeHeight: 7,
    sourceRuntimeTimestamp: 1_234,
    entityInputs: [{
      entityId: `0x${'11'.repeat(32)}`,
      signerId: `0x${'22'.repeat(20)}`,
      runtimeId: target.runtimeId,
      entityTxs: [],
    }],
  };
  return { source, target, body };
};

describe('Runtime entity-input envelope source authentication', () => {
  test('accepts the exact source, body and target', () => {
    const { source, target, body } = setup();
    const envelope = signRuntimeEntityInputsEnvelope(source, target.runtimeId!, body);
    expect(assertRuntimeEntityInputsEnvelopeSource(target, source.runtimeId!, envelope)).toEqual({
      sourceRuntimeId: source.runtimeId,
      localRuntimeId: target.runtimeId,
    });
  });

  test('canonicalizes the source Runtime ID before signing', () => {
    const { source, target, body } = setup();
    const envelope = signRuntimeEntityInputsEnvelope(source, target.runtimeId!, {
      ...body,
      sourceRuntimeId: `  0x${source.runtimeId!.slice(2).toUpperCase()}  `,
    });
    expect(envelope.sourceRuntimeId).toBe(source.runtimeId);
    expect(() => assertRuntimeEntityInputsEnvelopeSource(target, source.runtimeId!, envelope)).not.toThrow();
  });

  test('rejects source impersonation', () => {
    const { source, target, body } = setup();
    const attacker = createEmptyEnv('entity-input-envelope-auth:attacker');
    const attackerEnvelope = signRuntimeEntityInputsEnvelope(attacker, target.runtimeId!, {
      ...body,
      sourceRuntimeId: attacker.runtimeId!,
    });
    expect(() => assertRuntimeEntityInputsEnvelopeSource(target, source.runtimeId!, {
      ...attackerEnvelope,
      sourceRuntimeId: source.runtimeId!,
    })).toThrow('INBOUND_ENTITY_INPUTS_SOURCE_SIGNATURE_INVALID');
  });

  test('rejects mutation of every signed frame coordinate and payload', () => {
    const { source, target, body } = setup();
    const envelope = signRuntimeEntityInputsEnvelope(source, target.runtimeId!, body);
    for (const mutated of [
      { ...envelope, sourceRuntimeHeight: 8 },
      { ...envelope, sourceRuntimeTimestamp: 1_235 },
      { ...envelope, entityInputs: [{ entityId: 'mutated' }] as never },
    ]) {
      expect(() => assertRuntimeEntityInputsEnvelopeSource(target, source.runtimeId!, mutated))
        .toThrow('INBOUND_ENTITY_INPUTS_SOURCE_SIGNATURE_INVALID');
    }
  });

  test('rejects nested cross-j amount and price mutation', () => {
    const { source, target, body } = setup();
    const route = {
      orderId: 'signed-cross-j-intent',
      source: { amount: 100n },
      target: { amount: 90n },
      priceTicks: 900_000n,
    };
    const envelope = signRuntimeEntityInputsEnvelope(source, target.runtimeId!, {
      ...body,
      entityInputs: [{
        ...body.entityInputs[0]!,
        entityTxs: [{ type: 'prepareCrossJurisdictionSwap', data: { route } } as never],
      }],
    });
    for (const mutatedRoute of [
      { ...route, source: { amount: 101n } },
      { ...route, priceTicks: 900_001n },
    ]) {
      expect(() => assertRuntimeEntityInputsEnvelopeSource(target, source.runtimeId!, {
        ...envelope,
        entityInputs: [{
          ...envelope.entityInputs[0]!,
          entityTxs: [{ type: 'prepareCrossJurisdictionSwap', data: { route: mutatedRoute } } as never],
        }],
      })).toThrow('INBOUND_ENTITY_INPUTS_SOURCE_SIGNATURE_INVALID');
    }
  });

  test('rejects redirection to another target Runtime', () => {
    const { source, target, body } = setup();
    const otherTarget = createEmptyEnv('entity-input-envelope-auth:other-target');
    const envelope = signRuntimeEntityInputsEnvelope(source, target.runtimeId!, body);
    expect(() => assertRuntimeEntityInputsEnvelopeSource(otherTarget, source.runtimeId!, envelope))
      .toThrow('INBOUND_ENTITY_INPUTS_SOURCE_SIGNATURE_INVALID');
  });

  test('rejects a changed or non-canonical signature', () => {
    const { source, target, body } = setup();
    const envelope = signRuntimeEntityInputsEnvelope(source, target.runtimeId!, body);
    expect(() => assertRuntimeEntityInputsEnvelopeSource(target, source.runtimeId!, {
      ...envelope,
      sourceSignature: `0x${'00'.repeat(65)}`,
    })).toThrow('INBOUND_ENTITY_INPUTS_SOURCE_SIGNATURE_INVALID');
  });
});

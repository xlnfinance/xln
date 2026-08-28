import { describe, expect, test } from 'bun:test';

import { decodeAccountTx } from '../../../core/account/tx-validation';
import {
  failureSignature,
  identifyShrinkCandidates,
  sabotageApplies,
  type CaseFile,
} from './run';

const candidate = (id: string): CaseFile => ({
  id,
  kind: 'value',
  class: 'both-encode',
  value: { t: 'str', v: 'payload' },
});

describe('C1 shrinker identity and failure preservation', () => {
  test('assigns deterministic unique IDs without mutating candidates', () => {
    const source = [candidate('shared'), candidate('shared'), candidate('shared')];
    const identified = identifyShrinkCandidates(source, 'unsafe/origin', 7);
    expect(identified.map(item => item.id)).toEqual([
      'unsafe_origin-r07-c000',
      'unsafe_origin-r07-c001',
      'unsafe_origin-r07-c002',
    ]);
    expect(new Set(identified.map(item => item.id)).size).toBe(identified.length);
    expect(source.every(item => item.id === 'shared')).toBeTrue();
  });

  test('distinguishes mismatch families that must not replace the original failure', () => {
    expect(failureSignature('COUNTER_DIFFER:depth:ts=1:rust=2')).toBe('COUNTER_DIFFER:depth');
    expect(failureSignature('COUNTER_DIFFER:leafCount:ts=1:rust=2')).toBe('COUNTER_DIFFER:leafCount');
    expect(failureSignature('TS_ERROR:WIRE_TAG_UNKNOWN:bad')).toBe('TS_ERROR:WIRE_TAG_UNKNOWN');
    expect(failureSignature('BYTES_DIFFER')).toBe('BYTES_DIFFER');
  });

  test('calibration predicates depend on payload content, never filenames', () => {
    const mixedMap = candidate('arbitrary');
    mixedMap.value = { t: 'map', v: [
      [{ t: 'num', v: '1' }, { t: 'null' }],
      [{ t: 'bign', v: '1' }, { t: 'null' }],
    ] };
    const field = candidate('arbitrary');
    field.value = { t: 'obj', v: [['b', { t: 'num', v: '1' }]] };
    const inverted = { ...candidate('arbitrary'), class: 'both-reject' as const };
    inverted.value = { t: 'obj', v: [['k', { t: 'null' }], ['k', { t: 'bool', v: true }]] };
    expect(sabotageApplies('content-hex', mixedMap)).toBeTrue();
    expect(sabotageApplies('field-divergence', field)).toBeTrue();
    expect(sabotageApplies('class-inversion', inverted)).toBeTrue();
    expect(sabotageApplies('field-divergence', candidate('arbitrary'))).toBeFalse();
  });

  test('production decoding rejects the known unknown-field encoder divergence', () => {
    expect(() => decodeAccountTx({
      type: 'add_delta',
      data: { tokenId: 1, unknownField: 'not-in-the-schema' },
    }, 'C1_UNKNOWN_FIELD')).toThrow('C1_UNKNOWN_FIELD_DATA_FIELDS');
  });
});

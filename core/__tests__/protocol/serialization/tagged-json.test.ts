import { expect, test } from 'bun:test';
import { serializeTaggedJson, deserializeTaggedJson } from '../../../protocol/serialization';

test('cycles fail with a path while shared acyclic values still serialize', () => {
  const cycle: { child?: unknown } = {};
  cycle.child = cycle;
  expect(() => serializeTaggedJson(cycle)).toThrow('SERIALIZATION_CIRCULAR_REFERENCE:$.child');
  const shared = { amount: 1n };
  expect(deserializeTaggedJson(serializeTaggedJson({ a: shared, b: shared }))).toEqual({ a: shared, b: shared });
});

test('typed arrays round trip; unknown and inherited constructor names reject', () => {
  const bytes = new Uint8Array([0, 128, 255]);
  expect(deserializeTaggedJson(serializeTaggedJson(bytes))).toEqual(bytes);
  for (const kind of ['Unknown', 'constructor', '__proto__']) {
    expect(() => deserializeTaggedJson(`{"__xlnType":"TypedArray","kind":"${kind}","value":""}`))
      .toThrow('SERIALIZATION_TYPED_ARRAY_KIND_INVALID');
  }
});

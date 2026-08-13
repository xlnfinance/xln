import { describe, expect, test } from 'bun:test';

import {
  collectUnusedSurface,
  findNamedBinding,
  resolveProofTarget,
  usesNamedBinding,
} from '../../runtime/scripts/checks/repository/check-unused-surface';

describe('unused surface ratchet', () => {
  test('normalizes every Knip public-surface issue deterministically', () => {
    expect(collectUnusedSurface({ issues: [{
      file: 'b.ts',
      exports: [{ name: 'value' }],
      types: [{ name: 'Shape' }],
      cycles: ['a.ts'],
    }] })).toEqual([
      'b.ts::cycle:a.ts',
      'b.ts::export:value',
      'b.ts::type:Shape',
    ]);
  });

  test('proves exact imported usage instead of accepting a stale import or re-export', () => {
    const usedSource = `
      import { type RuntimeId as Id } from '@xln/runtime/protocol/identity';
      export type View = { id: Id };
    `;
    const used = findNamedBinding(usedSource, '@xln/runtime/protocol/identity', 'RuntimeId');
    expect(used).toEqual({ localName: 'Id', reexport: false });
    expect(used && usesNamedBinding(usedSource, used)).toBe(true);

    const staleSource = `import { RuntimeId } from '@xln/runtime/protocol/identity';`;
    const stale = findNamedBinding(staleSource, '@xln/runtime/protocol/identity', 'RuntimeId');
    expect(stale && usesNamedBinding(staleSource, stale)).toBe(false);

    const commentOnly = `
      import { RuntimeId } from '@xln/runtime/protocol/identity';
      // RuntimeId is intentionally not used.
      const label = 'RuntimeId';
    `;
    const commentBinding = findNamedBinding(commentOnly, '@xln/runtime/protocol/identity', 'RuntimeId');
    expect(commentBinding && usesNamedBinding(commentOnly, commentBinding)).toBe(false);

    const reexportSource = `export type { RuntimeId } from '@xln/runtime/protocol/identity';`;
    const reexport = findNamedBinding(reexportSource, '@xln/runtime/protocol/identity', 'RuntimeId');
    expect(reexport).toEqual({ localName: 'RuntimeId', reexport: true });
    expect(reexport && usesNamedBinding(reexportSource, reexport)).toBe(false);
  });

  test('resolves proof specifiers to the exact source file', () => {
    expect(resolveProofTarget(
      'frontend/src/lib/view.svelte',
      '@xln/runtime/protocol/identity',
    )).toBe('runtime/protocol/identity.ts');
    expect(resolveProofTarget(
      'frontend/src/routes/rpc/+server.ts',
      '../rpc-proxy-safety',
    )).toBe('frontend/src/routes/rpc-proxy-safety.ts');
  });
});

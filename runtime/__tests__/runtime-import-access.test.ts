import { describe, expect, test } from 'bun:test';

import {
  normalizeRuntimeImportAccess,
  resolveRuntimeImportAccessForRequest,
} from '../orchestrator/runtime-import-access';

describe('runtime import access gate', () => {
  test('normalizes unknown access values to read', () => {
    expect(normalizeRuntimeImportAccess('admin')).toBe('admin');
    expect(normalizeRuntimeImportAccess('full')).toBe('read');
    expect(normalizeRuntimeImportAccess('')).toBe('read');
  });

  test('allows public read imports', () => {
    const decision = resolveRuntimeImportAccessForRequest(
      new Request('https://xln.finance/api/runtime-import?access=read'),
      'read',
      'read',
    );
    expect(decision).toEqual({ ok: true, access: 'read' });
  });

  test('blocks public admin imports even when admin is the configured default', () => {
    const explicit = resolveRuntimeImportAccessForRequest(
      new Request('https://xln.finance/api/runtime-import?access=admin'),
      'admin',
      'read',
    );
    expect(explicit).toEqual({ ok: false, status: 403, error: 'RUNTIME_IMPORT_ADMIN_LOCAL_ONLY' });

    const inherited = resolveRuntimeImportAccessForRequest(
      new Request('https://xln.finance/api/runtime-import'),
      null,
      'admin',
    );
    expect(inherited).toEqual({ ok: false, status: 403, error: 'RUNTIME_IMPORT_ADMIN_LOCAL_ONLY' });
  });

  test('allows local operator admin imports', () => {
    const decision = resolveRuntimeImportAccessForRequest(
      new Request('http://127.0.0.1:8080/api/runtime-import?access=admin'),
      'admin',
      'read',
    );
    expect(decision).toEqual({ ok: true, access: 'admin' });
  });
});

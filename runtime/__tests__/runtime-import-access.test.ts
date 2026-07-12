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
      'read',
      'read',
      false,
    );
    expect(decision).toEqual({ ok: true, access: 'read' });
  });

  test('blocks public admin imports even when admin is the configured default', () => {
    const explicit = resolveRuntimeImportAccessForRequest(
      'admin',
      'read',
      false,
    );
    expect(explicit).toEqual({ ok: false, status: 403, error: 'RUNTIME_IMPORT_ADMIN_LOCAL_ONLY' });

    const inherited = resolveRuntimeImportAccessForRequest(
      null,
      'admin',
      false,
    );
    expect(inherited).toEqual({ ok: false, status: 403, error: 'RUNTIME_IMPORT_ADMIN_LOCAL_ONLY' });
  });

  test('allows local operator admin imports', () => {
    const decision = resolveRuntimeImportAccessForRequest(
      'admin',
      'read',
      true,
    );
    expect(decision).toEqual({ ok: true, access: 'admin' });
  });
});

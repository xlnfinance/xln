import { expect, test } from 'bun:test';
import { retainOperatorDiagnosticsAuthority } from '../../../frontend/src/lib/debug/operator-diagnostics';

test('only confirmed remote admin selection can query diagnostics across reconnect', () => {
  const target = { runtimeId: 'h2', endpoint: 'ws://localhost:8093/rpc' };
  expect(retainOperatorDiagnosticsAuthority({ ...target, mode: 'embedded', authLevel: null }, '')).toBe('');
  expect(retainOperatorDiagnosticsAuthority({ ...target, mode: 'remote', authLevel: null }, '')).toBe('');
  const confirmed = retainOperatorDiagnosticsAuthority({ ...target, mode: 'remote', authLevel: 'admin' }, '');
  expect(confirmed).toBe('h2|ws://localhost:8093/rpc');
  expect(retainOperatorDiagnosticsAuthority({ ...target, mode: 'remote', authLevel: null }, confirmed)).toBe(confirmed);
  expect(retainOperatorDiagnosticsAuthority({ ...target, mode: 'remote', authLevel: 'inspect' }, confirmed)).toBe('');
  expect(retainOperatorDiagnosticsAuthority({ ...target, runtimeId: 'h3', mode: 'remote', authLevel: null }, confirmed)).toBe('');
  expect(retainOperatorDiagnosticsAuthority({ ...target, mode: 'embedded', authLevel: 'admin' }, confirmed)).toBe('');
});

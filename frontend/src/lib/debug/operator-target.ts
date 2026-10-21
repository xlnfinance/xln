import type { RuntimeAdapter } from '../../../../core/api/runtime-adapter/types.ts';

type DiagnosticHandle = Pick<RuntimeAdapter, 'mode' | 'authLevel' | 'runtimeId'> & { endpoint: string };

/** Reconnect clears transport auth, not the user's already-confirmed operator selection.
 * This only gates diagnostic requests; the server still authorizes every request. */
export function retainOperatorDiagnosticsAuthority(handle: DiagnosticHandle, confirmed: string): string {
  if (handle.mode !== 'remote' || handle.authLevel === 'inspect') return '';
  const target = `${handle.runtimeId}|${handle.endpoint}`;
  return handle.authLevel === 'admin' || confirmed === target ? target : '';
}

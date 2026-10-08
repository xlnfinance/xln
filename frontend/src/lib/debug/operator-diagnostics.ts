import { derived } from 'svelte/store';
import { runtimeControllerHandle, type RuntimeHandle } from '#lib/stores/runtimeControllerStore.ts';

type DiagnosticHandle = Pick<RuntimeHandle, 'mode' | 'authLevel' | 'runtimeId' | 'endpoint'>;

/** Reconnect clears transport auth, not the user's already-confirmed operator selection.
 * This only gates diagnostic requests; the server still authorizes every request. */
export function retainOperatorDiagnosticsAuthority(handle: DiagnosticHandle, confirmed: string): string {
  if (handle.mode !== 'remote' || handle.authLevel === 'inspect') return '';
  const target = `${handle.runtimeId}|${handle.endpoint}`;
  return handle.authLevel === 'admin' || confirmed === target ? target : '';
}

let confirmedTarget = '';
export const operatorDiagnosticsAllowed = derived(runtimeControllerHandle, handle => {
  confirmedTarget = retainOperatorDiagnosticsAuthority(handle, confirmedTarget);
  return confirmedTarget !== '';
});

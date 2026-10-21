import { derived } from 'svelte/store';
import { runtimeControllerHandle } from '#lib/stores/runtimeControllerStore.ts';

import { retainOperatorDiagnosticsAuthority } from './operator-target.ts';

let confirmedTarget = '';
export const operatorDiagnosticsAllowed = derived(runtimeControllerHandle, handle => {
  confirmedTarget = retainOperatorDiagnosticsAuthority(handle, confirmedTarget);
  return confirmedTarget !== '';
});

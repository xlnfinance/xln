import type { HandleClientError } from '@sveltejs/kit/hooks';
import { get } from 'svelte/store';
import { operatorDiagnosticsAllowed } from '#lib/debug/operator-diagnostics.ts';
import { captureBrowserError, installBrowserErrorTelemetry } from '#lib/debug/browser-telemetry.ts';

installBrowserErrorTelemetry(() => get(operatorDiagnosticsAllowed));

export const handleError: HandleClientError = ({ error, kind }) => {
  // Kit 3 also calls this hook for expected app/framework errors.
  if (kind !== 'unknown') return error;
  captureBrowserError('svelte_error', error);
  return {
    message: error instanceof Error ? error.message : 'Unexpected frontend error',
  };
};

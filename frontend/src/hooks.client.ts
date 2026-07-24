import type { HandleClientError } from '@sveltejs/kit';
import {
  captureBrowserError,
  installBrowserErrorTelemetry,
} from '$lib/debug/browser-telemetry';

installBrowserErrorTelemetry();

export const handleError: HandleClientError = ({ error }) => {
  captureBrowserError('svelte_error', error);
  return {
    message: error instanceof Error ? error.message : 'Unexpected frontend error',
  };
};

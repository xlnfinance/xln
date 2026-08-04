export const errorText = (error: unknown): string => (
  error instanceof Error ? error.message : String(error)
);

export const reportSiteError = (source: string, error: unknown): void => {
  captureBrowserError('ui_error', error, [source]);
  const message = errorText(error);
  document.documentElement.setAttribute('data-xln-site-error', source);
  console.error(`[XLN_SITE_FATAL:${source}]`, error);
  const dialog = document.getElementById('site-error-dialog') as HTMLDialogElement | null;
  const output = document.getElementById('site-error-message');
  if (output) output.textContent = message;
  if (dialog && !dialog.open) dialog.showModal();
};

export const installGlobalErrorSurface = (): (() => void) => {
  const onError = (event: ErrorEvent): void => reportSiteError('window', event.error ?? event.message);
  const onRejection = (event: PromiseRejectionEvent): void => reportSiteError('promise', event.reason);
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
};
import { captureBrowserError } from '../../../src/lib/debug/browser-telemetry';

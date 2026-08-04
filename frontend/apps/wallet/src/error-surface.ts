import { errorLog } from '$lib/stores/errorLogStore';
import { captureBrowserError } from '$lib/debug/browser-telemetry';

export const walletErrorText = (error: unknown): string => (
  error instanceof Error ? error.message : String(error || 'Unknown wallet error')
);

export const reportWalletError = (source: string, error: unknown): void => {
  captureBrowserError('ui_error', error, [source]);
  const message = walletErrorText(error);
  errorLog.log(message, `React Wallet:${source}`, error);
  document.documentElement.setAttribute('data-xln-wallet-error', source);
  console.error(`[XLN_WALLET_FATAL:${source}]`, error);
  const dialog = document.getElementById('wallet-error-dialog') as HTMLDialogElement | null;
  const output = document.getElementById('wallet-error-message');
  if (output) output.textContent = message;
  if (dialog && !dialog.open) dialog.showModal();
};

export const installWalletGlobalErrorSurface = (): (() => void) => {
  const onError = (event: ErrorEvent): void => reportWalletError('window', event.error ?? event.message);
  const onRejection = (event: PromiseRejectionEvent): void => reportWalletError('promise', event.reason);
  const onReload = (): void => window.location.reload();
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  document.getElementById('wallet-error-reload')?.addEventListener('click', onReload);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    document.getElementById('wallet-error-reload')?.removeEventListener('click', onReload);
  };
};

import { useExternalStore } from '../../../packages/react-adapters/use-external-store';
import { errorLogExternalStore } from '$lib/stores/errorLogStore';
import { toasts, toastsExternalStore } from '$lib/stores/toastStore';

export const WalletNotices = () => {
  const notices = useExternalStore(toastsExternalStore);
  const errors = useExternalStore(errorLogExternalStore);
  const latestError = errors.at(-1);
  return (
    <aside className="wallet-notices" aria-live="polite" aria-label="Wallet notifications">
      {notices.map(notice => (
        <div className={`wallet-toast wallet-toast-${notice.type}`} key={notice.id} role={notice.type === 'error' ? 'alert' : 'status'}>
          <span>{notice.message}</span>
          <button type="button" aria-label="Dismiss notification" onClick={() => toasts.remove(notice.id)}>×</button>
        </div>
      ))}
      {latestError && notices.length === 0 && (
        <details className="wallet-error-log">
          <summary>Latest diagnostic</summary>
          <p>{latestError.source}: {latestError.message}</p>
        </details>
      )}
    </aside>
  );
};

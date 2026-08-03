declare global {
  interface Window {
    plausible?: ((...args: unknown[]) => void) & { q?: unknown[][]; init?: () => void };
  }
}

const isLocalHost = (): boolean => ['localhost', '127.0.0.1', '::1'].includes(location.hostname);

const loadPlausible = (): void => {
  if (isLocalHost() || document.querySelector('[data-xln-plausible]')) return;
  window.plausible = window.plausible ?? ((...args: unknown[]) => {
    window.plausible!.q = [...(window.plausible!.q ?? []), args];
  });
  const script = document.createElement('script');
  script.async = true;
  script.dataset['xlnPlausible'] = 'true';
  script.src = 'https://plausible.io/js/pa-xeU-A89j2Mpz0DGp8BnVt.js';
  script.onerror = () => console.error('[XLN_SITE_ANALYTICS_LOAD_FAILED]');
  document.head.appendChild(script);
};

export const scheduleSiteAnalytics = (): void => {
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(loadPlausible, { timeout: 2_000 });
  } else {
    globalThis.setTimeout(loadPlausible, 0);
  }
};

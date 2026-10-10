import { writable } from 'svelte/store';

export type PaymentSpotlight = {
  id: string;
  observedAt: number;
  ownerKey: string;
  ownerHeight: number;
  kicker?: string;
  title: string;
  amountLine: string;
  detail?: string;
  duration?: number;
};

export function createPaymentSpotlightStore() {
  const { subscribe, set } = writable<PaymentSpotlight | null>(null);
  let activeTimer: ReturnType<typeof setTimeout> | null = null;
  let activeSpotlight: PaymentSpotlight | null = null;
  let openedSpotlight: PaymentSpotlight | null = null;
  const opened = writable<PaymentSpotlight | null>(null);
  const close = () => { openedSpotlight = null; opened.set(null); };
  const open = () => { openedSpotlight = activeSpotlight; opened.set(openedSpotlight); clear(); };

  function clear() {
    if (activeTimer) {
      clearTimeout(activeTimer);
      activeTimer = null;
    }
    activeSpotlight = null;
    set(null);
  }

  function show(payload: Omit<PaymentSpotlight, 'id' | 'observedAt'>) {
    clear();
    const spotlight: PaymentSpotlight = {
      id: `payment-spotlight-${Date.now()}`,
      observedAt: Date.now(),
      duration: 8000,
      ...payload,
    };
    activeSpotlight = spotlight;
    set(spotlight);
    if ((spotlight.duration ?? 0) > 0) {
      activeTimer = setTimeout(() => {
        activeSpotlight = null;
        set(null);
        activeTimer = null;
      }, spotlight.duration);
    }
  }

  function retainForOwner(ownerKey: string, ownerHeight: number) {
    if (
      activeSpotlight &&
      (activeSpotlight.ownerKey !== ownerKey || activeSpotlight.ownerHeight > ownerHeight)
    ) clear();
    if (openedSpotlight && (openedSpotlight.ownerKey !== ownerKey || openedSpotlight.ownerHeight > ownerHeight)) close();
  }

  return { subscribe, show, clear, retainForOwner, opened, open, close };
}

export const paymentSpotlight = createPaymentSpotlightStore();

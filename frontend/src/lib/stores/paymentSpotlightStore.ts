import { writable } from 'svelte/store';

export type PaymentSpotlight = {
  id: string;
  ownerKey: string;
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

  function clear() {
    if (activeTimer) {
      clearTimeout(activeTimer);
      activeTimer = null;
    }
    activeSpotlight = null;
    set(null);
  }

  function show(payload: Omit<PaymentSpotlight, 'id'>) {
    clear();
    const spotlight: PaymentSpotlight = {
      id: `payment-spotlight-${Date.now()}`,
      duration: 3200,
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

  function retainForOwner(ownerKey: string, invalidate = false) {
    if (activeSpotlight && (invalidate || activeSpotlight.ownerKey !== ownerKey)) clear();
  }

  return { subscribe, show, clear, retainForOwner };
}

export const paymentSpotlight = createPaymentSpotlightStore();

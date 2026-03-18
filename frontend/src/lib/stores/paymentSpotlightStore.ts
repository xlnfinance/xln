import { writable } from 'svelte/store';

export type PaymentSpotlight = {
  id: string;
  title: string;
  amountLine: string;
  detail?: string;
  duration?: number;
};

function createPaymentSpotlightStore() {
  const { subscribe, set } = writable<PaymentSpotlight | null>(null);
  let activeTimer: ReturnType<typeof setTimeout> | null = null;

  function clear() {
    if (activeTimer) {
      clearTimeout(activeTimer);
      activeTimer = null;
    }
    set(null);
  }

  function show(payload: Omit<PaymentSpotlight, 'id'>) {
    clear();
    const spotlight: PaymentSpotlight = {
      id: `payment-spotlight-${Date.now()}`,
      duration: 3200,
      ...payload,
    };
    set(spotlight);
    if ((spotlight.duration ?? 0) > 0) {
      activeTimer = setTimeout(() => {
        set(null);
        activeTimer = null;
      }, spotlight.duration);
    }
  }

  return { subscribe, show, clear };
}

export const paymentSpotlight = createPaymentSpotlightStore();

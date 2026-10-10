import { create } from 'zustand';
import type { PaymentTerminalEvent } from '@xln/frontend/lib/stores/network/paymentTerminalMonitor';

export type PaymentReceipt = {
	id: string;
	height: number;
	name: PaymentTerminalEvent['name'];
	data: Record<string, unknown>;
	observedAt: number;
};

type ReceiptState = {
	latest: PaymentReceipt | null;
	opened: PaymentReceipt | null;
	open: () => void;
	close: () => void;
	dismissNotification: () => void;
	show: (event: PaymentTerminalEvent) => void;
	dismiss: () => void;
};

let receiptSeq = 0;

export const useReceipts = create<ReceiptState>((set, get) => ({
	latest: null,
	opened: null,
	open: () => set({ opened: get().latest, latest: null }),
	close: () => set({ opened: null }),
	dismissNotification: () => set({ latest: null }),
	show: event =>
		set({
			latest: {
				id: `receipt-${++receiptSeq}`,
				height: event.height,
				name: event.name,
				data: event.data,
				observedAt: Date.now(),
			},
		}),
	dismiss: () => set({ latest: null, opened: null }),
}));

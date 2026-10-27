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
const RECEIPT_NOTICE_MS = 15_000;

export const useReceipts = create<ReceiptState>((set, get) => ({
	latest: null,
	opened: null,
	open: () => set({ opened: get().latest, latest: null }),
	close: () => set({ opened: null }),
	dismissNotification: () => set({ latest: null }),
	show: event => {
		const id = `receipt-${++receiptSeq}`;
		set({
			latest: {
				id,
				height: event.height,
				name: event.name,
				data: event.data,
				observedAt: Date.now(),
			},
		});
		// A short notice: it leaves on its own unless a newer receipt replaced it.
		setTimeout(() => {
			if (get().latest?.id === id) set({ latest: null });
		}, RECEIPT_NOTICE_MS);
	},
	dismiss: () => set({ latest: null, opened: null }),
}));

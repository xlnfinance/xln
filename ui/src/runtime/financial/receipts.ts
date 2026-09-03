import { create } from 'zustand';
import type { RuntimeAdapterFrameReceiptResponse } from '@xln/core/api/runtime-adapter/types';
import {
	createPaymentTerminalMonitor,
	PAYMENT_TERMINAL_EVENT_NAMES,
	sharedPaymentTerminalCursorStore,
	sharedPaymentTerminalSeenEventStore,
	type PaymentTerminalEvent,
	type PaymentTerminalReadRequest,
	type PaymentTerminalReceiptPage,
} from '@xln/frontend/lib/stores/network/paymentTerminalMonitor';
import { getAdapter, getEmbeddedEnv } from '../adapter';
import { useApp } from '../store';
import { getXLN } from '../xln-loader';
import { usePaymentIntents } from './movements';

/**
 * A settled payment surfaces as a receipt the moment its terminal frame log is
 * durable. Same monitor, same event names and the same durable cursor as the
 * SvelteKit View: no polling of live state, no optimistic toasts.
 */
export type PaymentReceipt = {
	id: string;
	height: number;
	name: PaymentTerminalEvent['name'];
	data: Record<string, unknown>;
	/** The recipient this wallet addressed, when the payment was sent from here. */
	recipientId: string | null;
	observedAt: number;
};

type ReceiptState = {
	latest: PaymentReceipt | null;
	show: (event: PaymentTerminalEvent, recipientId: string | null) => void;
	dismiss: () => void;
};

let receiptSeq = 0;

export const useReceipts = create<ReceiptState>(set => ({
	latest: null,
	show: (event, recipientId) =>
		set({
			latest: {
				id: `receipt-${++receiptSeq}`,
				height: event.height,
				name: event.name,
				data: event.data,
				recipientId,
				observedAt: Date.now(),
			},
		}),
	dismiss: () => set({ latest: null }),
}));

const normalizeId = (value: unknown): string => String(value || '').trim().toLowerCase();

async function readEmbeddedReceipts(request: PaymentTerminalReadRequest): Promise<PaymentTerminalReceiptPage> {
	const env = getEmbeddedEnv();
	if (!env) throw new Error('PAYMENT_TERMINAL_EMBEDDED_ENV_UNAVAILABLE');
	if (normalizeId(env.runtimeId) !== request.runtimeId) {
		throw new Error(`PAYMENT_TERMINAL_RUNTIME_MISMATCH:${request.runtimeId}`);
	}
	const xln = await getXLN();
	const journals = await xln.readPersistedFrameJournals(env, {
		fromHeight: request.fromHeight,
		toHeight: request.toHeight,
		limit: 500,
	});
	const byHeight = new Map(journals.map(journal => [journal.height, journal]));
	const receipts: PaymentTerminalReceiptPage['receipts'] = [];
	let scannedThroughHeight = request.fromHeight - 1;
	for (let height = request.fromHeight; height <= request.toHeight; height += 1) {
		const journal = byHeight.get(height);
		if (!journal) break;
		receipts.push({ height, logs: journal.logs ?? [] });
		scannedThroughHeight = height;
	}
	return { scannedThroughHeight, receipts };
}

async function readReceipts(request: PaymentTerminalReadRequest): Promise<PaymentTerminalReceiptPage> {
	const adapter = getAdapter();
	if (!adapter || adapter.status !== 'connected') throw new Error('PAYMENT_TERMINAL_ADAPTER_DISCONNECTED');
	if (normalizeId(adapter.runtimeId) !== request.runtimeId) {
		throw new Error(`PAYMENT_TERMINAL_ADAPTER_MISMATCH:${request.runtimeId}`);
	}
	if (adapter.mode === 'embedded') return readEmbeddedReceipts(request);
	const response = await adapter.read<RuntimeAdapterFrameReceiptResponse>('frame-receipts', {
		fromHeight: request.fromHeight,
		toHeight: request.toHeight,
		limit: 500,
		entityId: request.entityId,
		eventNames: [...PAYMENT_TERMINAL_EVENT_NAMES],
	});
	return { scannedThroughHeight: response.toHeight, receipts: response.receipts };
}

/**
 * Follow the connected runtime and the active entity; every committed height
 * drains the durable frame journals for terminal payment events.
 */
export function startPaymentTerminal(): () => void {
	const monitor = createPaymentTerminalMonitor({
		readPage: readReceipts,
		onEvent: event => {
			if (event.name === 'HtlcFailed') {
				const reason = String(event.data['reason'] || event.data['error'] || '').trim();
				useApp.getState().toast(reason ? `Payment failed: ${reason}` : 'Payment failed', 'danger');
				return;
			}
			const entityId = useApp.getState().activeEntityId ?? '';
			const recipientId = event.name === 'HtlcFinalized' ? usePaymentIntents.getState().bind(entityId, event.data) : null;
			useReceipts.getState().show(event, recipientId);
		},
		onError: error => {
			useApp.getState().toast(error instanceof Error ? error.message : String(error), 'danger');
		},
		cursorStore: sharedPaymentTerminalCursorStore,
		seenEventStore: sharedPaymentTerminalSeenEventStore,
	});

	const sync = (): void => {
		const state = useApp.getState();
		const adapter = getAdapter();
		monitor.observe({
			runtimeId: adapter?.runtimeId ?? '',
			entityId: state.activeEntityId ?? '',
			height: state.height,
			connected: Boolean(adapter) && state.adapterStatus === 'connected',
		});
	};
	sync();
	const unsubscribe = useApp.subscribe(sync);
	return () => {
		unsubscribe();
		monitor.stop();
	};
}

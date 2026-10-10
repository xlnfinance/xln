import { useReceipts } from './receipt-state';
import type { RuntimeAdapterFrameReceiptResponse } from '@xln/core/api/runtime-adapter/types';
import {
	createPaymentTerminalMonitor,
	PAYMENT_TERMINAL_EVENT_NAMES,
	sharedPaymentTerminalCursorStore,
	sharedPaymentTerminalSeenEventStore,
	type PaymentTerminalReadRequest,
	type PaymentTerminalReceiptPage,
} from '@xln/frontend/lib/stores/network/paymentTerminalMonitor';
import { getAdapter } from '../adapter';
import { useApp } from '../store';

/**
 * A settled payment surfaces as a receipt the moment its terminal frame log is
 * durable. Same monitor, same event names and the same durable cursor as the
 * SvelteKit View: no polling of live state, no optimistic toasts.
 */
const normalizeId = (value: unknown): string =>
	String(value || '')
		.trim()
		.toLowerCase();

async function readReceipts(request: PaymentTerminalReadRequest): Promise<PaymentTerminalReceiptPage> {
	const adapter = getAdapter();
	if (!adapter || adapter.status !== 'connected') throw new Error('PAYMENT_TERMINAL_ADAPTER_DISCONNECTED');
	if (normalizeId(adapter.runtimeId) !== request.runtimeId) {
		throw new Error(`PAYMENT_TERMINAL_ADAPTER_MISMATCH:${request.runtimeId}`);
	}
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
			useReceipts.getState().show(event);
		},
		onError: error => {
			const message = error instanceof Error ? error.message : String(error);
			// The toast is for the user; the console line is for whoever debugs a missing receipt.
			console.error('[payment-terminal]', message);
			useApp.getState().toast(message, 'danger');
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

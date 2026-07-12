import {
  buildRuntimeFailureSignal,
  isRuntimeFailureSignal,
  type RuntimeFailureCategory,
  type RuntimeFailureSignal,
} from '../failure-taxonomy';

export type DeliveryOutcome = 'delivered' | 'queued' | 'deferred' | 'failed';

export type DeliveryResult = {
  outcome: DeliveryOutcome;
  code: string;
  retryable: boolean;
  fatal: boolean;
  terminal: boolean;
  failure?: RuntimeFailureSignal;
};

export type UndeliveredDeliveryDisposition = {
  retry: boolean;
  level: 'warn' | 'error';
  code: string;
};

const DELIVERY_OUTCOMES = new Set<DeliveryOutcome>(['delivered', 'queued', 'deferred', 'failed']);

const isDeliveryOutcome = (value: unknown): value is DeliveryOutcome =>
  typeof value === 'string' && DELIVERY_OUTCOMES.has(value as DeliveryOutcome);

const hasValidOptionalFailure = (value: unknown): boolean => {
  const failure = (value as { failure?: unknown }).failure;
  if (failure === undefined) return true;
  if (!isRuntimeFailureSignal(failure)) return false;
  const delivery = value as DeliveryResult;
  return (
    delivery.outcome === 'failed' &&
    delivery.code === failure.code &&
    delivery.retryable === failure.retryable &&
    delivery.fatal === failure.fatal
  );
};

export const isDeliveryResult = (value: unknown): value is DeliveryResult =>
  typeof value === 'object' &&
  value !== null &&
  hasValidOptionalFailure(value) &&
  isDeliveryOutcome((value as DeliveryResult).outcome) &&
  typeof (value as DeliveryResult).code === 'string' &&
  typeof (value as DeliveryResult).retryable === 'boolean' &&
  typeof (value as DeliveryResult).fatal === 'boolean' &&
  typeof (value as DeliveryResult).terminal === 'boolean';

export const requireDeliveryResult = (value: unknown, code: string): DeliveryResult => {
  if (isDeliveryResult(value)) return value;
  throw new Error(`${code}: expected DeliveryResult`);
};

export const isDeliveryDelivered = (delivery: DeliveryResult): boolean =>
  delivery.outcome === 'delivered';

export const shouldRetryDelivery = (delivery: DeliveryResult): boolean =>
  !isDeliveryDelivered(delivery) && !delivery.terminal;

export const requireDeliveryDelivered = (
  delivery: DeliveryResult,
  message: string | ((delivery: DeliveryResult) => string),
): DeliveryResult => {
  if (isDeliveryDelivered(delivery)) return delivery;
  throw new Error(typeof message === 'function' ? message(delivery) : message);
};

export const classifyUndeliveredDelivery = (
  delivery: DeliveryResult,
  codes: {
    retry: string;
    terminal: string;
  },
): UndeliveredDeliveryDisposition => {
  if (isDeliveryDelivered(delivery)) {
    throw new Error(`DELIVERY_DISPOSITION_DELIVERED: code=${delivery.code}`);
  }
  const retry = shouldRetryDelivery(delivery);
  return {
    retry,
    level: retry ? 'warn' : 'error',
    code: retry ? codes.retry : codes.terminal,
  };
};

export const deliveryAccepted = (code = 'DELIVERY_ACCEPTED'): DeliveryResult => ({
  // `delivered` is the terminal result of this delivery adapter, not an
  // application receipt. Account frames remain pending until their A-frame ACK;
  // all other entity traffic is explicitly best-effort after transport handoff.
  outcome: 'delivered',
  code,
  retryable: false,
  fatal: false,
  terminal: true,
});

export const deliveryDeferred = (input: {
  outcome: 'queued' | 'deferred';
  code: string;
}): DeliveryResult => ({
  outcome: input.outcome,
  code: input.code,
  retryable: true,
  fatal: false,
  terminal: false,
});

export const deliveryQueued = (input: {
  code: string;
  retryable?: boolean;
  terminal?: boolean;
}): DeliveryResult => ({
  outcome: 'queued',
  code: input.code,
  retryable: input.retryable ?? true,
  fatal: false,
  terminal: input.terminal ?? false,
});

export const deliveryFailure = (input: {
  category: RuntimeFailureCategory;
  code: string;
  message?: string;
  terminal?: boolean;
}): DeliveryResult => {
  const failure = buildRuntimeFailureSignal({
    category: input.category,
    code: input.code,
    ...(input.message !== undefined ? { message: input.message } : {}),
  });
  return {
    outcome: 'failed',
    code: failure.code,
    retryable: failure.retryable,
    fatal: failure.fatal,
    terminal: input.terminal ?? failure.fatal,
    failure,
  };
};

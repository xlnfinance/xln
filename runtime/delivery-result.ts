import {
  buildRuntimeFailureSignal,
  type RuntimeFailureCategory,
  type RuntimeFailureSignal,
} from './failure-taxonomy';

export type DeliveryOutcome = 'delivered' | 'queued' | 'deferred' | 'failed';

export type DeliveryResult = {
  outcome: DeliveryOutcome;
  code: string;
  retryable: boolean;
  fatal: boolean;
  terminal: boolean;
  failure?: RuntimeFailureSignal;
};

export const isDeliveryResult = (value: unknown): value is DeliveryResult =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as DeliveryResult).outcome === 'string' &&
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

export const deliveryAccepted = (code = 'DELIVERY_ACCEPTED'): DeliveryResult => ({
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

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

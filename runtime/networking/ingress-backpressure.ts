/**
 * A receiver may quiesce after transport delivery but before Runtime ingress.
 * The durable sender outbox retries this condition; it is neither corruption
 * nor a cryptographic failure.
 */
export const RETRYABLE_INGRESS_BACKPRESSURE = 'INBOUND_ENTITY_RUNTIME_QUIESCING:';

export const isRetryableIngressBackpressure = (error: unknown): boolean =>
  error instanceof Error && error.message.startsWith(RETRYABLE_INGRESS_BACKPRESSURE);

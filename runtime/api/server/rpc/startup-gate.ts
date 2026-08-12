export type RuntimeTransportBootPhase = 'starting' | 'runtime' | 'bootstrap' | 'ready' | 'failed';

export const isRuntimeTransportReady = (phase: RuntimeTransportBootPhase): boolean => phase === 'ready';

/** Health stays available while WAL/bootstrap recovery runs; transport never queues across it. */
export const runtimeTransportStartupResponse = (
  phase: RuntimeTransportBootPhase,
): Response | null => isRuntimeTransportReady(phase)
  ? null
  : new Response('Runtime transport not ready', {
      status: 503,
      headers: { 'Retry-After': '1' },
    });

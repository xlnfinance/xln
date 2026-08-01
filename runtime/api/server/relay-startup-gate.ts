export type RelayStartupRejectReason =
  | 'startup-hello-required'
  | 'startup-hello-pending'
  | 'startup-hello-capacity';

export type RelayStartupGateResult = 'deferred' | 'rejected';

/**
 * Retain at most one hello per socket while the server restores durable state.
 *
 * Keeping arbitrary pre-auth frames in `Promise.then` closures lets one peer
 * retain unbounded payloads until a slow startup completes. A second frame also
 * cancels the pending hello: the socket is being closed, so its deferred frame
 * must never authenticate later if the close callback races the boot barrier.
 */
const DEFAULT_MAX_PENDING_STARTUP_HELLOS = 1_024;

export const createRelayStartupMessageGate = (
  maxPendingHellos = DEFAULT_MAX_PENDING_STARTUP_HELLOS,
) => {
  if (!Number.isSafeInteger(maxPendingHellos) || maxPendingHellos <= 0) {
    throw new Error('RELAY_STARTUP_HELLO_CAPACITY_INVALID');
  }
  const pendingHellos = new Map<object, () => void>();
  let boundBarrier: Promise<void> | null = null;

  const forget = (ws: object): void => {
    pendingHellos.delete(ws);
  };

  const bindBarrier = (startupBarrier: Promise<void>): void => {
    if (boundBarrier === startupBarrier) return;
    if (boundBarrier !== null) throw new Error('RELAY_STARTUP_BARRIER_CHANGED_WITH_PENDING_HELLOS');
    boundBarrier = startupBarrier;
    // One callback drains the bounded map. Never attach one Promise reaction per
    // socket: closed sockets can churn faster than startup and those reactions
    // themselves would become the unbounded queue this gate is meant to remove.
    void startupBarrier.then(() => {
      if (boundBarrier !== startupBarrier) return;
      boundBarrier = null;
      const dispatches = [...pendingHellos.values()];
      pendingHellos.clear();
      for (const dispatch of dispatches) dispatch();
    });
  };

  const deferHello = (
    startupBarrier: Promise<void>,
    ws: object,
    messageType: string,
    dispatch: () => void,
    reject: (reason: RelayStartupRejectReason) => void,
  ): RelayStartupGateResult => {
    if (messageType !== 'hello') {
      forget(ws);
      reject('startup-hello-required');
      return 'rejected';
    }
    if (pendingHellos.has(ws)) {
      forget(ws);
      reject('startup-hello-pending');
      return 'rejected';
    }
    if (pendingHellos.size >= maxPendingHellos) {
      reject('startup-hello-capacity');
      return 'rejected';
    }

    bindBarrier(startupBarrier);
    pendingHellos.set(ws, dispatch);
    return 'deferred';
  };

  return { deferHello, forget, pendingCount: (): number => pendingHellos.size };
};

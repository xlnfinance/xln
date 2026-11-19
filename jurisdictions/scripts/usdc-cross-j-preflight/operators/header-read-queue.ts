import { RpcTransportUnavailableError } from '../../../../core/jurisdiction/adapter/kernel/failure';

export class HeaderReadCancelled extends RpcTransportUnavailableError {
  constructor() {
    super('USDC_PREFLIGHT_HEADER_READ_CANCELLED');
  }
}

export const requireLiveHeaderClient = (signal: AbortSignal): void => {
  if (signal.aborted) throw new HeaderReadCancelled();
};

export const createHeaderReadQueue = () => {
  let active = 0;
  const waiters = new Set<() => void>();
  const release = (): void => {
    const next = waiters.values().next().value;
    if (!next) active--;
    else {
      // Hand off the occupied slot before another arrival can take it.
      waiters.delete(next);
      next();
    }
  };
  const acquire = async (signal: AbortSignal): Promise<() => void> => {
    requireLiveHeaderClient(signal);
    if (active < 2) {
      active++;
      return release;
    }
    return new Promise((resolve, reject) => {
      const admit = () => {
        signal.removeEventListener('abort', cancel);
        resolve(release);
      };
      const cancel = () => {
        if (waiters.delete(admit)) reject(new HeaderReadCancelled());
      };
      waiters.add(admit);
      signal.addEventListener('abort', cancel, { once: true });
    });
  };
  return { acquire, size: () => ({ active, waiting: waiters.size }) };
};

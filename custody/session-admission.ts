export type SessionCreationLimiterOptions = {
  windowMs: number;
  perClientLimit: number;
  globalLimit: number;
  maxTrackedClients: number;
};

type Counter = { startedAt: number; count: number };

export const createSessionCreationLimiter = (options: SessionCreationLimiterOptions) => {
  const clients = new Map<string, Counter>();
  let global: Counter = { startedAt: 0, count: 0 };

  return (clientId: string, at = Date.now()): boolean => {
    if (at - global.startedAt >= options.windowMs) global = { startedAt: at, count: 0 };
    if (global.count >= options.globalLimit) return false;

    let client = clients.get(clientId);
    if (client && at - client.startedAt >= options.windowMs) {
      clients.delete(clientId);
      client = undefined;
    }
    if (!client && clients.size >= options.maxTrackedClients) {
      for (const [id, counter] of clients) {
        if (at - counter.startedAt >= options.windowMs) clients.delete(id);
      }
      if (clients.size >= options.maxTrackedClients) return false;
    }
    client ??= { startedAt: at, count: 0 };
    if (client.count >= options.perClientLimit) return false;
    client.count += 1;
    global.count += 1;
    clients.set(clientId, client);
    return true;
  };
};

const firstForwardedValue = (value: string | null): string => value?.split(',')[0]?.trim() ?? '';
export const isLoopbackCustodyPeer = (address: string): boolean =>
  address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';

export const resolveCustodySessionClientId = (req: Request, directAddress: string): string => {
  const forwarded = isLoopbackCustodyPeer(directAddress) ? firstForwardedValue(req.headers.get('x-real-ip')) : '';
  return (forwarded || directAddress || 'unknown').slice(0, 64);
};

type RateWindow = {
  startedAt: number;
  total: number;
  clients: Map<string, number>;
};

export type GossipProfileAdmission = {
  admit: (clientId: string, now?: number) => boolean;
  retryAfterSeconds: number;
};

export const createGossipProfileAdmission = (
  windowMs = 60_000,
  perClientLimit = 30,
  globalLimit = 300,
): GossipProfileAdmission => {
  let window: RateWindow = { startedAt: 0, total: 0, clients: new Map() };
  const retryAfterSeconds = Math.max(1, Math.ceil(windowMs / 1_000));
  return {
    retryAfterSeconds,
    admit: (clientId, now = Date.now()) => {
      if (now - window.startedAt >= windowMs || now < window.startedAt) {
        window = { startedAt: now, total: 0, clients: new Map() };
      }
      const normalizedClientId = String(clientId || 'unknown').trim() || 'unknown';
      const clientCount = window.clients.get(normalizedClientId) ?? 0;
      if (window.total >= globalLimit || clientCount >= perClientLimit) return false;
      window.total += 1;
      window.clients.set(normalizedClientId, clientCount + 1);
      return true;
    },
  };
};

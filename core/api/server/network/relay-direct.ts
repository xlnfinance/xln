import type { ServerWebSocket } from 'bun';

export type RelaySocketData = { type: 'relay' | 'rpc'; clientIp: string; audience: string };
export type RelaySocket = ServerWebSocket<RelaySocketData>;

const normalizePeerIp = (value: string | null | undefined): string => {
  const peer = String(value || '').trim().toLowerCase();
  return peer.startsWith('::ffff:') ? peer.slice('::ffff:'.length) : peer;
};

export const resolveRequestClientIp = (request: Request, peerAddress?: string | null): string => {
  const peer = normalizePeerIp(peerAddress);
  if (peer === '127.0.0.1' || peer === '::1') {
    // With one trusted loopback proxy, proxy_add_x_forwarded_for appends the
    // real peer after caller-supplied hops. The first hop is spoofable.
    const forwarded = request.headers.get('x-forwarded-for')
      ?.split(',')
      .map(value => value.trim())
      .filter(Boolean)
      .at(-1);
    return forwarded || peer;
  }
  return peer || 'unknown';
};

export const getRelayClientIp = (ws: RelaySocket): string => String(ws.data?.clientIp || 'unknown');

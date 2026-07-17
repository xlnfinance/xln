import type { ProxyOptions } from 'vite';

/**
 * Vite's proxy pipes the upstream WebSocket into the browser TLS socket. When
 * Playwright closes the browser first, http-proxy only ends the upstream side;
 * a late upstream frame can then write into the downstream socket after FIN.
 * Detach that pipe and destroy the upstream transport at the downstream
 * lifecycle boundary so no bytes can cross after the browser has gone away.
 */
export const configureWsProxyLifecycle: NonNullable<ProxyOptions['configure']> = (proxy) => {
  proxy.on('proxyReqWs', (proxyRequest, _request, downstream) => {
    let downstreamClosed = false;
    let detachUpstream = (): void => {
      downstreamClosed = true;
    };
    const closeDownstream = (): void => detachUpstream();
    downstream.prependOnceListener('end', closeDownstream);
    downstream.prependOnceListener('close', closeDownstream);
    downstream.prependOnceListener('error', closeDownstream);

    proxyRequest.once('upgrade', (_response, upstream) => {
      let detached = false;
      detachUpstream = (): void => {
        downstreamClosed = true;
        if (detached) return;
        detached = true;
        upstream.unpipe(downstream);
        downstream.unpipe(upstream);
        if (!upstream.destroyed) upstream.destroy();
      };
      if (downstreamClosed || downstream.destroyed) detachUpstream();
    });
  });
};

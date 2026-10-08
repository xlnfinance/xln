import type { ProxyOptions } from 'vite';

/**
 * Vite's proxy pipes the upstream WebSocket into the browser TLS socket. When
 * Playwright closes the browser first, http-proxy only ends the upstream side;
 * a late upstream frame can then write into a destroyed downstream socket.
 * TCP `end` only closes the readable half: WebKit still needs the upstream
 * WebSocket close acknowledgement on the writable half. Detach only after
 * downstream close/error, otherwise an orderly close becomes browser code 1006.
 */
export const configureWsProxyLifecycle: NonNullable<ProxyOptions['configure']> = (proxy) => {
  proxy.on('proxyReqWs', (proxyRequest, _request, downstream) => {
    let downstreamClosed = false;
    let detachUpstream = (): void => {
      downstreamClosed = true;
    };
    const closeDownstream = (): void => detachUpstream();
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

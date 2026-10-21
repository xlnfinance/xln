import { createServer, request } from 'node:http';
import { connect, type Socket } from 'node:net';

/** Native browser sockets and original server bytes; only an owned market stream can be paused. */
export async function startMarketTransport(origins: string[]) {
  const allowed = new Set(origins.map(origin => new URL(origin).host));
  const sockets = new Set<Socket>();
  const markets = new Set<Socket>();
  const errors: string[] = [];
  let paused = false;
  let marketConnections = 0;
  let closing = false;
  const target = (authority: string) => {
    const url = new URL(`http://${authority}`);
    const owned = allowed.has(authority);
    return { host: url.hostname, port: Number(url.port || 80), owned };
  };
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => {
      sockets.delete(socket);
      markets.delete(socket);
    });
    socket.on('error', error => {
      if (!closing) errors.push(error.message);
    });
    return socket;
  };
  const markMarket = (header: string, upstream: Socket) => {
    const path = header.split('\r\n', 1)[0]?.split(' ')[1];
    if (!path) throw new Error('MARKET_TRANSPORT_REQUEST_LINE_MISSING');
    const url = new URL(path, 'http://localhost');
    if (url.pathname !== '/relay' || url.searchParams.get('protocol') !== 'market') return;
    markets.add(upstream);
    marketConnections++;
    if (paused) upstream.pause();
  };
  const server = createServer((incoming, outgoing) => {
    if (!incoming.url) throw new Error('MARKET_TRANSPORT_REQUEST_URL_MISSING');
    const url = new URL(incoming.url);
    const upstream = request(
      { ...target(url.host), path: `${url.pathname}${url.search}`, method: incoming.method, headers: incoming.headers },
      response => {
        if (!response.statusCode) throw new Error('MARKET_TRANSPORT_RESPONSE_STATUS_MISSING');
        outgoing.writeHead(response.statusCode, response.headers);
        response.pipe(outgoing);
      },
    );
    upstream.on('error', error => {
      errors.push(error.message);
      outgoing.destroy(error);
    });
    incoming.pipe(upstream);
  });
  server.on('connection', socket => track(socket));
  // Chromium tunnels ws:// through CONNECT. Inspect only its HTTP upgrade header;
  // then pipe the untouched bytes. Pausing the readable side applies TCP backpressure.
  server.on('connect', (incoming, downstream, head) => {
    if (!incoming.url) throw new Error('MARKET_TRANSPORT_CONNECT_TARGET_MISSING');
    const destination = target(incoming.url);
    const upstream = track(connect(destination));
    let header = Buffer.alloc(0);
    const inspect = (bytes: Buffer) => {
      header = Buffer.concat([header, bytes]);
      if (header.length > 65_536) throw new Error('MARKET_TRANSPORT_HEADER_TOO_LARGE');
      if (!header.includes('\r\n\r\n')) return;
      downstream.off('data', inspect);
      markMarket(header.toString('latin1'), upstream);
      upstream.write(header);
      downstream.pipe(upstream);
    };
    upstream.pipe(downstream);
    // Fonts and Chromium's own HTTPS connections remain encrypted passthrough;
    // only an owned loopback tunnel can be inspected or paused.
    if (destination.owned) downstream.on('data', inspect);
    else downstream.pipe(upstream);
    upstream.once('connect', () => {
      downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) {
        if (destination.owned) inspect(head);
        else upstream.write(head);
      }
    });
    downstream.once('close', () => upstream.destroy());
    upstream.once('close', () => downstream.destroy());
  });
  server.on('upgrade', (incoming, downstream, head) => {
    if (!incoming.url) throw new Error('MARKET_TRANSPORT_UPGRADE_TARGET_MISSING');
    const url = new URL(incoming.url);
    const destination = target(url.host);
    const upstream = track(connect(destination));
    const header =
      `${incoming.method} ${url.pathname}${url.search} HTTP/${incoming.httpVersion}\r\n` +
      incoming.rawHeaders.reduce((text, value, index) => text + value + (index % 2 ? '\r\n' : ': '), '') +
      '\r\n';
    upstream.pipe(downstream);
    if (destination.owned) markMarket(header, upstream);
    upstream.write(header);
    if (head.length) upstream.write(head);
    downstream.pipe(upstream);
    downstream.once('close', () => upstream.destroy());
    upstream.once('close', () => downstream.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('MARKET_TRANSPORT_ADDRESS_MISSING');
  return {
    server: `http://127.0.0.1:${address.port}`,
    pause() {
      paused = true;
      for (const socket of markets) socket.pause();
    },
    resume() {
      paused = false;
      for (const socket of markets) socket.resume();
    },
    evidence() {
      return { paused, marketConnections, activeMarketConnections: markets.size, errors: [...errors] };
    },
    async close() {
      closing = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    },
  };
}

export type MarketTransport = Awaited<ReturnType<typeof startMarketTransport>>;

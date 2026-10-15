/** Local interactive simnet; never imports a wallet seed or connects to a public RPC. */
process.env.JADAPTER_MODE = 'browservm';
const { ArrakisSession, steps } = await import('./session');
let session = new ArrakisSession();
const port = 8086;
const origins = new Set(['http://localhost:5183', 'http://127.0.0.1:5183']);
const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  idleTimeout: 120,
  maxRequestBodySize: 1024,
  async fetch(request) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const headers = {
      'Cache-Control': 'no-store',
      ...(origin && origins.has(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
    };
    if (origin && !origins.has(origin)) return new Response('Origin denied', { status: 403 });
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) return new Response('Host denied', { status: 403 });
    if (request.method === 'OPTIONS')
      return new Response(null, {
        headers: {
          ...headers,
          'Access-Control-Allow-Methods': 'GET, POST',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    if (url.pathname !== '/arrakis') return new Response('Not found', { status: 404 });
    if (request.method === 'GET') return Response.json(session.snapshot(), { headers });
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers });
    try {
      const body = await request.json();
      if (body.runtimeId !== session.snapshot().runtimeId)
        throw new Error('This world has changed. Reload before continuing.');
      if (body.step === 'new') {
        const current = session.snapshot();
        if (current.next && !current.error) throw new Error('Finish this world before starting another.');
        await session.close();
        session = new ArrakisSession();
        return Response.json(session.snapshot(), { headers });
      }
      if (!steps.includes(body.step)) return Response.json({ error: 'Unknown action' }, { status: 400, headers });
      await session.act(body.step);
      return Response.json(session.snapshot(), { headers });
    } catch (error) {
      console.error('[arrakis]', error);
      return Response.json(
        { ...session.snapshot(), error: error instanceof Error ? error.message : String(error) },
        { status: 409, headers },
      );
    }
  },
});
console.log(`Arrakis private EVM ready at ${server.url}; UI: http://localhost:5183/arrakis`);

// Simple Bun HTTP server for XLN Svelte frontend
// Serves Svelte build from frontend/build/ with SPA fallback

const textTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
};

const getContentType = (pathname: string): string | undefined => {
  const idx = pathname.lastIndexOf('.');
  if (idx === -1) return undefined;
  const ext = pathname.slice(idx);
  return textTypes[ext];
};

const serveFile = async (filePath: string): Promise<Response | null> => {
  try {
    const file = Bun.file(filePath);
    const exists = await file.exists();
    if (!exists) return null;
    const ct = getContentType(filePath);
    return new Response(file, ct ? { headers: { 'content-type': ct } } : undefined);
  } catch {
    return null;
  }
};

const handler = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const path = url.pathname;

  console.log(`➡️  ${request.method} ${path}`);

  // Handle CORS preflight for /rpc
  if (path === '/rpc' && request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }
    });
  }

  // RPC Proxy - forward JSON-RPC requests to local Hardhat node
  // CRITICAL: Enables HTTPS → HTTP RPC calls (Safari mixed content fix)
  // Local dev: uses port 8545 directly
  // Production: nginx proxies public 8545 → internal 18545, so use 18545 here
  if (path === '/rpc' && request.method === 'POST') {
    try {
      const body = await request.json();
      // Use env var to detect production (port 18545) vs local (port 8545)
      const hardhatPort = process.env.HARDHAT_PORT || '8545';
      const rpcResponse = await fetch(`http://localhost:${hardhatPort}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await rpcResponse.json();
      return new Response(JSON.stringify(data), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type'
        }
      });
    } catch (error) {
      console.error('❌ RPC proxy error:', error);
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32603, message: (error as Error).message },
        id: null
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  // Health check
  if (path === '/healthz') return new Response('ok');

  // Serve root as index.html
  if (path === '/') {
    const file = await serveFile('./frontend/build/index.html');
    if (file) return file;
    return new Response('missing index.html', { status: 404 });
  }

  // Try static files from frontend/build/
  const staticFile = await serveFile(`./frontend/build${path}`);
  if (staticFile) return staticFile;

  // SPA fallback - serve index.html for any unknown route
  const fallback = await serveFile('./frontend/build/index.html');
  if (fallback) return fallback;

  return new Response('not found', { status: 404 });
};

const port = Number(process.env.PORT || 8080);
Bun.serve({ port, fetch: handler });
console.log(`🌐 HTTP server listening on http://localhost:${port}`);



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

  // Strip trailing slash (redirect to canonical URL)
  if (path.length > 1 && path.endsWith('/')) {
    const canonical = path.slice(0, -1);
    return Response.redirect(new URL(canonical, url.origin).href, 301);
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

  // Try with .html extension (SvelteKit creates /scenarios.html not /scenarios/index.html)
  if (!path.includes('.')) {
    const htmlFile = await serveFile(`./frontend/build${path}.html`);
    if (htmlFile) return htmlFile;
  }

  // SPA fallback - serve index.html for any unknown route
  const fallback = await serveFile('./frontend/build/index.html');
  if (fallback) return fallback;

  return new Response('not found', { status: 404 });
};

const port = Number(process.env.PORT || 8080);
Bun.serve({ port, fetch: handler });
console.log(`🌐 HTTP server listening on http://localhost:${port}`);



import { extname, resolve, sep } from 'node:path';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm',
};

const serveFile = async (root: string, relative: string, head: boolean): Promise<Response | null> => {
  const directory = resolve(root);
  const path = resolve(directory, relative);
  if (!path.startsWith(directory + sep)) return new Response('Forbidden', { status: 403 });
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  return new Response(head ? null : file, { headers: {
    'content-type': MIME_TYPES[extname(path)] ?? 'application/octet-stream',
    'cache-control': 'no-store, must-revalidate',
  } });
};

/** React owns /ui; Svelte owns landing and observer routes. No asset falls back to HTML. */
export const serveStaticApp = async (
  request: Request,
  pathname: string,
  staticDir: string,
  walletDir = resolve(process.cwd(), 'ui/dist'),
): Promise<Response | null> => {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { return new Response('Invalid path', { status: 400 }); }
  if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').some(part => part === '..' || part === '.'))
    return new Response('Forbidden', { status: 403 });
  if (decoded === '/ui') {
    const target = new URL(request.url); target.pathname = '/ui/';
    return Response.redirect(target, 308);
  }
  const wallet = decoded.startsWith('/ui/');
  const root = wallet ? walletDir : staticDir;
  const relative = wallet ? decoded.slice(4) : decoded.slice(1);
  const head = request.method === 'HEAD';
  const direct = await serveFile(root, relative || 'index.html', head);
  if (direct) return direct;
  if (relative === 'runtime.js' || relative === 'account-worker.js')
    return Response.json({ error: relative === 'runtime.js' ? 'RUNTIME_BUNDLE_MISSING' : 'ACCOUNT_WORKER_BUNDLE_MISSING' },
      { status: 503, headers: { 'cache-control': 'no-store, must-revalidate' } });
  if (extname(relative)) return new Response('Asset not found', { status: 404 });
  if (!wallet && relative) {
    const page = await serveFile(root, relative + '.html', head);
    if (page) return page;
  }
  return await serveFile(root, 'index.html', head) ?? new Response('Application build missing', { status: 503 });
};

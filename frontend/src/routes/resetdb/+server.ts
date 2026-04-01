import type { RequestHandler } from './$types';

const DEFAULT_RETURN_TO = '/app';

function normalizeReturnTo(candidate: string | null): string {
  if (!candidate) return DEFAULT_RETURN_TO;
  if (!candidate.startsWith('/') || candidate.startsWith('//')) return DEFAULT_RETURN_TO;
  return candidate;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export const GET: RequestHandler = ({ url }) => {
  const returnTo = normalizeReturnTo(url.searchParams.get('returnTo'));
  const safeReturnTo = escapeHtml(returnTo);
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="refresh" content="1;url=${safeReturnTo}" />
    <title>Resetting</title>
    <style>
      :root { color-scheme: dark; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #0b0b0f;
        color: #f3f3f5;
        font: 500 16px/1.5 -apple-system, BlinkMacSystemFont, sans-serif;
      }
      p { opacity: 0.72; letter-spacing: 0.08em; text-transform: uppercase; }
    </style>
  </head>
  <body>
    <p>Resetting local data…</p>
    <script>
      const returnTo = ${JSON.stringify(returnTo)};
      setTimeout(() => location.replace(returnTo), 250);
    </script>
  </body>
</html>`;

  return new Response(html, {
    headers: {
      'cache-control': 'no-store, max-age=0',
      'clear-site-data': '"*"',
      'content-type': 'text/html; charset=utf-8',
    },
  });
};

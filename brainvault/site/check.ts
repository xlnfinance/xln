import { join } from 'node:path';

const siteDir = import.meta.dir;
const liveUrl = new URL(process.env.BRAINVAULT_SITE_URL ?? 'https://brainvault.sh/');
const checkLive = process.argv.includes('--live');
let passed = 0;

function gate(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`SITE_GATE_FAILED: ${message}`);
  passed += 1;
}

async function text(name: string): Promise<string> {
  return Bun.file(join(siteDir, name)).text();
}

async function bytes(name: string): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file(join(siteDir, name)).arrayBuffer());
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}

async function localGates(): Promise<string> {
  const [html, headers, robots, sitemap] = await Promise.all([
    text('index.html'),
    text('_headers'),
    text('robots.txt'),
    text('sitemap.xml'),
  ]);

  gate(html.startsWith('<!doctype html>'), 'index.html must remain a complete HTML document');
  gate(html.includes('<title>BrainVault — Your wallet, mined from memory</title>'), 'title drifted');
  gate(html.includes('<link rel="canonical" href="https://brainvault.sh/" />'), 'canonical URL drifted');
  gate(html.includes('bunx brainvault'), 'primary launch command disappeared');
  gate(!/brainvault@\d/.test(html), 'landing install commands must use latest');
  gate(html.includes('id="language"'), 'language selector missing');
  gate(!html.includes('data-variant-button'), 'editorial draft controls must not ship');
  const installer = html.match(/<div class="installer"[\s\S]*?<\/section>/)?.[0];
  gate(installer && !installer.includes('--ignore-scripts'), 'advanced flags belong in the audit guide');
  const bodyWords = html.replace(/<head>[\s\S]*?<\/head>/g, '').replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]*>/g, ' ').trim().split(/\s+/).length;
  gate(bodyWords <= 250, 'landing copy exceeds its 250-word budget, including collapsed content');
  gate((html.match(/<section\b/g) ?? []).length === 3, 'landing must stay at three sections');
  gate(!html.includes('<video autoplay'), 'demo must remain opt-in');
  const schema = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
  gate(schema, 'structured metadata missing');
  const schemaHash = new Bun.CryptoHasher('sha256').update(schema).digest('base64');
  gate(headers.includes(`'sha256-${schemaHash}'`), 'CSP structured metadata hash drifted');
  gate(html.includes('data-copy-target="#audit-prompt"'), 'copyable audit prompt disappeared');
  gate(html.includes('never a safety score'), 'adversarial audit instructions drifted');
  gate(!html.includes('__cf_email__') && !html.includes('/cdn-cgi/'), 'Cloudflare rewrote source HTML');
  const noTransform = 'Cache-Control: public, max-age=0, must-revalidate, no-transform';
  gate(headers.includes(`/index.html\n  ${noTransform}`), 'index.html must forbid proxy rewriting');
  gate(headers.includes(`/\n  ${noTransform}`), 'the public root must forbid proxy rewriting');
  gate(headers.includes("connect-src 'none'"), 'CSP must keep network connections disabled');
  gate(headers.includes("frame-ancestors 'none'"), 'CSP must prevent framing');
  gate(headers.includes('Strict-Transport-Security: max-age=31536000; includeSubDomains'), 'HSTS policy drifted');
  gate(robots.includes('Sitemap: https://brainvault.sh/sitemap.xml'), 'robots sitemap URL drifted');
  gate(sitemap.includes('<loc>https://brainvault.sh/</loc>'), 'sitemap canonical URL drifted');

  const ids = new Set(Array.from(html.matchAll(/\sid="([^"]+)"/g), (match) => match[1]));
  const fragments = Array.from(html.matchAll(/href="#([^"]+)"/g), (match) => match[1]);
  gate(fragments.length > 0 && fragments.every((fragment) => ids.has(fragment)), 'an internal link targets a missing section');

  const assets = Array.from(html.matchAll(/(?:href|src)="\.\/([^"]+)"/g), (match) => match[1]);
  gate(assets.length > 0, 'no local assets were discovered');
  for (const asset of new Set([...assets, 'assets/language.js', 'assets/locales.js'])) {
    gate(await Bun.file(join(siteDir, asset)).exists(), `missing local asset: ${asset}`);
  }

  return html;
}

async function liveGates(localHtml: string): Promise<void> {
  const cacheBust = new URL(liveUrl);
  cacheBust.searchParams.set('site-gate', Date.now().toString(36));
  const response = await fetch(cacheBust, { redirect: 'error' });

  gate(response.status === 200, `live HTML returned ${response.status}`);
  gate(response.url.startsWith('https://'), 'live page did not remain on HTTPS');
  gate(response.headers.get('strict-transport-security')?.includes('max-age=31536000'), 'live HSTS is missing');
  gate(response.headers.get('cache-control')?.includes('no-transform'), 'live proxy rewriting is not disabled');
  gate(response.headers.get('x-content-type-options') === 'nosniff', 'live nosniff header is missing');
  gate(response.headers.get('x-frame-options') === 'DENY', 'live anti-framing header is missing');
  gate(response.headers.get('referrer-policy') === 'no-referrer', 'live referrer policy drifted');
  gate(response.headers.get('content-security-policy')?.includes("connect-src 'none'"), 'live CSP drifted');

  const liveHtml = await response.text();
  gate(liveHtml === localHtml, 'deployed HTML differs byte-for-byte from source');
  gate(liveHtml.includes('npm install -g brainvault'), 'Cloudflare corrupted the npm command');
  gate(!liveHtml.includes('__cf_email__') && !liveHtml.includes('/cdn-cgi/'), 'Cloudflare injected email decoding');

  for (const asset of [
    'assets/styles.css',
    'assets/script.js',
    'assets/language.js',
    'assets/locales.js',
    'assets/favicon.svg',
    'assets/og-card.png',
    'assets/brainvault-terminal-demo-poster.png',
    'assets/brainvault-terminal-demo.mp4',
  ]) {
    const assetUrl = new URL(asset, liveUrl);
    assetUrl.searchParams.set('site-gate', Date.now().toString(36));
    const assetResponse = await fetch(assetUrl, { redirect: 'error' });
    gate(assetResponse.status === 200, `live asset returned ${assetResponse.status}: ${asset}`);
    gate(
      equalBytes(await bytes(asset), new Uint8Array(await assetResponse.arrayBuffer())),
      `live asset differs byte-for-byte from source: ${asset}`,
    );
  }
}

const localHtml = await localGates();
if (checkLive) await liveGates(localHtml);
console.log(`BrainVault site gates: ${passed}/${passed} PASS${checkLive ? ' (source + live)' : ' (source)'}`);

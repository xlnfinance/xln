import { expect, test } from 'bun:test';
import { CONTENT_SECURITY_POLICY_DIRECTIVES } from '../../../frontend/config/content-security-policy.js';
import svelteConfig from '../../../frontend/svelte.config.js';
import { runtimeHttpOriginFromWsUrl } from '../../../frontend/src/lib/utils/runtime/wsUrl';
import { readFileSync } from 'node:fs';

const source = (path: string): string => readFileSync(path, 'utf8');

test('wallet origin ships no third-party executable code and enforces hashed scripts', () => {
  const appHtml = source('frontend/src/app.html');
  const reactWalletHtml = source('frontend/apps/wallet/index.html');
  const routeMode = source('frontend/static/route-mode.js');
  const css = `${source('frontend/src/lib/styles/apple-glass.css')}\n${source('frontend/src/lib/components/Landing/landing-page.css')}`;

  expect(appHtml).not.toMatch(/<script[^>]+src=["']https?:\/\//i);
  expect(appHtml).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
  expect(reactWalletHtml).not.toMatch(/<script[^>]+src=["']https?:\/\//i);
  expect(reactWalletHtml).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
  expect(appHtml).toContain('<script src="/route-mode.js"></script>');
  expect(reactWalletHtml).toContain('<script vite-ignore src="/route-mode.js"></script>');
  expect(reactWalletHtml).toContain('<link rel="manifest" href="/site.webmanifest" />');
  expect(reactWalletHtml).toContain('href="/apple-touch-icon.png"');
  expect(routeMode).toContain("setAttribute('data-xln-route-mode'");
  expect(appHtml).not.toContain('plausible.io');
  expect(reactWalletHtml).not.toContain('plausible.io');
  expect(css).not.toContain('fonts.googleapis.com');
  expect(svelteConfig.kit.csp?.mode).toBe('hash');
  expect(svelteConfig.kit.csp?.directives).toBe(CONTENT_SECURITY_POLICY_DIRECTIVES);
  expect(CONTENT_SECURITY_POLICY_DIRECTIVES['script-src']).toEqual(['self']);
  expect(CONTENT_SECURITY_POLICY_DIRECTIVES['script-src-attr']).toEqual(['none']);
  expect(CONTENT_SECURITY_POLICY_DIRECTIVES['object-src']).toEqual(['none']);
  expect(CONTENT_SECURITY_POLICY_DIRECTIVES['media-src']).toEqual(['self', 'blob:']);
});

test('selected remote Runtime WebSocket pins same-origin HTTP reads', () => {
  expect(runtimeHttpOriginFromWsUrl('wss://runtime.example/api/core/ws?ignored=1'))
    .toBe('https://runtime.example');
  expect(runtimeHttpOriginFromWsUrl('ws://127.0.0.1:8080/api/core/ws'))
    .toBe('http://127.0.0.1:8080');
  expect(() => runtimeHttpOriginFromWsUrl('https://runtime.example'))
    .toThrow('REMOTE_RUNTIME_WS_URL_INVALID');
});

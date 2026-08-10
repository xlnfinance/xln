import { expect, test } from 'bun:test';
import { runtimeHttpOriginFromWsUrl } from '../../frontend/src/lib/utils/wsUrl';
import { readFileSync } from 'node:fs';

const source = (path: string): string => readFileSync(path, 'utf8');

test('wallet origin ships no third-party executable code and enforces hashed scripts', () => {
  const appHtml = source('frontend/src/app.html');
  const config = source('frontend/svelte.config.js');

  expect(appHtml).not.toMatch(/<script[^>]+src=["']https?:\/\//i);
  expect(appHtml).not.toContain('plausible.io');
  expect(config).toContain("mode: 'hash'");
  expect(config).toContain("'script-src': ['self']");
  expect(config).toContain("'script-src-attr': ['none']");
  expect(config).toContain("'object-src': ['none']");
});

test('selected remote Runtime WebSocket pins same-origin HTTP reads', () => {
  expect(runtimeHttpOriginFromWsUrl('wss://runtime.example/api/runtime/ws?ignored=1'))
    .toBe('https://runtime.example');
  expect(runtimeHttpOriginFromWsUrl('ws://127.0.0.1:8080/api/runtime/ws'))
    .toBe('http://127.0.0.1:8080');
  expect(() => runtimeHttpOriginFromWsUrl('https://runtime.example'))
    .toThrow('REMOTE_RUNTIME_WS_URL_INVALID');
});

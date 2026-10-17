import { expect, test } from 'bun:test';
import {
  parseRemoteRuntimeLink,
  parseRemoteRuntimeImportLink,
  stripRemoteRuntimeLink,
} from '../../../../frontend/src/lib/utils/runtime/remoteRuntimeLink';

const link = (hash: string) => new URL(`https://wallet.example/ui/#${hash}`);

test('canonical remote link decodes for consent without authorizing or persisting it', () => {
  const url = link(
    new URLSearchParams({ runtime: 'remote', ws: 'wss://hub.example/rpc', token: 'xlnra1.full.untrusted' }).toString(),
  );
  expect(parseRemoteRuntimeLink(url)).toEqual({ wsUrl: 'wss://hub.example/rpc', authKey: 'xlnra1.full.untrusted' });
  expect(stripRemoteRuntimeLink(url).href).toBe('https://wallet.example/ui/');
  expect(url.hash).toContain('token=');
});

test('missing capability requires explicit paste and unrelated invoices remain unchanged', () => {
  expect(parseRemoteRuntimeLink(link('runtime=remote&ws=wss://hub.example/rpc'))).toEqual({
    wsUrl: 'wss://hub.example/rpc',
    authKey: '',
  });
  const invoice = link('pay/0xabc?amount=2&token=1');
  expect(parseRemoteRuntimeLink(invoice)).toBeNull();
  expect(stripRemoteRuntimeLink(invoice).href).toBe(invoice.href);
});

test('remote link rejects duplicate parameters, aliases and malformed capability instead of substituting credentials', () => {
  for (const hash of [
    'runtime=remote&ws=wss://hub.example/rpc&ws=wss://evil.example/rpc',
    'adapter=remote&ws=wss://hub.example/rpc',
    'runtime=remote&runtimeWs=wss://hub.example/rpc',
    'runtime=remote&ws=wss://hub.example/rpc&authKey=xlnra1.full.invalid',
    'runtime=remote&ws=wss://hub.example/rpc&token=wrong',
  ]) {
    expect(() => parseRemoteRuntimeLink(link(hash))).toThrow();
  }
});

test('remote link rejects query capabilities and cleans them without touching unrelated query state', () => {
  const url = new URL('https://wallet.example/ui/?token=secret&theme=dark#runtime=remote&ws=wss://hub.example/rpc');
  expect(() => parseRemoteRuntimeLink(url)).toThrow('REMOTE_RUNTIME_QUERY_BOOTSTRAP_FORBIDDEN');
  expect(stripRemoteRuntimeLink(url).href).toBe('https://wallet.example/ui/?theme=dark');
});

test('remote endpoint cannot carry hidden credentials, query tokens, fragments or non-WebSocket schemes', () => {
  for (const ws of [
    'https://hub.example/rpc',
    'wss://user:secret@hub.example/rpc',
    'wss://hub.example/rpc?token=secret',
    'wss://hub.example/rpc#secret',
  ]) {
    expect(() => parseRemoteRuntimeLink(link(new URLSearchParams({ runtime: 'remote', ws }).toString()))).toThrow(
      'REMOTE_RUNTIME_WS_REQUIRED',
    );
  }
});

test('current bulk source is same-origin, exact and scrubbed before any connection', () => {
  const url = link(new URLSearchParams({ 'runtime-import-src': '/api/runtime-import?access=admin' }).toString());
  expect(parseRemoteRuntimeImportLink(url)).toBe('/api/runtime-import?access=admin');
  expect(parseRemoteRuntimeLink(url)).toBeNull();
  expect(stripRemoteRuntimeLink(url).href).toBe('https://wallet.example/ui/');
  expect(parseRemoteRuntimeImportLink(link('pay/0xabc?amount=2&token=1'))).toBeNull();
});

test('bulk links reject old inline payloads, mixed authority and foreign sources', () => {
  for (const hash of [
    'runtime-import={"entries":[]}',
    'runtime-import-src=/api/runtime-import?access=admin&token=xlnra1.full.invalid',
    'runtime-import-src=/api/runtime-import?access=admin&runtime-import-src=/other',
    ...[
      'https://evil.example/api/runtime-import?access=admin',
      '/other?access=admin',
      '/api/runtime-import?access=admin&access=admin',
      '/api/runtime-import?access=public',
      '/api/runtime-import?access=admin&token=secret',
      'https://user:secret@wallet.example/api/runtime-import?access=admin',
    ].map(source => new URLSearchParams({ 'runtime-import-src': source }).toString()),
  ])
    expect(() => parseRemoteRuntimeImportLink(link(hash))).toThrow();
  expect(() =>
    parseRemoteRuntimeImportLink(new URL('https://wallet.example/ui/?runtime-import-src=/api/runtime-import')),
  ).toThrow('REMOTE_RUNTIME_QUERY_BOOTSTRAP_FORBIDDEN');
});

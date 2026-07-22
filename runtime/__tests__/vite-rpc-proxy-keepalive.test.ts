import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { Page } from '@playwright/test';
import { configureWsProxyLifecycle } from '../../frontend/vite-ws-proxy-lifecycle';
import {
  quiesceRuntimePage,
  resetRuntimePageQuiescence,
} from '../../tests/utils/e2e-runtime-shutdown.mts';

const source = (file: string): string => readFileSync(join(process.cwd(), 'frontend', file), 'utf8');

describe('Vite RPC proxy connection lifecycle', () => {
  test('runtime switches quiesce before every reload and re-arm later shutdowns', async () => {
    const lifecycle: string[] = [];
    const page = {
      isClosed: () => false,
      url: () => 'http://127.0.0.1:8081/app',
      evaluate: async () => {
        lifecycle.push('quiesce');
        return 'quiesced';
      },
      once: () => undefined,
      reload: async () => {
        lifecycle.push('reload');
        return null;
      },
    } as unknown as Page;

    for (let switchIndex = 0; switchIndex < 2; switchIndex += 1) {
      await quiesceRuntimePage(page);
      try {
        await page.reload({ waitUntil: 'domcontentloaded' });
      } finally {
        resetRuntimePageQuiescence(page);
      }
    }

    expect(lifecycle).toEqual(['quiesce', 'reload', 'quiesce', 'reload']);

    const switchSource = readFileSync(
      join(process.cwd(), 'tests', 'utils', 'e2e-demo-users.ts'),
      'utf8',
    );
    const switchStart = switchSource.indexOf('export async function switchToRuntimeId');
    const switchBody = switchSource.slice(switchStart);
    const quiesceIndex = switchBody.indexOf('await quiesceRuntimePage(page)');
    const reloadIndex = switchBody.indexOf("await page.reload({ waitUntil: 'domcontentloaded' })");
    const resetIndex = switchBody.indexOf('resetRuntimePageQuiescence(page)');
    expect(quiesceIndex).toBeGreaterThan(-1);
    expect(reloadIndex).toBeGreaterThan(quiesceIndex);
    expect(resetIndex).toBeGreaterThan(reloadIndex);
  });

  test.each(['vite.config.ts', 'vite.config.http.ts'])(
    '%s keeps the bounded upstream pool fully reusable',
    (file) => {
      const config = source(file);
      expect(config).toContain('keepAlive: true, maxSockets: 64, maxFreeSockets: 64');
      expect(config.match(/agent: API_PROXY_AGENT/g)?.length).toBeGreaterThanOrEqual(4);
    },
  );

  test('preview RPC middleware uses the same persistent upstream agent', () => {
    const config = source('vite.config.ts');
    expect(config).toMatch(/transport\.request\(targetUrl, \{[\s\S]*?agent: API_PROXY_AGENT,/);
  });

  test.each(['vite.config.ts', 'vite.config.http.ts'])(
    '%s tears down both WebSocket proxy directions when the browser closes first',
    (file) => {
      const config = source(file);
      expect(config).toContain("from './vite-ws-proxy-lifecycle'");
      expect(config.match(/configure: configureWsProxyLifecycle/g)?.length).toBe(3);
    },
  );

  test.each(['end', 'close', 'error'] as const)(
    'downstream %s detaches and destroys the upgraded upstream socket',
    (event) => {
      let proxyReqWs: ((request: EventEmitter, incoming: object, downstream: PassThrough) => void) | undefined;
      const proxy = {
        on(name: string, listener: typeof proxyReqWs): void {
          if (name !== 'proxyReqWs') throw new Error(`UNEXPECTED_PROXY_EVENT:${name}`);
          proxyReqWs = listener;
        },
      };
      (configureWsProxyLifecycle as unknown as (value: typeof proxy) => void)(proxy);
      if (!proxyReqWs) throw new Error('PROXY_REQUEST_WS_LISTENER_MISSING');

      const request = new EventEmitter();
      const upstream = new PassThrough();
      const downstream = new PassThrough();
      let observedError: Error | undefined;
      downstream.on('error', (error) => {
        observedError = error;
      });
      upstream.pipe(downstream);
      downstream.pipe(upstream);
      proxyReqWs(request, {}, downstream);
      request.emit('upgrade', {}, upstream);

      downstream.emit(event, event === 'error' ? new Error('browser transport closed') : undefined);

      expect(upstream.destroyed).toBe(true);
      if (event === 'error') expect(observedError?.message).toBe('browser transport closed');
    },
  );

  test('destroys an upstream socket that upgrades after the browser already closed', () => {
    let proxyReqWs: ((request: EventEmitter, incoming: object, downstream: PassThrough) => void) | undefined;
    const proxy = {
      on(name: string, listener: typeof proxyReqWs): void {
        if (name !== 'proxyReqWs') throw new Error(`UNEXPECTED_PROXY_EVENT:${name}`);
        proxyReqWs = listener;
      },
    };
    (configureWsProxyLifecycle as unknown as (value: typeof proxy) => void)(proxy);
    if (!proxyReqWs) throw new Error('PROXY_REQUEST_WS_LISTENER_MISSING');

    const request = new EventEmitter();
    const upstream = new PassThrough();
    const downstream = new PassThrough();
    proxyReqWs(request, {}, downstream);
    downstream.emit('close');
    request.emit('upgrade', {}, upstream);

    expect(upstream.destroyed).toBe(true);
  });
});

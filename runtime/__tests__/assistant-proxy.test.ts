import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  createAssistantProxy,
  resolveAssistantDirectClientIp,
  resolveAssistantRateClientId,
  type AssistantProxyConfig,
} from '../server/assistant-proxy';

const config = (overrides: Partial<AssistantProxyConfig> = {}): AssistantProxyConfig => ({
  upstreamUrl: 'http://127.0.0.1:3031',
  allowedModels: ['qwen3-coder:latest', 'gpt-oss:20b'],
  rateWindowMs: 60_000,
  perClientRateLimit: 100,
  globalRateLimit: 1_000,
  maxConcurrentStreams: 4,
  catalogTimeoutMs: 2_500,
  streamTimeoutMs: 180_000,
  ...overrides,
});

const chatRequest = (model = 'qwen3-coder:latest', signal?: AbortSignal): Request =>
  new Request('http://xln.test/api/assistant/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Explain xln.' }] }),
    ...(signal ? { signal } : {}),
  });

const catalogRequest = (): Request => new Request('http://xln.test/api/assistant/models');

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe('assistant production proxy', () => {
  test('is wired into both production servers before generic API proxying', () => {
    const standalone = readFileSync('runtime/server/index.ts', 'utf8');
    const orchestrator = readFileSync('runtime/orchestrator/orchestrator.ts', 'utf8');
    expect(standalone).toContain('const assistantResponse = await assistantProxy.handle(req, pathname, clientId);');
    expect(orchestrator).toContain(
      'const assistantResponse = await assistantProxy.handle(request, pathname, assistantClientId);',
    );
    expect(orchestrator.indexOf('assistantProxy.handle(request')).toBeLessThan(
      orchestrator.indexOf("if (pathname.startsWith('/api/'))"),
    );
  });

  test('trusts forwarded client identity only from the loopback reverse proxy', () => {
    const request = new Request('https://xln.test/api/assistant/models', {
      headers: {
        'x-forwarded-for': 'attacker-spoof, 203.0.113.7',
        'x-real-ip': '203.0.113.7',
      },
    });
    expect(resolveAssistantRateClientId(request, '127.0.0.1')).toBe('203.0.113.7');
    expect(resolveAssistantRateClientId(request, '198.51.100.2')).toBe('198.51.100.2');
    expect(resolveAssistantDirectClientIp({ requestIP: () => ({ address: '127.0.0.1' }) }, request)).toBe('127.0.0.1');

    const withoutRealIp = new Request('https://xln.test/api/assistant/models', {
      headers: { 'x-forwarded-for': 'attacker-spoof, 198.51.100.9' },
    });
    expect(resolveAssistantRateClientId(withoutRealIp, '::1')).toBe('198.51.100.9');
  });

  test('rejects cross-origin browser inference before contacting the upstream', async () => {
    let upstreamCalls = 0;
    const proxy = createAssistantProxy({
      config: config(),
      logger: silentLogger,
      fetch: (async () => {
        upstreamCalls += 1;
        throw new Error('must not run');
      }) as typeof fetch,
    });
    const request = new Request('https://xln.test/api/assistant/models', {
      headers: { origin: 'https://attacker.test', 'sec-fetch-site': 'cross-site' },
    });
    const response = await proxy.handle(request, '/api/assistant/models', '203.0.113.8');
    expect(response?.status).toBe(403);
    expect(upstreamCalls).toBe(0);
  });

  test('accepts a browser same-origin verdict through a host-rewriting reverse proxy', async () => {
    const proxy = createAssistantProxy({
      config: config(),
      logger: silentLogger,
      fetch: (async () => Response.json({ models: [{ id: 'qwen3-coder:latest' }] })) as typeof fetch,
    });
    const request = new Request('http://127.0.0.1:8082/api/assistant/models', {
      headers: { origin: 'https://xln.test', 'sec-fetch-site': 'same-origin' },
    });
    const response = await proxy.handle(request, '/api/assistant/models', '203.0.113.8');
    expect(response?.status).toBe(200);
  });

  test('rejects attacker-selected models before contacting the upstream', async () => {
    let upstreamCalls = 0;
    const proxy = createAssistantProxy({
      config: config(),
      logger: silentLogger,
      fetch: (async () => {
        upstreamCalls += 1;
        throw new Error('must not run');
      }) as typeof fetch,
    });

    const response = await proxy.handle(chatRequest('attacker/model:latest'), '/api/assistant/chat', '203.0.113.1');
    expect(response?.status).toBe(403);
    expect(await response?.json()).toEqual({
      code: 'AI_MODEL_NOT_ALLOWED',
      message: 'Assistant model is not allowed.',
    });
    expect(upstreamCalls).toBe(0);
  });

  test('rejects unrecognized capability fields before contacting the upstream', async () => {
    let upstreamCalls = 0;
    const proxy = createAssistantProxy({
      config: config(),
      logger: silentLogger,
      fetch: (async () => {
        upstreamCalls += 1;
        throw new Error('must not run');
      }) as typeof fetch,
    });
    const request = new Request('http://xln.test/api/assistant/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3-coder:latest',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [{ type: 'shell' }],
      }),
    });

    const response = await proxy.handle(request, '/api/assistant/chat', '203.0.113.1');
    expect(response?.status).toBe(400);
    expect(((await response?.json()) as { code: string }).code).toBe('AI_REQUEST_FIELD_INVALID');
    expect(upstreamCalls).toBe(0);
  });

  test('reports expected offline discovery as a 200 unavailable catalog', async () => {
    const proxy = createAssistantProxy({
      config: config(),
      logger: silentLogger,
      fetch: (async () => {
        throw new Error('ECONNREFUSED');
      }) as typeof fetch,
    });

    const response = await proxy.handle(catalogRequest(), '/api/assistant/models', '203.0.113.2');
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      provider: 'local',
      available: false,
      defaultModel: '',
      models: [],
      message: 'Local AI is offline. Start the xln AI service and retry.',
    });
  });

  test('filters model discovery to the server allowlist in preference order', async () => {
    const proxy = createAssistantProxy({
      config: config(),
      logger: silentLogger,
      fetch: (async () =>
        Response.json({
          models: [
            { id: 'gpt-oss:20b', name: 'GPT OSS' },
            { id: 'attacker/model', name: 'Injected' },
            { id: 'qwen3-coder:latest', name: 'Qwen 3 Coder' },
          ],
        })) as typeof fetch,
    });

    const response = await proxy.handle(catalogRequest(), '/api/assistant/models', '203.0.113.3');
    const payload = (await response?.json()) as Record<string, unknown>;
    expect(payload['available']).toBe(true);
    expect(payload['defaultModel']).toBe('qwen3-coder:latest');
    expect(payload['models']).toEqual([
      { id: 'qwen3-coder:latest', name: 'Qwen 3 Coder' },
      { id: 'gpt-oss:20b', name: 'GPT OSS' },
    ]);
  });

  test('enforces per-client and global fixed-window request limits', async () => {
    let clock = 1_000;
    const proxy = createAssistantProxy({
      config: config({ perClientRateLimit: 2, globalRateLimit: 3, rateWindowMs: 1_000 }),
      logger: silentLogger,
      now: () => clock,
      fetch: (async () => {
        throw new Error('offline');
      }) as typeof fetch,
    });

    expect((await proxy.handle(catalogRequest(), '/api/assistant/models', 'client-a'))?.status).toBe(200);
    expect((await proxy.handle(catalogRequest(), '/api/assistant/models', 'client-a'))?.status).toBe(200);
    const clientLimited = await proxy.handle(catalogRequest(), '/api/assistant/models', 'client-a');
    expect(clientLimited?.status).toBe(429);
    expect(((await clientLimited?.json()) as { code: string }).code).toBe('AI_CLIENT_RATE_LIMITED');
    expect((await proxy.handle(catalogRequest(), '/api/assistant/models', 'client-b'))?.status).toBe(200);
    const globalLimited = await proxy.handle(catalogRequest(), '/api/assistant/models', 'client-c');
    expect(globalLimited?.status).toBe(429);
    expect(((await globalLimited?.json()) as { code: string }).code).toBe('AI_GLOBAL_RATE_LIMITED');

    clock = 2_001;
    expect((await proxy.handle(catalogRequest(), '/api/assistant/models', 'client-a'))?.status).toBe(200);
  });
});

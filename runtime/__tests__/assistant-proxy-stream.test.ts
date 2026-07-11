import { describe, expect, test } from 'bun:test';
import { createAssistantProxy, type AssistantProxyConfig } from '../server/assistant-proxy';

const encoder = new TextEncoder();
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
const chatRequest = (signal?: AbortSignal): Request =>
  new Request('http://xln.test/api/assistant/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'qwen3-coder:latest',
      messages: [{ role: 'user', content: 'Explain xln.' }],
    }),
    ...(signal ? { signal } : {}),
  });
const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe('assistant production streaming', () => {
  test('caps concurrent streams and frees the slot on downstream cancellation', async () => {
    let upstreamCancelled = false;
    const upstreamBody = new ReadableStream<Uint8Array>({
      cancel() {
        upstreamCancelled = true;
      },
    });
    const proxy = createAssistantProxy({
      config: config({ maxConcurrentStreams: 1 }),
      logger: silentLogger,
      fetch: (async () =>
        new Response(upstreamBody, {
          headers: { 'content-type': 'text/event-stream' },
        })) as typeof fetch,
    });

    const first = await proxy.handle(chatRequest(), '/api/assistant/chat', 'client-a');
    expect(first?.status).toBe(200);
    expect(proxy.snapshot().activeStreams).toBe(1);
    const second = await proxy.handle(chatRequest(), '/api/assistant/chat', 'client-b');
    expect(second?.status).toBe(429);
    expect(((await second?.json()) as { code: string }).code).toBe('AI_CONCURRENCY_LIMITED');

    await first?.body?.cancel('closed by browser');
    await Bun.sleep(0);
    expect(upstreamCancelled).toBe(true);
    expect(proxy.snapshot().activeStreams).toBe(0);
  });

  test('ties request cancellation to the upstream signal and stream', async () => {
    let upstreamSignal: AbortSignal | null = null;
    let upstreamCancelled = false;
    const proxy = createAssistantProxy({
      config: config(),
      logger: silentLogger,
      fetch: (async (_url, init) => {
        upstreamSignal = init?.signal as AbortSignal;
        return new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              upstreamCancelled = true;
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }) as typeof fetch,
    });
    const controller = new AbortController();
    const response = await proxy.handle(chatRequest(controller.signal), '/api/assistant/chat', 'client-a');
    controller.abort('navigation');
    await Bun.sleep(0);

    expect(response?.status).toBe(200);
    expect(upstreamSignal?.aborted).toBe(true);
    expect(upstreamCancelled).toBe(true);
    expect(proxy.snapshot().activeStreams).toBe(0);
  });

  test('stream timeout frees a slot even when one queued chunk is never consumed', async () => {
    let upstreamCancelled = false;
    const proxy = createAssistantProxy({
      config: config({ streamTimeoutMs: 5 }),
      logger: silentLogger,
      fetch: (async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode('data: {"content":"partial"}\n\n'));
            },
            cancel() {
              upstreamCancelled = true;
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        )) as typeof fetch,
    });

    const response = await proxy.handle(chatRequest(), '/api/assistant/chat', 'client-a');
    expect(response?.status).toBe(200);
    await Bun.sleep(10);
    expect(upstreamCancelled).toBe(true);
    expect(proxy.snapshot().activeStreams).toBe(0);
    await response?.body?.cancel('test cleanup');
  });

  test('passes SSE bytes through without buffering or rewriting', async () => {
    const chunks = ['data: {"content":"hello "}\n\n', 'data: {"content":"xln"}\n\ndata: [DONE]\n\n'];
    const proxy = createAssistantProxy({
      config: config(),
      logger: silentLogger,
      fetch: (async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
              controller.close();
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        )) as typeof fetch,
    });

    const response = await proxy.handle(chatRequest(), '/api/assistant/chat', 'client-a');
    expect(response?.headers.get('content-type')).toContain('text/event-stream');
    expect(await response?.text()).toBe(chunks.join(''));
    expect(proxy.snapshot().activeStreams).toBe(0);
  });

  test('streams SSE through an actual HTTP upstream', async () => {
    const expected = 'data: {"content":"network"}\n\ndata: [DONE]\n\n';
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response(expected, { headers: { 'content-type': 'text/event-stream' } }),
    });
    try {
      const proxy = createAssistantProxy({
        config: config({ upstreamUrl: `http://127.0.0.1:${upstream.port}` }),
        logger: silentLogger,
      });
      const response = await proxy.handle(chatRequest(), '/api/assistant/chat', 'client-a');
      expect(response?.status).toBe(200);
      expect(await response?.text()).toBe(expected);
      expect(proxy.snapshot().activeStreams).toBe(0);
    } finally {
      await upstream.stop(true);
    }
  });
});

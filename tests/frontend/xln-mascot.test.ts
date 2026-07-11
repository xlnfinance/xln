import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_XLN_MASCOT_DOCK,
  clampMascotPoint,
  moveMascotDock,
  normalizeXlnMascotDock,
  resolveMascotPanelRect,
  resolveMascotPoint,
  resolveMascotViewport,
  snapMascotToEdge,
} from '../../frontend/src/lib/components/XlnMascot/mascot-geometry';
import {
  parseAssistantSseLine,
  streamXlnAssistantReply,
} from '../../frontend/src/lib/ai/xln-assistant-client';
import { rankXlnGuideDocs } from '../../frontend/src/lib/ai/xln-guide-context';
import {
  parseAssistantChatRequest,
  sanitizeAssistantCatalog,
} from '../../runtime/server/assistant-proxy-input';

const desktop = { width: 1440, height: 900 };
const phone = { width: 393, height: 852, insetTop: 47, insetBottom: 34 };

describe('xln mascot geometry', () => {
  test('normalizes corrupt placement and clamps offsets', () => {
    expect(normalizeXlnMascotDock(null)).toEqual(DEFAULT_XLN_MASCOT_DOCK);
    expect(normalizeXlnMascotDock({ version: 2, side: 'center', offsetRatio: 99 })).toEqual(DEFAULT_XLN_MASCOT_DOCK);
    expect(normalizeXlnMascotDock({ version: 1, side: 'left', offsetRatio: 9 })).toEqual({
      version: 1,
      side: 'left',
      offsetRatio: 1,
    });
  });

  test('snaps deterministically to every viewport side', () => {
    expect(snapMascotToEdge({ x: 14, y: 400 }, desktop).side).toBe('left');
    expect(snapMascotToEdge({ x: 1360, y: 400 }, desktop).side).toBe('right');
    expect(snapMascotToEdge({ x: 700, y: 13 }, desktop).side).toBe('top');
    expect(snapMascotToEdge({ x: 700, y: 820 }, desktop).side).toBe('bottom');
    expect(snapMascotToEdge({ x: 12, y: 12 }, desktop).side).toBe('left');
  });

  test('keeps relative edge position through desktop-to-phone resize', () => {
    const placement = { version: 1 as const, side: 'right' as const, offsetRatio: 0.63 };
    const desktopPoint = resolveMascotPoint(placement, desktop);
    const restored = snapMascotToEdge(desktopPoint, desktop);
    const phonePoint = resolveMascotPoint(restored, phone);
    const phoneRestored = snapMascotToEdge(phonePoint, phone);
    expect(phoneRestored.side).toBe('right');
    expect(Math.abs(phoneRestored.offsetRatio - 0.63)).toBeLessThan(0.001);
    expect(clampMascotPoint(phonePoint, phone)).toEqual(phonePoint);
  });

  test('opens the chat inward and inside every safe visible edge', () => {
    for (const side of ['left', 'right', 'top', 'bottom'] as const) {
      for (const offsetRatio of [0, 0.5, 1]) {
        const placement = { version: 1 as const, side, offsetRatio };
        const point = resolveMascotPoint(placement, phone);
        const panel = resolveMascotPanelRect(placement, point, phone);
        expect(panel.x).toBeGreaterThanOrEqual((phone.insetLeft ?? 0) + 12);
        expect(panel.y).toBeGreaterThanOrEqual((phone.insetTop ?? 0) + 12);
        expect(panel.x + panel.width).toBeLessThanOrEqual(phone.width - (phone.insetRight ?? 0) - 12);
        expect(panel.y + panel.height).toBeLessThanOrEqual(phone.height - (phone.insetBottom ?? 0) - 12);
      }
    }
    const keyboardViewport = resolveMascotViewport(393, 852, {
      width: 393,
      height: 318,
      offsetTop: 0,
      offsetLeft: 0,
    });
    const placement = { version: 1 as const, side: 'bottom' as const, offsetRatio: 0.8 };
    const compact = resolveMascotPanelRect(placement, resolveMascotPoint(placement, keyboardViewport), keyboardViewport);
    expect(compact.y + compact.height).toBeLessThanOrEqual(318 - 12);
  });

  test('supports keyboard edge and offset movement', () => {
    const start = { version: 1 as const, side: 'right' as const, offsetRatio: 0.5 };
    expect(moveMascotDock(start, 'ArrowLeft', true).side).toBe('left');
    expect(moveMascotDock(start, 'ArrowUp', false).offsetRatio).toBe(0.45);
    expect(moveMascotDock(start, 'ArrowDown', false).offsetRatio).toBe(0.55);
  });
});

describe('xln assistant boundaries', () => {
  test('parses content and completion SSE lines', () => {
    expect(parseAssistantSseLine('data: {"content":"hello"}')).toEqual({ content: 'hello', done: false });
    expect(parseAssistantSseLine('data: [DONE]')).toEqual({ content: '', done: true });
    expect(parseAssistantSseLine('event: ping')).toEqual({ content: '', done: false });
  });

  test('cancels an upstream stream that stays open after SSE completion', async () => {
    const originalFetch = globalThis.fetch;
    let cancelReason: unknown;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"content":"hello xln"}\n\ndata: [DONE]\n\n'));
      },
      cancel(reason) {
        cancelReason = reason;
      },
    });
    const chunks: string[] = [];
    globalThis.fetch = (async () => new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })) as typeof fetch;
    try {
      const answer = await streamXlnAssistantReply({
        model: 'qwen3-coder:latest',
        messages: [{ role: 'user', content: 'hello' }],
        onContent: (content) => chunks.push(content),
      });
      expect(answer).toBe('hello xln');
      expect(chunks).toEqual(['hello xln']);
      expect(cancelReason).toBe('AI_STREAM_DONE');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('validates chat roles, sizes and model ids', async () => {
    const request = (body: unknown) => new Request('http://xln.test/api/assistant/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const allowed = new Set(['qwen3-coder:latest']);
    expect((await parseAssistantChatRequest(request({
      model: 'qwen3-coder:latest',
      messages: [{ role: 'user', content: 'Explain RCPAN' }],
    }), allowed)).messages).toHaveLength(1);
    await expect(parseAssistantChatRequest(request({ model: '../bad model', messages: [] }), allowed)).rejects.toThrow();
    await expect(parseAssistantChatRequest(request({
      model: 'qwen3-coder:latest',
      messages: [{ role: 'tool', content: 'execute payment' }],
    }), allowed)).rejects.toThrow();
  });

  test('publishes only available, well-formed local models', () => {
    expect(sanitizeAssistantCatalog({
      default_model: 'qwen3-coder:latest',
      models: [
        { id: 'qwen3-coder:latest', name: 'Qwen', available: true },
        { id: 'missing', available: false },
        { id: '../invalid model', available: true },
      ],
    }, ['qwen3-coder:latest'])).toEqual([{ id: 'qwen3-coder:latest', name: 'Qwen' }]);
  });

  test('ranks public xln docs against the question and route', () => {
    const entries = [
      { id: 'intro', path: 'intro.md', title: 'xln in 5 minutes', summary: 'bilateral network', kind: 'live' },
      { id: 'core/12_invariant', path: 'core/12_invariant.md', title: 'RCPAN invariant', summary: 'collateral and credit', kind: 'live' },
      { id: 'archive', path: 'archive.md', title: 'Collateral', summary: 'old', kind: 'archive' },
    ];
    expect(rankXlnGuideDocs('Why does collateral protect credit?', '/app', entries)[0]?.id).toBe('core/12_invariant');
    expect(rankXlnGuideDocs('network overview', '/app', entries).some(entry => entry.kind === 'archive')).toBe(false);
  });
});

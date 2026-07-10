import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_XLN_MASCOT_DOCK,
  clampMascotPoint,
  moveMascotDock,
  normalizeXlnMascotDock,
  resolveMascotPanelRect,
  resolveMascotPoint,
  snapMascotToEdge,
} from '../../frontend/src/lib/components/XlnMascot/mascot-geometry';
import { parseAssistantSseLine } from '../../frontend/src/lib/ai/xln-assistant-client';
import { rankXlnGuideDocs } from '../../frontend/src/lib/ai/xln-guide-context';
import {
  parseXlnAssistantProxyRequest,
  sanitizeXlnAssistantCatalog,
} from '../../frontend/src/lib/server/xln-assistant-proxy';

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

  test('opens the chat inward and inside all viewport edges', () => {
    for (const side of ['left', 'right', 'top', 'bottom'] as const) {
      const placement = { version: 1 as const, side, offsetRatio: 0.5 };
      const point = resolveMascotPoint(placement, phone);
      const panel = resolveMascotPanelRect(placement, point, phone);
      expect(panel.x).toBeGreaterThanOrEqual(12);
      expect(panel.y).toBeGreaterThanOrEqual(12);
      expect(panel.x + panel.width).toBeLessThanOrEqual(phone.width - 12);
      expect(panel.y + panel.height).toBeLessThanOrEqual(phone.height - 12);
    }
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

  test('validates chat roles, sizes and model ids', () => {
    expect(parseXlnAssistantProxyRequest({
      model: 'qwen3-coder:latest',
      messages: [{ role: 'user', content: 'Explain RCPAN' }],
    }).messages).toHaveLength(1);
    expect(() => parseXlnAssistantProxyRequest({ model: '../bad model', messages: [] })).toThrow();
    expect(() => parseXlnAssistantProxyRequest({
      model: 'qwen3-coder:latest',
      messages: [{ role: 'tool', content: 'execute payment' }],
    })).toThrow();
  });

  test('publishes only available, well-formed local models', () => {
    expect(sanitizeXlnAssistantCatalog({
      default_model: 'qwen3-coder:latest',
      models: [
        { id: 'qwen3-coder:latest', name: 'Qwen', available: true },
        { id: 'missing', available: false },
        { id: '../invalid model', available: true },
      ],
    })).toEqual({
      provider: 'local',
      defaultModel: 'qwen3-coder:latest',
      models: [{ id: 'qwen3-coder:latest', name: 'Qwen' }],
    });
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

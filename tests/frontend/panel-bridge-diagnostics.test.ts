import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { panelBridge } from '../../frontend/src/lib/view/utils/panelBridge';

afterEach(() => {
  panelBridge.clear();
});

describe('panel bridge diagnostics', () => {
  test('does not hide listener failures behind raw console output', () => {
    const source = readFileSync('frontend/src/lib/view/utils/panelBridge.ts', 'utf8');

    expect(source).not.toContain('console.error');
    expect(source).not.toContain('console.warn');
    expect(source).toContain('PANEL_BRIDGE_HANDLER_FAILED');
  });

  test('notifies remaining listeners and then fails loud when a listener throws', () => {
    let delivered = false;
    panelBridge.on('vr:toggle', () => {
      throw new Error('listener exploded');
    });
    panelBridge.on('vr:toggle', () => {
      delivered = true;
    });

    expect(() => panelBridge.emit('vr:toggle', {})).toThrow(
      'PANEL_BRIDGE_HANDLER_FAILED:vr:toggle:listener exploded',
    );
    expect(delivered).toBe(true);
  });
});

import { describe, expect, test } from 'bun:test';

import { isBenignConsoleMessage } from '../utils/browser-health-classification';

describe('browser health severity classification', () => {
  test('ignores only Chromium ReadPixels driver diagnostics', () => {
    expect(isBenignConsoleMessage(
      '[.WebGL-0x12c0057fe00]GL Driver Message (OpenGL, Performance, GL_CLOSE_PATH_NV, High): GPU stall due to ReadPixels',
    )).toBe(true);
    expect(isBenignConsoleMessage(
      '[.WebGL-0x12c0057fe00]GL Driver Message (OpenGL, Performance, GL_CLOSE_PATH_NV, High): GPU stall due to ReadPixels (this message will no longer repeat)',
    )).toBe(true);
    expect(isBenignConsoleMessage('Application warning: GPU stall due to ReadPixels')).toBe(false);
    expect(isBenignConsoleMessage('[.WebGL-0x1]GL Driver Message: context lost')).toBe(false);
  });
});

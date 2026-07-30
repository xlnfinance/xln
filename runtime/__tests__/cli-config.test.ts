import { describe, expect, test } from 'bun:test';

import { hasCliFlag, readCliOption } from '../config/cli';

describe('CLI configuration boundary', () => {
  test('reads spaced and equals options', () => {
    expect(readCliOption(['--port', '8080'], '--port')).toBe('8080');
    expect(readCliOption(['--port=8080'], '--port')).toBe('8080');
    expect(readCliOption([], '--port', '9000')).toBe('9000');
  });

  test('rejects missing and duplicate option values', () => {
    expect(() => readCliOption(['--port'], '--port')).toThrow(
      'CLI_OPTION_VALUE_MISSING:--port',
    );
    expect(() => readCliOption(['--port', '--host'], '--port')).toThrow(
      'CLI_OPTION_VALUE_MISSING:--port',
    );
    expect(() => readCliOption(['--port=1', '--port', '2'], '--port')).toThrow(
      'CLI_OPTION_DUPLICATE:--port',
    );
  });

  test('keeps boolean flags value-free', () => {
    expect(hasCliFlag(['--hub'], '--hub')).toBe(true);
    expect(hasCliFlag([], '--hub')).toBe(false);
    expect(() => hasCliFlag(['--hub=true'], '--hub')).toThrow(
      'CLI_FLAG_VALUE_FORBIDDEN:--hub',
    );
  });
});

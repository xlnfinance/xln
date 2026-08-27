import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { createLocalCheckCommands, parseLocalCheckRequest } from '../../../frontend/scripts/check';
import { parseSurfaceSelection } from '../../../frontend/scripts/surface-selection';

describe('scoped frontend checks', () => {
  test('accepts canonical explicit TypeScript imports without emitting', () => {
    const config = JSON.parse(readFileSync('frontend/tsconfig.react-base.json', 'utf8')) as {
      compilerOptions?: Record<string, unknown>;
    };
    expect(config.compilerOptions?.['moduleResolution']).toBe('Bundler');
    expect(config.compilerOptions?.['allowImportingTsExtensions']).toBe(true);
    expect(config.compilerOptions?.['noEmit']).toBe(true);
  });

  test('selects one surface without broad repository commands', () => {
    const request = parseLocalCheckRequest(['--surface=site', '--level=local']);
    const commands = createLocalCheckCommands(request.surfaceIds);
    expect(commands.map(({ label }) => label)).toEqual([
      'frontend-unsafe-types',
      'react-tooling',
      'react-site',
    ]);
    expect(commands.flatMap(({ argv }) => argv).join(' ')).not.toContain('bun run check');
    expect(commands.flatMap(({ argv }) => argv).join(' ')).not.toContain('apps/docs');
  });

  test('selects every surface explicitly', () => {
    expect(parseSurfaceSelection(['--all'])).toEqual(['site', 'docs', 'wallet', 'ops']);
  });

  test('rejects ambiguous or unsupported requests', () => {
    expect(() => parseSurfaceSelection([])).toThrow('FRONTEND_SURFACE_REQUIRED');
    expect(() => parseSurfaceSelection(['--surface=site', '--all'])).toThrow(
      'FRONTEND_SURFACE_SELECTION_CONFLICT',
    );
    expect(() => parseLocalCheckRequest(['--surface=site', '--level=repository'])).toThrow(
      'FRONTEND_CHECK_LEVEL_UNSUPPORTED',
    );
  });
});

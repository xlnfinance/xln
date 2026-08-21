import { describe, expect, test } from 'bun:test';

import { createBuildCommands } from '../../../frontend/scripts/build';
import { SURFACE_IDS, SURFACES } from '../../../frontend/config/surfaces';

describe('React application build isolation', () => {
  test('uses one app config per selected surface', () => {
    const commands = createBuildCommands(SURFACE_IDS);
    expect(commands).toHaveLength(4);
    for (const surfaceId of SURFACE_IDS) {
      expect(commands.some(({ argv }) => argv.includes(`apps/${surfaceId}/vite.config.ts`))).toBe(true);
    }
  });

  test('does not invoke the canonical Svelte build path', () => {
    const commandText = createBuildCommands(['site']).flatMap(({ argv }) => argv).join(' ');
    expect(commandText).not.toContain('frontend/vite.config.ts');
    expect(commandText).not.toContain('bun run build');
    expect(commandText).not.toContain('svelte');
  });

  test('assigns collision-free candidate outputs', () => {
    const outputDirectories = SURFACES.map(({ artifactDirectory }) => artifactDirectory);
    expect(new Set(outputDirectories).size).toBe(SURFACES.length);
    expect(outputDirectories).not.toContain('build');
  });
});

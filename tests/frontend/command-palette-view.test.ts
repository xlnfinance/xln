import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  buildCommandPaletteView,
  buildCommandPaletteViewFromRuntimeView,
  findCommandPaletteEntities,
} from '../../frontend/src/lib/components/shared/command-palette-view';

const A = `0x${'11'.repeat(32)}`;
const B = `0x${'22'.repeat(32)}`;
const C = `0x${'33'.repeat(32)}`;

test('command palette view builds a deduplicated entity search index', () => {
  const view = buildCommandPaletteView({
    gossip: {
      getProfiles: () => [
        { entityId: A, name: 'Alice', metadata: { isHub: false } },
        { entityId: B, name: 'Hub One', metadata: { isHub: true } },
      ],
    },
    eReplicas: new Map([
      [`${A}:signer`, { state: { profile: { name: 'Duplicate Alice' } } }],
      [`${C}:signer`, { state: { entityId: C, profile: { name: 'Charlie' } } }],
    ]),
  });

  expect(view.entities).toEqual([
    { id: A.toLowerCase(), name: 'Alice', isHub: false },
    { id: C.toLowerCase(), name: 'Charlie', isHub: false },
    { id: B.toLowerCase(), name: 'Hub One', isHub: true },
  ]);
  expect(findCommandPaletteEntities('hub', view)).toEqual([
    { id: B.toLowerCase(), name: 'Hub One', isHub: true },
  ]);
});

test('command palette view builds a remote RuntimeView projection search index', () => {
  const view = buildCommandPaletteViewFromRuntimeView({
    height: 12,
    head: { latestHeight: 12 },
    activeEntityId: C,
    entities: [
      { entityId: B, label: 'Hub One', height: 11, isHub: true },
      { entityId: A, label: 'Alice', height: 10 },
    ],
    activeEntity: {
      summary: { entityId: C, label: 'Charlie', height: 12 },
      core: { entityId: C, profile: { name: 'Charlie Runtime' } },
      accounts: { items: [], totalItems: 0, pageIndex: 0, pageCount: 1 },
      books: { items: [], totalItems: 0, pageIndex: 0, pageCount: 1 },
    },
  } as never);

  expect(view.entities).toEqual([
    { id: A.toLowerCase(), name: 'Alice', isHub: false },
    { id: C.toLowerCase(), name: 'Charlie Runtime', isHub: false },
    { id: B.toLowerCase(), name: 'Hub One', isHub: true },
  ]);
  expect(findCommandPaletteEntities('runtime', view)).toEqual([
    { id: C.toLowerCase(), name: 'Charlie Runtime', isHub: false },
  ]);
});

test('CommandPalette consumes CommandPaletteView instead of owning runtime env reads', () => {
  const palette = readFileSync('frontend/src/lib/components/shared/CommandPalette.svelte', 'utf8');
  const view = readFileSync('frontend/src/lib/view/View.svelte', 'utf8');

  expect(palette).toContain('export let commandPaletteView: CommandPaletteView');
  expect(palette).toContain('findCommandPaletteEntities');
  expect(palette).not.toContain('xlnEnvironment');
  expect(palette).not.toContain('xlnFunctions');
  expect(palette).not.toContain('env.eReplicas');
  expect(palette).not.toContain('validatedProfiles');
  expect(view).toContain('buildCommandPaletteView(viewEnv)');
  expect(view).toContain('buildCommandPaletteViewFromRuntimeView');
  expect(view).toContain('{commandPaletteView}');
});

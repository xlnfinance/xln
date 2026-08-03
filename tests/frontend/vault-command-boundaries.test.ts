import { expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const read = (path: string): string => readFileSync(path, 'utf8');
const filesUnder = (directory: string): string[] => readdirSync(directory).flatMap(entry => {
  const path = join(directory, entry);
  return statSync(path).isDirectory() ? filesUnder(path) : [path];
});

test('vault and runtime command reducers are framework-neutral and deterministic', () => {
  const vault = read('frontend/packages/runtime-client/vault-lifecycle.ts');
  const commands = read('frontend/packages/runtime-client/runtime-command-transitions.ts');
  const source = `${vault}\n${commands}`;

  expect(source).not.toMatch(/from ['"](?:react|svelte|svelte\/store)['"]/);
  expect(source).not.toContain('Date.now');
  expect(source).not.toContain('Math.random');
  expect(source).not.toContain('randomUUID');
  expect(source).not.toContain('localStorage');
  expect(source).not.toContain('indexedDB');
});

test('vault state has one external-store owner and only a readonly Svelte adapter', () => {
  const source = read('frontend/src/lib/stores/vaultStore.ts');
  expect(source).toContain('const runtimesStateBinding = createExternalStore<RuntimesState>(defaultState)');
  expect(source).toContain('export const runtimesStateExternalStore = runtimesStateBinding.store');
  expect(source).toContain('export const runtimesState = toSvelteReadable(runtimesStateBinding.store)');
  expect(source).not.toContain("from 'svelte/store'");
  expect(source).not.toMatch(/export const runtimesState\s*=\s*writable/);
});

test('view components cannot import vault protection or command journal storage ports', () => {
  const viewFiles = filesUnder('frontend/src')
    .filter(path => /\.(svelte|tsx|jsx)$/.test(path));
  const violations = viewFiles.filter(path => {
    const source = read(path);
    return source.includes('/security/vaultProtection')
      || source.includes('/stores/runtimeCommandJournalStorage')
      || source.includes('/stores/runtimeCommandJournalIndexedDb');
  });
  expect(violations).toEqual([]);
});

test('vault and journal diagnostics never emit raw console output', () => {
  const files = [
    'frontend/src/lib/stores/vaultStore.ts',
    'frontend/src/lib/stores/runtimeCommandIntent.ts',
    'frontend/src/lib/stores/runtimeCommandJournalStorage.ts',
  ];
  for (const file of files) expect(read(file)).not.toMatch(/\bconsole\.(?:log|debug|info|warn|error)\s*\(/);
});

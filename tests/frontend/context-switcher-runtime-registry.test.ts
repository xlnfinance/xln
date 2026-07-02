import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

test('ContextSwitcher hydrates the shared remote runtime registry before showing rows', () => {
  const source = readFileSync('frontend/src/lib/components/Entity/ContextSwitcher.svelte', 'utf8');

  expect(source).toContain('onMount');
  expect(source).toContain('runtimeOperations.hydrateRemoteRuntimeImports()');
  expect(source).toContain("import { runtimeControllerHandle } from '$lib/stores/runtimeControllerStore'");
  expect(source).toContain("import { refreshRuntimeView, runtimeView } from '$lib/stores/runtimeViewStore'");
  expect(source).toContain('controllerRuntimeId = normalizeId($runtimeControllerHandle.runtimeId || $runtimeControllerHandle.id)');
  expect(source.indexOf('normalizeId(group.runtimeId) === controllerRuntimeId'))
    .toBeLessThan(source.indexOf('group.runtimeId === $activeStoreRuntimeId'));
  expect(source).toContain('$runtimeEntries.values()');
  expect(source).toContain('projectionSummariesForRuntime(');
  expect(source).toContain('data-testid="context-entity-row"');
  expect(source).not.toContain('runtime.env');
  expect(source).not.toContain('eReplicas');
});

test('ContextSwitcher closes menu synchronously before remote runtime switch awaits', () => {
  const source = readFileSync('frontend/src/lib/components/Entity/ContextSwitcher.svelte', 'utf8');
  const entityStart = source.indexOf('async function selectRuntimeEntity');
  const selfStart = source.indexOf('async function selectRuntimeSelf');
  const addStart = source.indexOf('function handleAddRuntime', selfStart);
  expect(entityStart).toBeGreaterThan(0);
  expect(selfStart).toBeGreaterThan(entityStart);
  expect(addStart).toBeGreaterThan(selfStart);

  const entitySource = source.slice(entityStart, selfStart);
  const selfSource = source.slice(selfStart, addStart);
  expect(entitySource.indexOf('open = false;')).toBeLessThan(entitySource.indexOf('await selectRemoteRuntime'));
  expect(selfSource.indexOf('open = false;')).toBeLessThan(selfSource.indexOf('await selectRemoteRuntime'));
});

test('ContextSwitcher remote rows switch runtime without dispatching stale metadata entity ids', () => {
  const source = readFileSync('frontend/src/lib/components/Entity/ContextSwitcher.svelte', 'utf8');
  const entityStart = source.indexOf('async function selectRuntimeEntity');
  const selfStart = source.indexOf('async function selectRuntimeSelf');
  const addStart = source.indexOf('function handleAddRuntime', selfStart);
  const entitySource = source.slice(entityStart, selfStart);
  const selfSource = source.slice(selfStart, addStart);

  expect(source).toContain('async function selectRemoteRuntime(runtimeId: string): Promise<void>');
  expect(source).toContain('await refreshRuntimeView({});');
  expect(entitySource).toContain("if (group?.source === 'remote') {");
  expect(entitySource).toContain('await selectRemoteRuntime(runtimeId);');
  expect(entitySource).toContain('return;');
  expect(entitySource.indexOf('return;')).toBeLessThan(entitySource.indexOf("dispatch('entitySelect'"));
  expect(selfSource).toContain("if (group.source === 'remote') {");
  expect(selfSource).toContain('await selectRemoteRuntime(group.runtimeId);');
  expect(selfSource).toContain('return;');
  expect(selfSource.indexOf('return;')).toBeLessThan(selfSource.indexOf("dispatch('entitySelect'"));
});

test('ContextSwitcher labels projection-only remote runtimes instead of saying no runtime selected', () => {
  const source = readFileSync('frontend/src/lib/components/Entity/ContextSwitcher.svelte', 'utf8');

  expect(source).toContain('currentGroup\n      ? resolveRuntimeMeta(currentGroup)\n      : \'No runtime selected\'');
});

test('ContextSwitcher does not pick the first sorted projection entity as the remote runtime identity', () => {
  const source = readFileSync('frontend/src/lib/components/Entity/ContextSwitcher.svelte', 'utf8');

  expect(source).toContain('const selfEntity = resolveRemotePrimaryEntity(runtime, entities)');
  expect(source).toContain('remoteEntityNameMatchesRuntimeLabel');
  expect(source).toContain('normalizeId(entity.entityId) !== normalizeId(selfEntity.entityId)');
  expect(source).not.toContain('const selfEntity = entities[0] || null');
  expect(source).not.toContain('derivedEntities: selfEntity ? entities.slice(1) : entities');
});

test('remote empty entity state still exposes the context runtime switcher', () => {
  const emptyState = readFileSync('frontend/src/lib/components/Entity/EntitySelectionEmptyState.svelte', 'utf8');
  const tabs = readFileSync('frontend/src/lib/components/Entity/EntityPanelTabs.svelte', 'utf8');

  expect(emptyState).toContain('ContextSwitcher');
  expect(emptyState).toContain('{#if userModeHeader && tab}');
  expect(emptyState).toContain('on:entitySelect={handleEntitySelect}');
  expect(tabs).toContain('<EntitySelectionEmptyState');
  expect(tabs).toContain('{handleEntitySelect}');
  expect(tabs).toContain('{handleHeaderAddRuntime}');
});

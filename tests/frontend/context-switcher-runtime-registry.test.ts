import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

test('ContextSwitcher hydrates the shared remote runtime registry before showing rows', () => {
  const source = readFileSync('frontend/src/lib/components/Entity/ContextSwitcher.svelte', 'utf8');

  expect(source).toContain('onMount');
  expect(source).toContain('runtimeOperations.hydrateRemoteRuntimeImports()');
  expect(source).toContain("import { runtimeControllerHandle } from '$lib/stores/runtimeControllerStore'");
  expect(source).toContain("from '$lib/stores/runtimeViewStore'");
  expect(source).toContain('setRuntimeViewActiveEntityId');
  expect(source).toContain('controllerRuntimeId = normalizeId($runtimeControllerHandle.runtimeId || $runtimeControllerHandle.id)');
  expect(source.indexOf('normalizeId(group.runtimeId) === controllerRuntimeId'))
    .toBeLessThan(source.indexOf('group.runtimeId === $activeStoreRuntimeId'));
  expect(source).toContain('$runtimeEntries.values()');
  expect(source).toContain('projectionSummariesForRuntime(');
  expect(source).toContain('runtimeMenuGroups = buildRuntimeMenuGroups(runtimeGroups)');
  expect(source).toContain('data-testid="context-runtime-group"');
  expect(source).toContain('data-testid="context-runtime-label"');
  expect(source).toContain('data-testid="context-runtime-source"');
  expect(source).toContain('{runtimeGroup.source}');
  expect(source).toContain('`${normalizeId(entity.runtimeId)}:${normalizeId(entity.entityId)}`');
  expect(source).toContain('data-testid="context-jurisdiction-group"');
  expect(source).toContain('data-testid="context-jurisdiction-label"');
  expect(source).toContain('data-testid="context-entity-row"');
  expect(source).toContain('data-entity-label={normalizeId(entity.name)}');
  expect(source).not.toContain('class="runtime-main"');
  expect(source).not.toContain('runtime.env');
  expect(source).not.toContain('eReplicas');
});

test('ContextSwitcher closes menu synchronously before remote runtime switch awaits', () => {
  const source = readFileSync('frontend/src/lib/components/Entity/ContextSwitcher.svelte', 'utf8');
  const entityStart = source.indexOf('async function selectRuntimeEntity');
  const addStart = source.indexOf('function handleAddRuntime', entityStart);
  expect(entityStart).toBeGreaterThan(0);
  expect(addStart).toBeGreaterThan(entityStart);

  const entitySource = source.slice(entityStart, addStart);
  expect(entitySource.indexOf('open = false;')).toBeLessThan(entitySource.indexOf('await selectRemoteRuntime'));
});

test('ContextSwitcher remote rows switch runtime and selected projected entity together', () => {
  const source = readFileSync('frontend/src/lib/components/Entity/ContextSwitcher.svelte', 'utf8');
  const entityStart = source.indexOf('async function selectRuntimeEntity');
  const addStart = source.indexOf('function handleAddRuntime', entityStart);
  const entitySource = source.slice(entityStart, addStart);

  expect(source).toContain("async function selectRemoteRuntime(runtimeId: string, entityId = ''): Promise<void>");
  expect(source).toContain('setRuntimeViewActiveEntityId(normalizedEntityId)');
  expect(source).toContain('await refreshRuntimeView(normalizedEntityId ? { entityId: normalizedEntityId } : {})');
  expect(entitySource).toContain("if (group?.source === 'remote') {");
  expect(entitySource).toContain("const selectedEntityId = entity.isPlaceholder ? '' : entity.entityId");
  expect(entitySource).toContain('await selectRemoteRuntime(runtimeId, selectedEntityId);');
  expect(entitySource).toContain("dispatch('entitySelect'");
  expect(entitySource.indexOf("dispatch('entitySelect'")).toBeLessThan(entitySource.indexOf('return;'));
  expect(source).not.toContain('async function selectRuntimeSelf');
});

test('ContextSwitcher labels projection-only remote runtimes instead of saying no runtime selected', () => {
  const source = readFileSync('frontend/src/lib/components/Entity/ContextSwitcher.svelte', 'utf8');

  expect(source).toContain('currentGroup\n      ? resolveRuntimeMeta(currentGroup)\n      : \'No runtime selected\'');
});

test('ContextSwitcher does not pick the first sorted projection entity as the remote runtime identity', () => {
  const source = readFileSync('frontend/src/lib/components/Entity/ContextSwitcher.svelte', 'utf8');

  expect(source).toContain('const selfEntity = resolveRemotePrimaryEntity(runtime, entities)');
  expect(source).toContain('const ownedHubEntities = (runtime.hubEntities ?? []).filter');
  expect(source).toContain('ownerRuntimeId === runtimeId');
  expect(source).toContain('isPlaceholder: true');
  expect(source).toContain("const selectedEntityId = entity.isPlaceholder ? '' : entity.entityId");
  expect(source).toContain('remoteEntityNameMatchesRuntimeLabel');
  expect(source).toContain('normalizeId(entity.entityId) !== normalizeId(selfEntity.entityId)');
  expect(source).not.toContain('const selfEntity = entities[0] || null');
  expect(source).not.toContain('derivedEntities: selfEntity ? entities.slice(1) : entities');
});

test('ContextSwitcher keeps local controls visible and gates runtime mutations by write capability', () => {
  const source = readFileSync('frontend/src/lib/components/Entity/ContextSwitcher.svelte', 'utf8');

  expect(source).toContain("runtimeMutationControlsEnabled = $runtimeControllerHandle.permissions === 'write'");
  expect(source).toContain('{#if runtimeMutationControlsEnabled && allowAddEntity}');
  expect(source).toContain('{#if runtimeMutationControlsEnabled && allowAddJurisdiction}');
  expect(source).toContain('{#if allowAddRuntime}');
  expect(source).toContain('<button class="reset-btn" on:click={handleReset}>Reset All Data</button>');
  expect(source).not.toContain("mutatingLocalControlsEnabled = $runtimeControllerHandle.mode !== 'remote'");
});

test('ContextSwitcher only adds projection entities owned by the matching runtime', () => {
  const source = readFileSync('frontend/src/lib/components/Entity/ContextSwitcher.svelte', 'utf8');

  expect(source).toContain('const projectionRuntimeId = normalizeId(summary?.runtimeId)');
  expect(source).toContain('if (projectionRuntimeId !== normalizeId(runtimeId)) continue;');
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

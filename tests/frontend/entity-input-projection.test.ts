import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';

test('EntityInput consumes projected profiles instead of global runtime env', () => {
  const entityInput = readFileSync('frontend/src/lib/components/shared/EntityInput.svelte', 'utf8');
  const payment = readFileSync('frontend/src/lib/components/Entity/PaymentPanel.svelte', 'utf8');
  const move = readFileSync('frontend/src/lib/components/Entity/MoveWorkspace.svelte', 'utf8');
  const settlement = readFileSync('frontend/src/lib/components/Entity/SettlementPanel.svelte', 'utf8');
  const accountOpen = readFileSync('frontend/src/lib/components/Entity/AccountOpenPanel.svelte', 'utf8');
  const accountWorkspace = readFileSync('frontend/src/lib/components/Entity/AccountWorkspaceView.svelte', 'utf8');
  const assets = readFileSync('frontend/src/lib/components/Entity/EntityAssetsTab.svelte', 'utf8');
  const tabs = readFileSync('frontend/src/lib/components/Entity/EntityPanelTabs.svelte', 'utf8');

  expect(entityInput).toContain('export let profiles: GossipProfile[] = []');
  expect(entityInput).toContain('activeProfiles = Array.isArray(profiles) ? profiles : []');
  expect(entityInput).not.toContain('xlnEnvironment');
  expect(entityInput).not.toContain('$xlnEnvironment');
  expect(entityInput).not.toContain('getProfilesFromSource');
  expect(entityInput).not.toContain('getGossipProfile(');
  expect(entityInput).not.toContain('scheduleGossipProfileFetch');

  expect(payment).toContain('profiles={runtimeProfiles}');
  expect(move).toContain('export let profiles: GossipProfile[] = []');
  expect(settlement).toContain('export let profiles: GossipProfile[] = []');
  expect(settlement).toContain('export let env: Env | EnvSnapshot | null = null');
  expect(settlement).toContain('if (historyOnly) return;');
  expect(settlement).not.toContain('activeEnv?.gossip');
  expect(settlement).not.toContain('getFrameReplicaMap');
  expect(accountOpen).toContain('export let profiles: GossipProfile[] = []');
  expect(accountWorkspace).toContain('profiles = Array.from(profileByEntityId.values())');
  expect(assets).toContain('profiles = Array.from(profileByEntityId.values())');
  expect(assets).not.toContain('EnvSnapshot');
  expect(assets).not.toContain('export let activeEnv');
  expect(tabs).toContain('profileByEntityId={panelView.profileByEntityId}');
});

test('entity naming helpers are projection-only and do not perform hidden runtime fetches', () => {
  const entityNaming = readFileSync('frontend/src/lib/utils/entityNaming.ts', 'utf8');
  const entitySelect = readFileSync('frontend/src/lib/components/Entity/EntitySelect.svelte', 'utf8');
  const entityDropdown = readFileSync('frontend/src/lib/components/Entity/EntityDropdown.svelte', 'utf8');
  const accountDropdown = readFileSync('frontend/src/lib/components/Entity/AccountDropdown.svelte', 'utf8');

  for (const source of [entityNaming, entitySelect, entityDropdown, accountDropdown]) {
    expect(source).not.toContain('scheduleGossipProfileFetch');
    expect(source).not.toContain('xlnEnvironment');
    expect(source).not.toContain('$xlnEnvironment');
  }
  expect(entityNaming).not.toContain('getXLN');
  expect(entityNaming).not.toContain('Date.now');
  expect(entityNaming).not.toContain('setTimeout');
  expect(entityNaming).not.toContain('catch');
});

test('entity factory auto-create uses injected runtime env and fails loud', () => {
  const entityFactory = readFileSync('frontend/src/lib/utils/entityFactory.ts', 'utf8');
  const vaultStore = readFileSync('frontend/src/lib/stores/vaultStore.ts', 'utf8');

  expect(entityFactory).toContain('export async function autoCreateEntityForSigner');
  expect(entityFactory).toContain('env: Env,');
  expect(entityFactory).toContain('const runtimeEnv = unwrapLiveRuntimeEnv(env) ?? env;');
  expect(entityFactory).toContain("throw new Error('[EntityFactory] No runtime env available for auto-create');");
  expect(entityFactory).toContain('available=${formatJMachineNames(env)}');
  expect(entityFactory).toContain('Refusing to create signer entity in another jurisdiction');
  expect(entityFactory).not.toContain('console.error');
  expect(entityFactory).not.toContain('console.warn');
  expect(entityFactory).not.toContain('console.info');
  expect(entityFactory).not.toContain('xlnEnvironment');
  expect(entityFactory).not.toContain('activeEnv');
  expect(entityFactory).not.toContain('return null;\n    } catch (error)');

  expect(vaultStore).toContain('const runtimeEntry = get(runtimes).get(runtime.id);');
  expect(vaultStore).toContain('autoCreateEntityForSigner(address, runtimeEnv, jurisdiction)');
  expect(vaultStore).toContain('toasts.error(`Failed to create signer entity:');
  expect(vaultStore).toContain('throw err;');
});

test('entity factory rechecks bootstrap ownership and dispatches only to its injected runtime', () => {
  const source = readFileSync('frontend/src/lib/utils/entityFactory.ts', 'utf8');
  const userMode = readFileSync('frontend/src/lib/view/UserModePanel.svelte', 'utf8');
  const createStart = source.indexOf('export async function createEphemeralEntity(');
  const createEnd = source.indexOf('\nfunction findReplicaBySigner(', createStart);
  const createSource = source.slice(createStart, createEnd);
  const loadRuntime = createSource.indexOf('const xln = await getXLN();');
  const recheckReplica = createSource.indexOf(
    'const readyReplica = findReplicaBySigner(runtimeEnv, signerId, jurisdictionName);',
  );
  const dispatch = createSource.indexOf(
    'await dispatchRuntimeInputToRuntimeEnv(runtimeEnv, runtimeInput);',
  );

  expect(createStart).toBeGreaterThan(0);
  expect(createEnd).toBeGreaterThan(createStart);
  expect(recheckReplica).toBeGreaterThan(loadRuntime);
  expect(dispatch).toBeGreaterThan(recheckReplica);
  expect(createSource).not.toContain('submitRuntimeInput(runtimeInput)');
  expect(userMode).not.toContain('createSelfEntity');
  expect(userMode).not.toContain('ensureSelfEntities');
});

test('vault user token helpers use active RuntimeStore env and RuntimeInput command path', () => {
  const vaultStore = readFileSync('frontend/src/lib/stores/vaultStore.ts', 'utf8');
  const balanceStart = vaultStore.indexOf('async getEntityBalance');
  const clearStart = vaultStore.indexOf('// === MVP: Send tokens', balanceStart);
  const sendStart = vaultStore.indexOf('async sendTokens');
  const endStart = vaultStore.indexOf('// === MVP: Get XLN balance for active entity ===', sendStart + 1);
  expect(balanceStart).toBeGreaterThan(0);
  expect(sendStart).toBeGreaterThan(balanceStart);
  const helperSource = vaultStore.slice(balanceStart, endStart > sendStart ? endStart : vaultStore.length);

  expect(helperSource).toContain('const runtimeEntry = activeId ? get(runtimes).get(activeId) : null;');
	  expect(helperSource).toContain('await submitXlnEntityInputs([{');
	  expect(helperSource).not.toContain('await submitXlnEntityInputs(env,');
	  expect(helperSource).toContain("type: 'r2r'");
	  expect(helperSource).not.toContain('xlnEnvironment');
	  expect(helperSource).not.toContain('queueEntityInput');
	  expect(vaultStore).not.toContain('async enqueueRuntimeInput');
	});

test('unmounted legacy Env owner panels are removed instead of kept as dead code', () => {
  expect(existsSync('frontend/src/lib/components/Admin/AdminPanel.svelte')).toBe(false);
  expect(existsSync('frontend/src/lib/components/Network/ProfileForm.svelte')).toBe(false);
  expect(existsSync('frontend/src/lib/components/Network/ProfileCard.svelte')).toBe(false);
});

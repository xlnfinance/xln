import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  buildEntityPanelView,
  getCurrentEntityJurisdictionKey,
  getCurrentEntityJurisdictionName,
  getEntityJurisdictionKey,
  getEntityJurisdictionKeyFromReplicas,
  hasDevnetJurisdiction,
  isSameJurisdictionEntity,
  isSameJurisdictionEntityInReplicas,
  jurisdictionKey,
} from '../../frontend/src/lib/components/Entity/entity-panel-model';
import { buildAccountPageView, resolveAccountListEntityName } from '../../frontend/src/lib/components/Entity/account-list-view';

describe('entity panel model helpers', () => {
  test('builds stable jurisdiction keys from contract config', () => {
    expect(jurisdictionKey({ chainId: 31337, depositoryAddress: '0xABCDEF', name: 'Ignored' }))
      .toBe('dep:31337:0xabcdef');
    expect(jurisdictionKey({ chainId: 31338, name: 'Fallback' })).toBe('chain:31338');
    expect(jurisdictionKey({ name: 'Base Sepolia' })).toBe('base sepolia');
    expect(jurisdictionKey('Testnet')).toBe('testnet');
  });

  test('resolves current entity jurisdiction from replica before active env fallback', () => {
    const env = { activeJurisdiction: 'Fallback' } as any;
    const replica = {
      state: {
        config: { jurisdiction: { name: 'Configured', chainId: 1 } },
      },
    } as any;

    expect(getCurrentEntityJurisdictionName(env, replica)).toBe('Configured');
    expect(getCurrentEntityJurisdictionKey(env, replica)).toBe('chain:1');
    expect(getCurrentEntityJurisdictionName(env, null)).toBe('Fallback');
    expect(getCurrentEntityJurisdictionKey(env, null)).toBe('fallback');
  });

  test('resolves entity jurisdiction from replicas and gossip fallback', () => {
    const env = {
      eReplicas: new Map([
        ['alice:signer', {
          entityId: 'alice',
          state: { entityId: 'alice', config: { jurisdiction: { chainId: 10 } } },
        }],
      ]),
      gossip: {
        getProfiles: () => [
          { entityId: 'bob', metadata: { jurisdiction: { name: 'Remote J' } } },
        ],
      },
    } as any;

    expect(getEntityJurisdictionKey(env, 'ALICE')).toBe('chain:10');
    expect(getEntityJurisdictionKey(env, 'bob')).toBe('remote j');
    expect(getEntityJurisdictionKey(env, 'missing')).toBe('');
  });

  test('compares entity jurisdiction with current replica context', () => {
    const replica = {
      state: {
        entityId: 'alice',
        config: { jurisdiction: { chainId: 10 } },
      },
    } as any;
    const env = {
      eReplicas: new Map([
        ['hub:signer', {
          entityId: 'hub',
          state: { entityId: 'hub', config: { jurisdiction: { chainId: 10 } } },
        }],
        ['remote:signer', {
          entityId: 'remote',
          state: { entityId: 'remote', config: { jurisdiction: { chainId: 20 } } },
        }],
      ]),
    } as any;

    expect(isSameJurisdictionEntity(env, replica, 'alice', 'alice', 'hub')).toBe(true);
    expect(isSameJurisdictionEntity(env, replica, 'alice', 'alice', 'remote')).toBe(false);
    expect(isSameJurisdictionEntity({} as any, null, '', 'left', 'right')).toBe(true);
    expect(isSameJurisdictionEntity(env, replica, 'alice', 'alice', 'unknown-hub')).toBe(true);
  });

  test('compares entity jurisdiction from projected replica maps without Env ownership', () => {
    const replica = {
      state: {
        entityId: 'alice',
        config: { jurisdiction: { chainId: 10 } },
      },
    } as any;
    const replicas = new Map([
      ['hub:signer', {
        entityId: 'hub',
        state: { entityId: 'hub', config: { jurisdiction: { chainId: 10 } } },
      }],
      ['remote:signer', {
        entityId: 'remote',
        state: { entityId: 'remote', config: { jurisdiction: { chainId: 20 } } },
      }],
    ]) as any;

    expect(getEntityJurisdictionKeyFromReplicas(replicas, 'HUB')).toBe('chain:10');
    expect(isSameJurisdictionEntityInReplicas(replicas, replica, 'alice', 'alice', 'hub')).toBe(true);
    expect(isSameJurisdictionEntityInReplicas(replicas, replica, 'alice', 'alice', 'remote')).toBe(false);
    expect(isSameJurisdictionEntityInReplicas(replicas, replica, 'alice', 'alice', 'unknown-hub')).toBe(true);
  });

  test('projects entity panel read model from env once at the model boundary', () => {
    const view = buildEntityPanelView({
      runtimeId: 'runtime-1',
      height: 42,
      timestamp: 1234,
      activeJurisdiction: 'Testnet',
      eReplicas: new Map([
        ['alice:signer-a', {
          entityId: 'alice',
          state: { entityId: 'alice', accounts: new Map([['bob', {}]]) },
        }],
        ['h1:signer-h1', {
          entityId: 'h1',
          state: { entityId: 'h1', profile: { name: 'H1', isHub: true }, accounts: new Map() },
        }],
      ]),
      jReplicas: new Map([
        ['testnet', { name: 'Testnet', chainId: 31337 }],
      ]),
      gossip: {
        getProfiles: () => [
          { entityId: 'alice', name: 'Alice', metadata: { isHub: false } },
        ],
      },
    } as any, 'ALICE', 'signer-a', 'rev-1');

    expect(view.runtimeId).toBe('runtime-1');
    expect(view.height).toBe(42);
    expect(view.timestamp).toBe(1234);
    expect(view.activeJurisdictionName).toBe('Testnet');
    expect(view.replica?.state?.entityId).toBe('alice');
    expect(view.replicas?.size).toBe(2);
    expect(view.profiles.map((profile) => profile.name)).toEqual(['Alice']);
    expect(view.entityNames.get('alice')).toBe('Alice');
    expect(view.entityNames.get('h1')).toBe('H1');
    expect(view.profileByEntityId.get('alice')?.name).toBe('Alice');
    expect(view.jurisdictions).toEqual([{ name: 'Testnet', chainId: 31337 }]);
    expect(view.isDevnet).toBe(true);
  });

  test('projects remote runtime view accounts into the entity account list model', () => {
    const entityId = '0xaaa';
    const signerId = '0xsigner';
    const hubOne = '0xh1';
    const hubTwo = '0xh2';
    const frame = {
      height: 77,
      head: { latestHeight: 77 },
      entities: [
        { entityId, signerId, label: 'B', height: 77, jurisdiction: { name: 'Testnet', chainId: 31337 } },
        { entityId: hubOne, label: 'H1', height: 77, isHub: true, jurisdiction: { name: 'Testnet', chainId: 31337 } },
        { entityId: hubTwo, label: 'H2', height: 77, isHub: true, jurisdiction: { name: 'Testnet', chainId: 31337 } },
      ],
      activeEntityId: entityId,
      activeEntity: {
        summary: { entityId, signerId, label: 'B', height: 77, jurisdiction: { name: 'Testnet', chainId: 31337 } },
        core: {
          entityId,
          signerId,
          height: 76,
          timestamp: 5678,
          profile: { name: 'B' },
          config: { jurisdiction: { name: 'Testnet', chainId: 31337 } },
          lockBook: new Map(),
          htlcRoutes: new Map(),
          htlcFeesEarned: 0n,
        },
        accounts: {
          items: [
            {
              leftEntity: entityId,
              rightEntity: hubOne,
              status: 'open',
              deltas: new Map([[1, { offdelta: 10n }]]),
              currentHeight: 5,
              currentFrame: { height: 5, timestamp: 1000, outcome: [], accountTxs: [] },
              mempool: [],
              locks: new Map(),
              swapOffers: new Map(),
              globalCreditLimits: new Map(),
              pendingSignatures: [],
              rollbackCount: 0,
              lastFinalizedJHeight: 3,
              pendingWithdrawals: new Map(),
              requestedRebalance: new Map(),
              requestedRebalanceFeeState: new Map(),
              rebalancePolicy: new Map(),
            },
            {
              leftEntity: hubTwo,
              rightEntity: entityId,
              status: 'open',
              deltas: new Map([[1, { offdelta: -2n }]]),
              currentHeight: 4,
              currentFrame: { height: 4, timestamp: 900, outcome: [], accountTxs: [] },
              mempool: [],
              locks: new Map(),
              swapOffers: new Map(),
              globalCreditLimits: new Map(),
              pendingSignatures: [],
              rollbackCount: 0,
              lastFinalizedJHeight: 2,
              pendingWithdrawals: new Map(),
              requestedRebalance: new Map(),
              requestedRebalanceFeeState: new Map(),
              rebalancePolicy: new Map(),
            },
          ],
          nextCursor: null,
          totalItems: 2,
          limit: 10,
          pageIndex: 0,
          pageCount: 1,
        },
        books: { items: [], nextCursor: null, totalItems: 0, limit: 10, pageIndex: 0, pageCount: 0 },
      },
    };

    const view = buildEntityPanelView(
      { runtimeId: 'remote-h2' } as any,
      entityId,
      signerId,
      'rev-remote',
      frame as never,
    );
    const accountPage = buildAccountPageView(view.replica, false, 0, '');

    expect(view.height).toBe(77);
    expect(view.timestamp).toBe(5678);
    expect(view.replica?.state?.accounts?.size).toBe(2);
    expect(view.replica?.state?.accounts?.get(hubOne)?.deltas.get(1)?.offdelta).toBe(10n);
    expect(view.replica?.state?.accounts?.get(hubTwo)?.deltas.get(1)?.offdelta).toBe(-2n);
    expect(view.entityNames.get(hubOne)).toBe('H1');
    expect(view.jurisdictions).toEqual([{ name: 'Testnet', chainId: 31337 }]);
    expect(view.isDevnet).toBe(true);
    expect(accountPage.entries.map((entry) => entry.counterpartyId)).toEqual([hubOne, hubTwo]);
  });

  test('entity panel tabs consumes EntityPanelView instead of rebuilding env projections inline', () => {
    const source = readFileSync('frontend/src/lib/components/Entity/EntityPanelTabs.svelte', 'utf8');
    expect(source).toContain('displayEnv = activeIsLive ? (actionRuntimeEnv ?? activeEnv) : activeEnv');
    expect(source).toContain('displayProjectionFrame = activeIsLive && actionRuntimeEnv ? null : runtimeProjectionFrame');
    expect(source).toContain('panelView = buildEntityPanelView(displayEnv, tab.entityId, tab.signerId, envRevision, displayProjectionFrame)');
    expect(source).toContain('directoryPanelView = runtimeProjectionFrame');
    expect(source).toContain('activeReplicas = panelView.replicas');
    expect(source).toContain('panelProfiles = panelView.profiles');
    expect(source).toContain('availableJurisdictions = panelView.jurisdictions');
    expect(source).toContain('isSameJurisdictionEntityInReplicas(activeReplicas');
    expect(source).not.toContain('getEnvReplicaMap(activeEnv');
    expect(source).not.toContain('getGossipProfiles(activeEnv');
    expect(source).not.toContain('env?.jReplicas');
    expect(source).not.toContain('function findReplicaForTab');
    expect(source).not.toContain('getRuntimeId(activeEnv');
    expect(source).not.toContain('getCurrentEntityJurisdictionName(activeEnv');
    expect(source).not.toContain('isSameJurisdictionEntity(activeEnv');
  });

  test('focused account display consumes projected entity names instead of full env', () => {
    const accountPanel = readFileSync('frontend/src/lib/components/Entity/AccountPanel.svelte', 'utf8');
    const focusedView = readFileSync('frontend/src/lib/components/Entity/EntityFocusedAccountView.svelte', 'utf8');
    const tabs = readFileSync('frontend/src/lib/components/Entity/EntityPanelTabs.svelte', 'utf8');

    expect(accountPanel).toContain('export let entityNames: Map<string, string>');
    expect(accountPanel).not.toContain('EnvSnapshot');
    expect(accountPanel).not.toContain('export let env');
    expect(accountPanel).not.toContain('resolveEntityName(');
    expect(focusedView).toContain('export let entityNames: Map<string, string>');
    expect(focusedView).not.toContain('activeEnv');
    expect(tabs).toContain('entityNames={panelView.entityNames}');
  });

  test('account list display consumes projected height and entity names', () => {
    const accountList = readFileSync('frontend/src/lib/components/Entity/AccountList.svelte', 'utf8');
    const accountWorkspace = readFileSync('frontend/src/lib/components/Entity/AccountWorkspaceView.svelte', 'utf8');
    const tabs = readFileSync('frontend/src/lib/components/Entity/EntityPanelTabs.svelte', 'utf8');

    expect(resolveAccountListEntityName('ALICE', 'alice', new Map(), 'You')).toBe('You');
    expect(resolveAccountListEntityName('BOB', 'alice', new Map([['bob', 'Hub B']]))).toBe('Hub B');
    expect(resolveAccountListEntityName('BOB', 'alice', new Map())).toBe('BOB');
    expect(hasDevnetJurisdiction({ jReplicas: new Map([['local', { chainId: 31337 }]]) } as any)).toBe(true);
    expect(accountList).toContain('export let runtimeHeight: number');
    expect(accountList).toContain('export let entityNames: Map<string, string>');
    expect(accountList).toContain('export let profileByEntityId: Map<string, GossipProfile>');
    expect(accountList).toContain('export let isDevnet');
    expect(accountList).not.toContain('xlnEnvironment');
    expect(accountList).not.toContain('$xlnEnvironment');
    expect(accountList).not.toContain('getEntityDisplayName(');
    const accountPreview = readFileSync('frontend/src/lib/components/Entity/AccountPreview.svelte', 'utf8');
    expect(accountPreview).toContain('export let counterpartyProfile: GossipProfile | null');
    expect(accountPreview).toContain('export let counterpartyName: string');
    expect(accountPreview).toContain('export let isDevnet');
    expect(accountPreview).toContain('data-testid="account-counterparty-full-id"');
    expect(accountPreview).toContain('{counterpartyId}</span>');
    expect(accountPreview).not.toContain('xlnEnvironment');
    expect(accountPreview).not.toContain('$xlnEnvironment');
    expect(accountPreview).not.toContain('activeEnv');
    expect(accountPreview).not.toContain('jReplicas');
    expect(accountPreview).not.toContain('resolveEntityName(');
    expect(accountWorkspace).toContain('export let runtimeHeight: number');
    expect(accountWorkspace).toContain('export let entityNames: Map<string, string>');
    expect(accountWorkspace).toContain('export let profileByEntityId: Map<string, GossipProfile>');
    expect(tabs).toContain('runtimeHeight={panelView.height}');
    expect(tabs).toContain('entityNames={panelView.entityNames}');
    expect(tabs).toContain('profileByEntityId={panelView.profileByEntityId}');
    expect(tabs).toContain('isDevnet={panelView.isDevnet}');
  });

  test('account selectors consume projected entity names without owning env', () => {
    const entitySelect = readFileSync('frontend/src/lib/components/Entity/EntitySelect.svelte', 'utf8');
    const accountDropdown = readFileSync('frontend/src/lib/components/Entity/AccountDropdown.svelte', 'utf8');
    const creditForm = readFileSync('frontend/src/lib/components/Entity/CreditForm.svelte', 'utf8');
    const collateralForm = readFileSync('frontend/src/lib/components/Entity/CollateralForm.svelte', 'utf8');
    const lendingPanel = readFileSync('frontend/src/lib/components/Entity/LendingPanel.svelte', 'utf8');
    const configurePanel = readFileSync('frontend/src/lib/components/Entity/AccountConfigurePanel.svelte', 'utf8');
    const accountWorkspace = readFileSync('frontend/src/lib/components/Entity/AccountWorkspaceView.svelte', 'utf8');

    for (const source of [entitySelect, accountDropdown]) {
      expect(source).toContain('export let entityNames: Map<string, string>');
      expect(source).not.toContain('xlnEnvironment');
      expect(source).not.toContain('$xlnEnvironment');
      expect(source).not.toContain('resolveEntityName(');
      expect(source).not.toContain('getGossipProfiles');
      expect(source).not.toContain('envOverride');
    }

    expect(creditForm).toContain('export let entityNames: Map<string, string>');
    expect(creditForm).toContain('export let actionRuntimeEnv: Env | null = null');
    expect(creditForm).toContain('export let submitRuntimeInput');
    expect(creditForm).not.toContain('export let env: Env');
    expect(creditForm).not.toContain('import { submitEntityInputs');
    expect(creditForm).toContain('<EntitySelect bind:value={selectedCounterparty} options={accountIds} {entityNames}');
    expect(collateralForm).toContain('export let entityNames: Map<string, string>');
    expect(collateralForm).toContain('export let actionRuntimeEnv: Env | null = null');
    expect(collateralForm).toContain('export let submitRuntimeInput');
    expect(collateralForm).toContain('export let accountOverride');
    expect(collateralForm).not.toContain('export let env: Env');
    expect(collateralForm).not.toContain('import { submitEntityInputs');
    expect(collateralForm).toContain('<EntitySelect bind:value={selectedCounterparty} options={accountIds} {entityNames}');
    expect(lendingPanel).toContain('export let entityNames: Map<string, string>');
    expect(lendingPanel).toContain('<EntitySelect bind:value={selectedHubEntityId} options={normalizedAccounts} {entityNames}');
    expect(configurePanel).toContain('export let entityNames: Map<string, string>');
    expect(configurePanel).toContain('actionRuntimeEnv={liveRuntimeEnv}');
    expect(configurePanel).toContain('remoteAdminReady');
    expect(configurePanel).toContain("authLevel === 'admin'");
    expect(configurePanel).toContain('{submitRuntimeInput}');
    expect(accountWorkspace).toContain('<AccountDropdown');
    expect(accountWorkspace).toContain('{entityNames}');
  });

  test('entity header dropdown consumes panel projection without store fallbacks', () => {
    const dropdown = readFileSync('frontend/src/lib/components/Entity/EntityDropdown.svelte', 'utf8');
    const chrome = readFileSync('frontend/src/lib/components/Entity/EntityPanelChrome.svelte', 'utf8');
    const contextSwitcher = readFileSync('frontend/src/lib/components/Entity/ContextSwitcher.svelte', 'utf8');
    const tabs = readFileSync('frontend/src/lib/components/Entity/EntityPanelTabs.svelte', 'utf8');

    expect(dropdown).toContain('export let entityNames: Map<string, string>');
    expect(dropdown).toContain('export let jurisdictions: Array<{ name?: string }>');
    expect(dropdown).toContain('$: activeReplicas = replicasOverride');
    expect(dropdown).not.toContain('xlnEnvironment');
    expect(dropdown).not.toContain('$xlnEnvironment');
    expect(dropdown).not.toContain('$replicas');
    expect(dropdown).not.toContain('visibleReplicas');
    expect(dropdown).not.toContain('envOverride');
    expect(dropdown).not.toContain('resolveEntityName(');
    expect(chrome).toContain('export let entityNames: Map<string, string>');
    expect(chrome).toContain('export let jurisdictions: EntityPanelJurisdictionView[]');
    expect(chrome).toContain('<EntityDropdown');
    expect(chrome).toContain('{entityNames}');
    expect(chrome).toContain('{jurisdictions}');
    expect(chrome).not.toContain('activeEnv');
    expect(contextSwitcher).toContain("import { refreshRuntimeView, runtimeView } from '$lib/stores/runtimeViewStore'");
    expect(contextSwitcher).toContain('projectionSummariesForRuntime(runtime.id');
    expect(contextSwitcher).not.toContain('runtime.env');
    expect(contextSwitcher).not.toContain('eReplicas');
    expect(contextSwitcher).toContain('ariaLabel={currentTitle}');
    expect(tabs).toContain('entityNames={panelView.entityNames}');
    expect(tabs).toContain('jurisdictions={panelView.jurisdictions}');
  });
});

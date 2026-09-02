import { describe, expect, test } from 'bun:test';

import {
  emptyEntityWorkspaceContext,
  projectEntityWorkspaceContext,
} from '../../../frontend/packages/runtime-client/src/entity-workspace-context';

const SELECTED_FRAME = {
  height: 42,
  activeEntityId: '0xAABB',
  activeEntity: {
    summary: { entityId: '0xaabb', label: 'Treasury', jurisdiction: { name: 'Localnet' } },
    core: { entityId: '0xaabb', signerId: '0xCCDD', profile: { name: 'Core fallback' } },
    accounts: { items: [{ id: 'peer-a' }], totalItems: 3 },
  },
};

describe('Entity workspace context projection', () => {
  test('represents an unattached or entity-empty Runtime without invented identity', () => {
    expect(emptyEntityWorkspaceContext()).toEqual({
      status: 'empty', runtimeId: null, height: 0, entityId: null,
      entityName: null, signerId: null, jurisdictionName: null, accountCount: null,
    });
    expect(projectEntityWorkspaceContext({ runtimeId: ' Runtime-A ', frame: { height: 9, activeEntity: null } }))
      .toMatchObject({ status: 'empty', runtimeId: 'Runtime-A', height: 9, entityId: null });
  });

  test('projects only identity, jurisdiction, height, and account-count context', () => {
    expect(projectEntityWorkspaceContext({ runtimeId: ' Runtime-A ', frame: SELECTED_FRAME })).toEqual({
      status: 'selected', runtimeId: 'Runtime-A', height: 42, entityId: '0xaabb',
      entityName: 'Core fallback', signerId: '0xccdd', jurisdictionName: 'Localnet', accountCount: 3,
    });
  });

  test('gives committed core identity fields precedence over adapter summaries', () => {
    const frame = {
      ...SELECTED_FRAME,
      activeEntity: {
        ...SELECTED_FRAME.activeEntity,
        summary: { entityId: '0xaabb', label: 'Summary label', jurisdiction: { name: 'Summary J' } },
        core: { ...SELECTED_FRAME.activeEntity.core, config: { jurisdiction: { name: 'Core J' } } },
      },
    };
    expect(projectEntityWorkspaceContext({ frame })).toMatchObject({
      entityName: 'Core fallback', jurisdictionName: 'Core J', accountCount: 3,
    });
  });

  test('fails loudly on malformed projection identity, height, or account pages', () => {
    expect(() => projectEntityWorkspaceContext({ frame: {} })).toThrow('ENTITY_WORKSPACE_FRAME_HEIGHT_INVALID');
    expect(() => projectEntityWorkspaceContext({
      frame: {
        ...SELECTED_FRAME,
        activeEntityId: '',
        activeEntity: { ...SELECTED_FRAME.activeEntity, summary: {}, core: {}, accounts: { items: [] } },
      },
    })).toThrow('ENTITY_WORKSPACE_ENTITY_ID_MISSING');
    expect(() => projectEntityWorkspaceContext({
      frame: { ...SELECTED_FRAME, activeEntity: { ...SELECTED_FRAME.activeEntity, accounts: { items: [], totalItems: -1 } } },
    })).toThrow('ENTITY_WORKSPACE_ACCOUNT_COUNT_INVALID');
    expect(() => projectEntityWorkspaceContext({ frame: { ...SELECTED_FRAME, activeEntityId: 7 } }))
      .toThrow('ENTITY_WORKSPACE_ENTITY_ID_INVALID');
    expect(() => projectEntityWorkspaceContext({ frame: { ...SELECTED_FRAME, activeEntityId: '0xffff' } }))
      .toThrow('ENTITY_WORKSPACE_ENTITY_ID_MISMATCH');
    expect(() => projectEntityWorkspaceContext({
      frame: { ...SELECTED_FRAME, activeEntity: { ...SELECTED_FRAME.activeEntity, summary: { ...SELECTED_FRAME.activeEntity.summary, label: 7 } } },
    })).toThrow('ENTITY_WORKSPACE_ENTITY_NAME_INVALID');
  });

  test('feeds both legacy projection and React shell contracts from the shared boundary', async () => {
    const [legacyModel, reactShell, reactPage, reactSource] = await Promise.all([
      Bun.file('frontend/src/lib/components/Entity/core/entity-panel-model.ts').text(),
      Bun.file('frontend/packages/ui/src/entity-workspace-shell.tsx').text(),
      Bun.file('frontend/apps/ops/src/ops-entity-workspace.tsx').text(),
      Bun.file('frontend/apps/ops/src/ops-entity-workspace-source.ts').text(),
    ]);
    expect(legacyModel).toContain('projectEntityWorkspaceContext({ runtimeId: getRuntimeId(sourceEnv), frame })');
    expect(reactShell).toContain('context.status === \'selected\'');
    expect(reactPage).toContain('context={snapshot.context}');
    expect(reactSource).toContain('projectEntityWorkspaceContext({');
    expect(legacyModel).not.toContain('as unknown as');
  });
});

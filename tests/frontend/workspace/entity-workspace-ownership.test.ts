import { describe, expect, test } from 'bun:test';

import {
  emptyEntityWorkspaceOwnership,
  projectEntityWorkspaceOwnership,
} from '../../../frontend/packages/runtime-client/src/entity-workspace-ownership';
import {
  projectEntityWorkspaceContext,
} from '../../../frontend/packages/runtime-client/src/entity-workspace-context';

const FRAME = {
  height: 42,
  activeEntityId: '0xAABB',
  activeEntity: {
    summary: { entityId: '0xaabb', label: 'Treasury' },
    core: {
      entityId: '0xaabb',
      signerId: '0xBBBB',
      config: {
        mode: 'proposer-based',
        threshold: 3n,
        validators: ['0xAAAA', '0xBBBB'],
        shares: { '0xaaaa': 2n, '0xbbbb': 2n },
      },
    },
    accounts: { items: [], totalItems: 0 },
  },
};

const CONTEXT = projectEntityWorkspaceContext({ runtimeId: 'runtime-a', frame: FRAME });

const projectConfig = (config: unknown) => projectEntityWorkspaceOwnership({
  context: CONTEXT,
  frame: {
    ...FRAME,
    activeEntity: {
      ...FRAME.activeEntity,
      core: { ...FRAME.activeEntity.core, config },
    },
  },
});

describe('Entity workspace ownership projection', () => {
  test('projects the committed board in validator order and marks the attached signer', () => {
    expect(projectEntityWorkspaceOwnership({ context: CONTEXT, frame: FRAME })).toEqual({
      status: 'selected',
      entityId: '0xaabb',
      mode: 'proposer-based',
      threshold: 3n,
      totalShares: 4n,
      attachedSignerId: '0xbbbb',
      members: [
        { signerId: '0xaaaa', shares: 2n, isAttachedSigner: false },
        { signerId: '0xbbbb', shares: 2n, isAttachedSigner: true },
      ],
    });
  });

  test('keeps an Entity-empty Runtime explicitly empty', () => {
    const context = projectEntityWorkspaceContext({ runtimeId: 'runtime-a', frame: { height: 9, activeEntity: null } });
    expect(projectEntityWorkspaceOwnership({ context, frame: { height: 9, activeEntity: null } }))
      .toEqual(emptyEntityWorkspaceOwnership());
  });

  test('fails loudly on malformed board shape and power', () => {
    expect(() => projectConfig({ ...FRAME.activeEntity.core.config, mode: 'solo' }))
      .toThrow('ENTITY_WORKSPACE_OWNERSHIP_MODE_INVALID');
    expect(() => projectConfig({ ...FRAME.activeEntity.core.config, threshold: 0n }))
      .toThrow('ENTITY_WORKSPACE_OWNERSHIP_THRESHOLD_INVALID');
    expect(() => projectConfig({ ...FRAME.activeEntity.core.config, validators: [] }))
      .toThrow('ENTITY_WORKSPACE_OWNERSHIP_VALIDATORS_INVALID');
    expect(() => projectConfig({
      ...FRAME.activeEntity.core.config,
      validators: ['0xAAAA', '0xaaaa'],
    })).toThrow('ENTITY_WORKSPACE_OWNERSHIP_VALIDATORS_DUPLICATE');
    expect(() => projectConfig({
      ...FRAME.activeEntity.core.config,
      shares: { '0xaaaa': 2n, '0xbbbb': -1n },
    })).toThrow('ENTITY_WORKSPACE_OWNERSHIP_SHARE_POWER_INVALID');
  });

  test('rejects missing, foreign, duplicated, or insufficient share authority', () => {
    expect(() => projectConfig({
      ...FRAME.activeEntity.core.config,
      shares: { '0xaaaa': 2n },
    })).toThrow('ENTITY_WORKSPACE_OWNERSHIP_SHARES_MISMATCH');
    expect(() => projectConfig({
      ...FRAME.activeEntity.core.config,
      shares: { '0xaaaa': 2n, '0xbbbb': 2n, '0xcccc': 1n },
    })).toThrow('ENTITY_WORKSPACE_OWNERSHIP_SHARES_MISMATCH');
    expect(() => projectConfig({
      ...FRAME.activeEntity.core.config,
      shares: { '0xaaaa': 2n, '0xAAAA': 2n, '0xbbbb': 2n },
    })).toThrow('ENTITY_WORKSPACE_OWNERSHIP_SHARES_DUPLICATE');
    expect(() => projectConfig({
      ...FRAME.activeEntity.core.config,
      threshold: 5n,
    })).toThrow('ENTITY_WORKSPACE_OWNERSHIP_THRESHOLD_UNREACHABLE');
  });

  test('rejects a board belonging to a different active Entity', () => {
    expect(() => projectEntityWorkspaceOwnership({
      context: CONTEXT,
      frame: {
        ...FRAME,
        activeEntity: {
          ...FRAME.activeEntity,
          core: { ...FRAME.activeEntity.core, entityId: '0xffff' },
        },
      },
    })).toThrow('ENTITY_WORKSPACE_OWNERSHIP_ENTITY_ID_MISMATCH');
  });
});

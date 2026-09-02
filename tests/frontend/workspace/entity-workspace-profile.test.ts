import { describe, expect, test } from 'bun:test';

import {
  emptyEntityWorkspaceProfile,
  projectEntityWorkspaceProfile,
} from '../../../frontend/packages/runtime-client/src/entity-workspace-profile';
import {
  projectEntityWorkspaceContext,
} from '../../../frontend/packages/runtime-client/src/entity-workspace-context';

const profile = (overrides: Record<string, unknown> = {}) => ({
  name: '  Treasury Node  ',
  isHub: true,
  entityKind: 'company',
  sectors: ['finance', 'technology'],
  avatar: ' ipfs://avatar ',
  bio: ' Settlement infrastructure ',
  website: ' https://xln.example ',
  ...overrides,
});

const frameWithProfile = (value: unknown, entityId = '0xaaaa') => ({
  height: 27,
  activeEntityId: '0xaaaa',
  activeEntity: {
    summary: { entityId: '0xaaaa', label: 'Treasury' },
    core: { entityId, profile: value },
    accounts: { items: [], totalItems: 0 },
  },
});

const FRAME = frameWithProfile(profile());
const CONTEXT = projectEntityWorkspaceContext({ runtimeId: 'runtime-a', frame: FRAME });

describe('Entity workspace committed profile projection', () => {
  test('projects only the public Entity profile and preserves sector order', () => {
    expect(projectEntityWorkspaceProfile({ context: CONTEXT, frame: FRAME })).toEqual({
      status: 'selected',
      entityId: '0xaaaa',
      name: 'Treasury Node',
      isHub: true,
      entityKind: 'company',
      sectors: ['finance', 'technology'],
      avatar: 'ipfs://avatar',
      bio: 'Settlement infrastructure',
      website: 'https://xln.example',
    });
  });

  test('keeps optional classification empty without inventing profile values', () => {
    const frame = frameWithProfile(profile({ entityKind: undefined, sectors: undefined }));
    expect(projectEntityWorkspaceProfile({ context: CONTEXT, frame })).toMatchObject({
      entityKind: null,
      sectors: [],
    });
  });

  test('represents an Entity-empty Runtime without inventing a profile', () => {
    const context = projectEntityWorkspaceContext({ runtimeId: 'runtime-a', frame: { height: 2, activeEntity: null } });
    expect(projectEntityWorkspaceProfile({ context, frame: { height: 2, activeEntity: null } }))
      .toEqual(emptyEntityWorkspaceProfile());
  });

  test('rejects mismatched identity and malformed required fields', () => {
    expect(() => projectEntityWorkspaceProfile({
      context: CONTEXT,
      frame: frameWithProfile(profile(), '0xbbbb'),
    })).toThrow('ENTITY_WORKSPACE_PROFILE_ENTITY_ID_MISMATCH');
    expect(() => projectEntityWorkspaceProfile({
      context: CONTEXT,
      frame: frameWithProfile(profile({ name: ' ' })),
    })).toThrow('ENTITY_WORKSPACE_PROFILE_NAME_INVALID');
    expect(() => projectEntityWorkspaceProfile({
      context: CONTEXT,
      frame: frameWithProfile(profile({ isHub: 'yes' })),
    })).toThrow('ENTITY_WORKSPACE_PROFILE_ROLE_INVALID');
    expect(() => projectEntityWorkspaceProfile({
      context: CONTEXT,
      frame: frameWithProfile(profile({ website: null })),
    })).toThrow('ENTITY_WORKSPACE_PROFILE_WEBSITE_INVALID');
  });

  test('rejects malformed or duplicate sector lists', () => {
    expect(() => projectEntityWorkspaceProfile({
      context: CONTEXT,
      frame: frameWithProfile(profile({ sectors: ['finance', 'finance'] })),
    })).toThrow('ENTITY_WORKSPACE_PROFILE_SECTORS_DUPLICATE');
    expect(() => projectEntityWorkspaceProfile({
      context: CONTEXT,
      frame: frameWithProfile(profile({ sectors: ['a', 'b', 'c', 'd', 'e'] })),
    })).toThrow('ENTITY_WORKSPACE_PROFILE_SECTORS_INVALID');
    expect(() => projectEntityWorkspaceProfile({
      context: CONTEXT,
      frame: frameWithProfile(profile({ sectors: ['finance', ' '] })),
    })).toThrow('ENTITY_WORKSPACE_PROFILE_SECTOR_INVALID');
  });
});

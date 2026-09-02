import {
  requireBoolean,
  requireUnknownRecord,
} from './boundary';
import type { EntityWorkspaceContext } from './entity-workspace-context';

type EmptyEntityWorkspaceProfile = Readonly<{
  status: 'empty';
}>;

type SelectedEntityWorkspaceProfile = Readonly<{
  status: 'selected';
  entityId: string;
  name: string;
  isHub: boolean;
  entityKind: string | null;
  sectors: readonly string[];
  avatar: string;
  bio: string;
  website: string;
}>;

export type EntityWorkspaceProfile =
  | EmptyEntityWorkspaceProfile
  | SelectedEntityWorkspaceProfile;

export type EntityWorkspaceProfileInput = Readonly<{
  context: EntityWorkspaceContext;
  frame?: unknown;
}>;

export const emptyEntityWorkspaceProfile = (): EmptyEntityWorkspaceProfile => ({ status: 'empty' });

const requiredText = (value: unknown, code: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(code);
  return value.trim();
};

const requiredString = (value: unknown, code: string): string => {
  if (typeof value !== 'string') throw new Error(code);
  return value.trim();
};

const optionalText = (value: unknown, code: string): string | null => {
  if (value === undefined) return null;
  return requiredText(value, code);
};

const profileSectors = (value: unknown): readonly string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 4) {
    throw new Error('ENTITY_WORKSPACE_PROFILE_SECTORS_INVALID');
  }
  const sectors = value.map((sector) =>
    requiredText(sector, 'ENTITY_WORKSPACE_PROFILE_SECTOR_INVALID'));
  if (new Set(sectors).size !== sectors.length) {
    throw new Error('ENTITY_WORKSPACE_PROFILE_SECTORS_DUPLICATE');
  }
  return sectors;
};

export function projectEntityWorkspaceProfile(
  input: EntityWorkspaceProfileInput,
): EntityWorkspaceProfile {
  if (input.context.status === 'empty') return emptyEntityWorkspaceProfile();
  const frame = requireUnknownRecord(input.frame, 'ENTITY_WORKSPACE_PROFILE_FRAME_INVALID');
  const active = requireUnknownRecord(frame['activeEntity'], 'ENTITY_WORKSPACE_PROFILE_ACTIVE_ENTITY_INVALID');
  const core = requireUnknownRecord(active['core'], 'ENTITY_WORKSPACE_PROFILE_CORE_INVALID');
  const entityId = requiredText(core['entityId'], 'ENTITY_WORKSPACE_PROFILE_ENTITY_ID_INVALID').toLowerCase();
  if (entityId !== input.context.entityId) throw new Error('ENTITY_WORKSPACE_PROFILE_ENTITY_ID_MISMATCH');
  const profile = requireUnknownRecord(core['profile'], 'ENTITY_WORKSPACE_PROFILE_INVALID');
  return {
    status: 'selected',
    entityId,
    name: requiredText(profile['name'], 'ENTITY_WORKSPACE_PROFILE_NAME_INVALID'),
    isHub: requireBoolean(profile['isHub'], 'ENTITY_WORKSPACE_PROFILE_ROLE_INVALID'),
    entityKind: optionalText(profile['entityKind'], 'ENTITY_WORKSPACE_PROFILE_KIND_INVALID'),
    sectors: profileSectors(profile['sectors']),
    avatar: requiredString(profile['avatar'], 'ENTITY_WORKSPACE_PROFILE_AVATAR_INVALID'),
    bio: requiredString(profile['bio'], 'ENTITY_WORKSPACE_PROFILE_BIO_INVALID'),
    website: requiredString(profile['website'], 'ENTITY_WORKSPACE_PROFILE_WEBSITE_INVALID'),
  };
}

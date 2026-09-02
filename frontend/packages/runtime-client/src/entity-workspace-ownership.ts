import {
  requireUnknownRecord,
} from './boundary';
import type { EntityWorkspaceContext } from './entity-workspace-context';

export type EntityWorkspaceBoardMode = 'proposer-based' | 'gossip-based';

export type EntityWorkspaceBoardMember = Readonly<{
  signerId: string;
  shares: bigint;
  isAttachedSigner: boolean;
}>;

type EmptyEntityWorkspaceOwnership = Readonly<{
  status: 'empty';
}>;

type SelectedEntityWorkspaceOwnership = Readonly<{
  status: 'selected';
  entityId: string;
  mode: EntityWorkspaceBoardMode;
  threshold: bigint;
  totalShares: bigint;
  members: readonly EntityWorkspaceBoardMember[];
  attachedSignerId: string | null;
}>;

export type EntityWorkspaceOwnership =
  | EmptyEntityWorkspaceOwnership
  | SelectedEntityWorkspaceOwnership;

export type EntityWorkspaceOwnershipInput = Readonly<{
  context: EntityWorkspaceContext;
  frame?: unknown;
}>;

export const emptyEntityWorkspaceOwnership = (): EmptyEntityWorkspaceOwnership => ({ status: 'empty' });

const normalizeRequiredSigner = (value: unknown, code: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(code);
  return value.trim().toLowerCase();
};

const requireMode = (value: unknown): EntityWorkspaceBoardMode => {
  if (value !== 'proposer-based' && value !== 'gossip-based') {
    throw new Error('ENTITY_WORKSPACE_OWNERSHIP_MODE_INVALID');
  }
  return value;
};

const requireBoardPower = (value: unknown, code: string): bigint => {
  if (typeof value !== 'bigint' || value <= 0n || value > 0xffffn) throw new Error(code);
  return value;
};

const readValidators = (value: unknown): readonly string[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('ENTITY_WORKSPACE_OWNERSHIP_VALIDATORS_INVALID');
  }
  const validators = value.map((signer) =>
    normalizeRequiredSigner(signer, 'ENTITY_WORKSPACE_OWNERSHIP_VALIDATOR_INVALID'));
  if (new Set(validators).size !== validators.length) {
    throw new Error('ENTITY_WORKSPACE_OWNERSHIP_VALIDATORS_DUPLICATE');
  }
  return validators;
};

const normalizedShareEntries = (value: unknown): ReadonlyMap<string, bigint> => {
  const shares = requireUnknownRecord(value, 'ENTITY_WORKSPACE_OWNERSHIP_SHARES_INVALID');
  const normalized = new Map<string, bigint>();
  for (const [rawSigner, rawPower] of Object.entries(shares)) {
    const signer = normalizeRequiredSigner(rawSigner, 'ENTITY_WORKSPACE_OWNERSHIP_SHARE_SIGNER_INVALID');
    if (normalized.has(signer)) throw new Error('ENTITY_WORKSPACE_OWNERSHIP_SHARES_DUPLICATE');
    normalized.set(signer, requireBoardPower(rawPower, 'ENTITY_WORKSPACE_OWNERSHIP_SHARE_POWER_INVALID'));
  }
  return normalized;
};

const readMembers = (
  config: Record<string, unknown>,
  attachedSignerId: string | null,
): Readonly<{ members: readonly EntityWorkspaceBoardMember[]; totalShares: bigint }> => {
  const validators = readValidators(config['validators']);
  const shares = normalizedShareEntries(config['shares']);
  if (shares.size !== validators.length || [...shares.keys()].some((signer) => !validators.includes(signer))) {
    throw new Error('ENTITY_WORKSPACE_OWNERSHIP_SHARES_MISMATCH');
  }
  const members = validators.map((signerId) => {
    const power = shares.get(signerId);
    if (power === undefined) throw new Error('ENTITY_WORKSPACE_OWNERSHIP_SHARES_MISMATCH');
    return { signerId, shares: power, isAttachedSigner: signerId === attachedSignerId };
  });
  return {
    members,
    totalShares: members.reduce((total, member) => total + member.shares, 0n),
  };
};

export function projectEntityWorkspaceOwnership(
  input: EntityWorkspaceOwnershipInput,
): EntityWorkspaceOwnership {
  if (input.context.status === 'empty') return emptyEntityWorkspaceOwnership();
  const frame = requireUnknownRecord(input.frame, 'ENTITY_WORKSPACE_OWNERSHIP_FRAME_INVALID');
  const active = requireUnknownRecord(frame['activeEntity'], 'ENTITY_WORKSPACE_OWNERSHIP_ACTIVE_ENTITY_INVALID');
  const core = requireUnknownRecord(active['core'], 'ENTITY_WORKSPACE_OWNERSHIP_CORE_INVALID');
  const entityId = normalizeRequiredSigner(core['entityId'], 'ENTITY_WORKSPACE_OWNERSHIP_ENTITY_ID_INVALID');
  if (entityId !== input.context.entityId) throw new Error('ENTITY_WORKSPACE_OWNERSHIP_ENTITY_ID_MISMATCH');
  const config = requireUnknownRecord(core['config'], 'ENTITY_WORKSPACE_OWNERSHIP_CONFIG_INVALID');
  const threshold = requireBoardPower(config['threshold'], 'ENTITY_WORKSPACE_OWNERSHIP_THRESHOLD_INVALID');
  const { members, totalShares } = readMembers(config, input.context.signerId);
  if (threshold > totalShares) throw new Error('ENTITY_WORKSPACE_OWNERSHIP_THRESHOLD_UNREACHABLE');
  return {
    status: 'selected',
    entityId,
    mode: requireMode(config['mode']),
    threshold,
    totalShares,
    members,
    attachedSignerId: input.context.signerId,
  };
}

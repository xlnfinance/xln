import type {
  EntityReplica,
  Profile,
  XLNModule,
} from '@xln/core/api/public/runtime-module';
import type { AccountRoleEvidence } from '@xln/core/account/config/dispute-config';
import type { SameJurisdictionSwapCommandPlan } from '@xln/core/runtime/swap-cmd/swap-command-plan';
import type { SwapPanelRuntimeView } from '../swap-panel-helpers';

type SameJSwapRuntimeFunctions = Pick<
  XLNModule,
  'deriveSwapNetAuthorization' | 'planSwapCommand'
>;

export const resolveSameJSwapPartyRoles = (input: Readonly<{
  sourceEntityId: string;
  hubEntityId: string;
  hubProfile: Profile | null;
  committedRoles: ReadonlyMap<string, boolean>;
  label: 'SOURCE' | 'TARGET';
}>): Readonly<{
  entityRoleEvidence: AccountRoleEvidence;
  hubRoleEvidence: AccountRoleEvidence;
}> => {
  const entityId = String(input.sourceEntityId || '').trim().toLowerCase();
  const hubEntityId = String(input.hubEntityId || '').trim().toLowerCase();
  const entityIsHub = input.committedRoles.get(entityId);
  const hubIsHub = input.hubProfile?.metadata?.isHub;
  if (!entityId || !hubEntityId || typeof entityIsHub !== 'boolean' || hubIsHub !== true) {
    throw new Error(`SWAP_${input.label}_PARTY_ROLE_UNAVAILABLE:${entityId}:${hubEntityId}`);
  }
  return {
    entityRoleEvidence: { entityId, isHub: entityIsHub, source: 'committed-profile' },
    hubRoleEvidence: {
      entityId: hubEntityId,
      isHub: true,
      source: input.committedRoles.get(hubEntityId) === true
        ? 'committed-profile'
        : 'verified-gossip-profile',
    },
  };
};

export type SameJSwapCommandInput = Readonly<{
  committedSourceReplica: EntityReplica;
  runtimeView: Pick<SwapPanelRuntimeView, 'committedRoles'>;
  source: Readonly<{
    entityId: string;
    signerId: string;
    jurisdiction: string;
  }>;
  hub: Readonly<{
    entityId: string;
    signerId: string;
    profile: Profile | null;
  }>;
  roles: Readonly<{
    entityRoleEvidence: AccountRoleEvidence;
    hubRoleEvidence: AccountRoleEvidence;
  }>;
  tokens: Readonly<{
    giveTokenId: number;
    giveTokenDecimals: number;
    wantTokenId: number;
    wantTokenDecimals: number;
  }>;
  giveAmount: bigint;
  priceTicks: bigint;
  routeValue: string;
  expectedWantAmount: bigint;
  logicalClock: Readonly<{
    logicalTimestamp: number;
    logicalHeight: number;
  }>;
  runtimeFunctions: SameJSwapRuntimeFunctions;
}>;

const requireNetAuthorization = (input: SameJSwapCommandInput) => {
  const derive = input.runtimeFunctions.deriveSwapNetAuthorization;
  const feeBps = input.hub.profile?.metadata?.swapTakerFeeBps;
  if (!derive || !Number.isSafeInteger(feeBps)) throw new Error('SWAP_FEE_POLICY_UNAVAILABLE');
  return derive(input.expectedWantAmount, Number(feeBps));
};

export const planSameJSwapCommand = (
  input: SameJSwapCommandInput,
): SameJurisdictionSwapCommandPlan => {
  const plan = input.runtimeFunctions.planSwapCommand({
    mode: 'same',
    ...input.logicalClock,
    routeValue: input.routeValue,
    ...input.tokens,
    giveAmount: input.giveAmount,
    priceTicks: input.priceTicks,
    ...requireNetAuthorization(input),
    source: {
      entityId: input.source.entityId,
      signerId: input.source.signerId,
      hubEntityId: input.hub.entityId,
      hubSignerId: input.hub.signerId,
      jurisdiction: input.source.jurisdiction,
      ...input.roles,
      committedRoles: input.runtimeView.committedRoles,
      account: input.committedSourceReplica.state.accounts.get(input.hub.entityId)?.state ?? null,
    },
    expiresInMs: 24 * 60 * 60 * 1_000,
  });
  if (plan.mode !== 'same') throw new Error('SWAP_COMMAND_SAME_J_PLAN_INVALID');
  return plan;
};

import type { RuntimeInput } from '../runtime-types';
import { fetchHubs, type HubApiRow } from '../api';
import type { CliSession } from '../session';
import { submitAndWait } from '../session';
import { findAccount } from '../accounts';
import { paint } from '../theme';
import { shortId } from '../format';
import { defaultAccountDisputeConfigForRoleEvidence, type AccountRoleEvidence } from '../../../runtime/account/config/dispute-config';
import { resolveCliHubPartyRoles } from '../account-role-evidence';
import { ensureCliProfiles } from '../profile-barrier';

export const buildOpenHubAccountInput = (input: {
  sourceEntityId: string;
  signerId: string;
  hubEntityId: string;
  creditAmount: bigint;
  tokenId?: number;
  sourceRoleEvidence: AccountRoleEvidence;
  hubRoleEvidence: AccountRoleEvidence;
  committedRoles: ReadonlyMap<string, boolean>;
}): RuntimeInput => {
  const sourceEntityId = input.sourceEntityId.toLowerCase();
  const hubEntityId = input.hubEntityId.toLowerCase();
  const signerId = input.signerId.trim();
  const tokenId = Math.max(1, Math.floor(Number(input.tokenId ?? 1)));
  if (!sourceEntityId || !hubEntityId || !signerId) throw new Error('openAccount requires entity/signer/hub');
  if (sourceEntityId === hubEntityId) throw new Error('Cannot open account with self');
  if (input.creditAmount <= 0n) throw new Error('creditAmount must be positive');
  return {
    runtimeTxs: [],
    entityInputs: [
      {
        entityId: sourceEntityId,
        signerId,
        entityTxs: [
          {
            type: 'openAccount',
            data: {
              targetEntityId: hubEntityId,
              disputeConfig: defaultAccountDisputeConfigForRoleEvidence(
                input.sourceRoleEvidence,
                input.hubRoleEvidence,
                input.committedRoles,
              ),
              creditAmount: input.creditAmount,
              tokenId,
            },
          },
        ],
      },
    ],
  };
};

export const listDiscoverableHubs = async (session: CliSession): Promise<HubApiRow[]> => {
  const remote = await fetchHubs(session.settings).catch(() => [] as HubApiRow[]);
  const local: HubApiRow[] = [];
  for (const profile of session.env.gossip?.getHubs?.() || []) {
    local.push({
      entityId: String(profile.entityId),
      runtimeId: profile.runtimeId || null,
      name: profile.name,
      metadata: profile.metadata,
      lastUpdated: profile.lastUpdated,
      online: true,
    });
  }
  const byId = new Map<string, HubApiRow>();
  for (const hub of [...local, ...remote]) {
    const id = String(hub.entityId || '').toLowerCase();
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, hub);
  }
  return [...byId.values()].sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
};

export const formatHubList = (hubs: HubApiRow[], session: CliSession): string => {
  if (hubs.length === 0) return paint('muted', 'No hubs discovered. Check XLN_API_BASE / network.');
  return hubs
    .map((hub, i) => {
      const id = String(hub.entityId).toLowerCase();
      const connected = Boolean(findAccount(session.env, session.entityId, id));
      const flag = connected ? paint('ok', 'connected') : paint('muted', 'available');
      const online = hub.online ? paint('ok', 'online') : paint('muted', 'offline');
      return `${String(i + 1).padStart(2)}  ${String(hub.name || 'hub').padEnd(20)} ${shortId(id, 10, 6)}  ${flag}  ${online}`;
    })
    .join('\n');
};

export const openHubAccount = async (
  session: CliSession,
  hubEntityId: string,
  creditAmount: bigint,
  tokenId = 1,
): Promise<number> => {
  const publicHubs = await fetchHubs(session.settings);
  const publicHub = publicHubs.find(hub => String(hub.entityId).toLowerCase() === hubEntityId.toLowerCase());
  const partyRoles = resolveCliHubPartyRoles(session, hubEntityId, publicHub);
  await ensureCliProfiles(session, [hubEntityId], 'CLI_OPEN_ACCOUNT');
  const input = buildOpenHubAccountInput({
    sourceEntityId: session.entityId,
    signerId: session.signerId,
    hubEntityId,
    creditAmount,
    tokenId,
    sourceRoleEvidence: partyRoles.entityRoleEvidence,
    hubRoleEvidence: partyRoles.hubRoleEvidence,
    committedRoles: partyRoles.committedRoles,
  });
  return submitAndWait(
    session.env,
    input,
    () => Boolean(findAccount(session.env, session.entityId, hubEntityId)),
    `openAccount(${hubEntityId.slice(0, 12)})`,
    60_000,
  );
};

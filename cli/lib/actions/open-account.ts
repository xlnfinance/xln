import type { RuntimeInput } from '../runtime-types';
import { fetchHubs, type HubApiRow } from '../api';
import type { CliSession } from '../session';
import { submitAndWait } from '../session';
import { findAccount } from '../accounts';
import { paint } from '../theme';
import { shortId } from '../format';

export const buildOpenHubAccountInput = (input: {
  sourceEntityId: string;
  signerId: string;
  hubEntityId: string;
  creditAmount: bigint;
  tokenId?: number;
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
              creditAmount: input.creditAmount,
              tokenId,
            },
          },
        ],
      },
    ],
  };
};

export const buildDirectOpenAccountInput = (input: {
  sourceEntityId: string;
  signerId: string;
  targetEntityId: string;
}): RuntimeInput => ({
  runtimeTxs: [],
  entityInputs: [
    {
      entityId: input.sourceEntityId.toLowerCase(),
      signerId: input.signerId,
      entityTxs: [
        {
          type: 'openAccount',
          data: { targetEntityId: input.targetEntityId.toLowerCase() },
        },
      ],
    },
  ],
});

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
): Promise<void> => {
  const input = buildOpenHubAccountInput({
    sourceEntityId: session.entityId,
    signerId: session.signerId,
    hubEntityId,
    creditAmount,
    tokenId,
  });
  await submitAndWait(
    session.env,
    input,
    () => Boolean(findAccount(session.env, session.entityId, hubEntityId)),
    `openAccount(${hubEntityId.slice(0, 12)})`,
    60_000,
  );
};

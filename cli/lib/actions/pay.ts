import { buildPaymentRuntimeInput } from '../../../core/api/payments/command';
import type { CliSession } from '../session';
import { submitQueued } from '../session';
import { findAccount } from '../accounts';
import { ensureCliProfiles } from '../profile-barrier';
import { quoteHtlcPaymentRoute } from '../../../core/runtime.ts';

export type DeliveryMode = 'direct' | 'trusted' | 'instant' | 'async';

/** Resolve a simple route: direct bilateral, else via a single known hub counterparty. */
export const resolveSimpleRoute = (
  session: CliSession,
  targetEntityId: string,
  hubEntityId?: string,
): string[] => {
  const self = session.entityId.toLowerCase();
  const target = targetEntityId.toLowerCase();
  if (findAccount(session.env, self, target)) return [self, target];
  if (hubEntityId) {
    const hub = hubEntityId.toLowerCase();
    if (!findAccount(session.env, self, hub)) {
      throw new Error(`No account with hub ${hub}. Run: xln open ${hub}`);
    }
    return [self, hub, target];
  }
  // Prefer first connected account as gateway when paying a non-direct peer.
  const replica = [...session.env.state.eReplicas.values()].find(
    r => String(r.state?.entityId || '').toLowerCase() === self,
  );
  const accounts = replica?.state?.accounts;
  if (accounts && typeof accounts.keys === 'function') {
    for (const counterparty of accounts.keys()) {
      const hub = String(counterparty).toLowerCase();
      if (hub && hub !== target) return [self, hub, target];
    }
  }
  throw new Error(`No route to ${target}. Open a hub account or pass --hub.`);
};

export const ensureCliPaymentProfiles = async (
  session: CliSession,
  route: readonly string[],
): Promise<void> => ensureCliProfiles(session, route.slice(1), 'CLI_PAYMENT');

export const sendPayment = async (
  session: CliSession,
  args: {
    to: string;
    amount: bigint;
    tokenId: number;
    mode: DeliveryMode;
    hub?: string;
    description?: string;
  },
): Promise<number> => {
  const route = resolveSimpleRoute(session, args.to, args.hub);
  const usesHtlc = args.mode === 'instant' || args.mode === 'async';
  if (usesHtlc) await ensureCliPaymentProfiles(session, route);
  const senderDebit = usesHtlc
    ? quoteHtlcPaymentRoute(session.env.gossip.getProfiles(), route, args.tokenId, args.amount).senderLockAmount
    : args.amount;
  const input = buildPaymentRuntimeInput({
    entityId: session.entityId,
    signerId: session.signerId,
    targetEntityId: args.to,
    tokenId: args.tokenId,
    route: { path: route, recipientAmount: args.amount, senderAmount: senderDebit, totalFee: senderDebit - args.amount },
    deliveryMode: args.mode,
    description: args.description ?? '',
  });
  return submitQueued(session.env, input, 'payment', 30_000);
};

export const buildReceiveInvoice = (session: CliSession): string => {
  const entityId = session.entityId;
  const encoded = encodeURIComponent(entityId);
  const lines = [
    `entity: ${entityId}`,
    `xln://pay/${entityId}`,
    `${session.settings.apiBase.replace(/\/$/, '')}/app#pay/${encoded}`,
  ];
  return lines.join('\n');
};

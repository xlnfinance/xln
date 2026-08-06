import type { RuntimeInput } from '../runtime-types';
import type { CliSession } from '../session';
import { submitAndWait } from '../session';
import { findAccount } from '../accounts';

export type DeliveryMode = 'direct' | 'trusted' | 'instant' | 'async';

export const buildPaymentInput = (input: {
  entityId: string;
  signerId: string;
  targetEntityId: string;
  amount: bigint;
  tokenId: number;
  route: string[];
  deliveryMode: DeliveryMode;
  description?: string;
}): RuntimeInput => {
  const targetEntityId = input.targetEntityId.toLowerCase();
  const route = input.route.map(id => id.toLowerCase());
  const usesDirect = input.deliveryMode === 'direct' || input.deliveryMode === 'trusted';
  if (input.amount <= 0n) throw new Error('Payment amount must be positive');
  if (route.length < 2) throw new Error('Route requires at least sender and recipient');
  if (input.deliveryMode === 'direct' && route.length !== 2) {
    throw new Error('Direct delivery requires a bilateral route');
  }
  const trustedGatewayEntityId =
    input.deliveryMode === 'trusted' && route.length === 3 ? route[1] : undefined;
  if (input.deliveryMode === 'trusted' && !trustedGatewayEntityId) {
    throw new Error('Trusted delivery requires exactly one gateway hop');
  }

  return {
    runtimeTxs: [],
    entityInputs: [
      {
        entityId: input.entityId.toLowerCase(),
        signerId: input.signerId,
        entityTxs: [
          usesDirect
            ? {
                type: 'directPayment',
                data: {
                  targetEntityId,
                  tokenId: input.tokenId,
                  amount: input.amount,
                  route,
                  deliveryMode: input.deliveryMode === 'trusted' ? 'trusted' : 'direct',
                  ...(trustedGatewayEntityId ? { trustedGatewayEntityId } : {}),
                  ...(input.description ? { description: input.description } : {}),
                },
              }
            : {
                type: 'htlcPayment',
                data: {
                  targetEntityId,
                  tokenId: input.tokenId,
                  amount: input.amount,
                  route,
                  deliveryMode: input.deliveryMode === 'instant' ? 'instant' : 'async',
                  ...(input.description ? { description: input.description } : {}),
                },
              },
        ],
      },
    ],
  };
};

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
): Promise<RuntimeInput> => {
  const route = resolveSimpleRoute(session, args.to, args.hub);
  const input = buildPaymentInput({
    entityId: session.entityId,
    signerId: session.signerId,
    targetEntityId: args.to,
    amount: args.amount,
    tokenId: args.tokenId,
    route,
    deliveryMode: args.mode,
    description: args.description,
  });
  await submitAndWait(session.env, input, () => true, 'payment', 30_000);
  return input;
};

export const buildReceiveInvoice = (session: CliSession): string => {
  const entityId = session.entityId;
  const lines = [
    `entity: ${entityId}`,
    `xln://pay?to=${entityId}`,
    `${session.settings.apiBase.replace(/\/$/, '')}/pay?to=${entityId}`,
  ];
  return lines.join('\n');
};

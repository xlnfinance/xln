import type { HtlcRoute } from '../../types/account';

type InboundHtlcRoute = HtlcRoute & Required<Pick<
  HtlcRoute,
  'inboundEntity' | 'inboundLockId'
>>;

type OutboundHtlcRoute = HtlcRoute & Required<Pick<
  HtlcRoute,
  'outboundEntity' | 'outboundLockId'
>>;

export type ForwardingHtlcRoute = InboundHtlcRoute & OutboundHtlcRoute;

export type FinalRecipientHtlcRoute = InboundHtlcRoute & {
  originated?: never;
  outboundEntity?: never;
  outboundLockId?: never;
};

export type SecretAckPendingHtlcRoute = InboundHtlcRoute & {
  secret: string;
  secretAckPending: true;
  secretAckStartedAt: number;
  secretAckDeadlineAt: number;
};

export type DisputeReadyHtlcRoute = SecretAckPendingHtlcRoute;

export type FailedForwardHtlcRouteSummary = Readonly<{
  hashlock: string;
  outboundAccountId: string;
  outboundLockId: string;
  inboundAccountId: string;
  inboundLockId: string;
}>;

const hasText = (value: string | undefined): value is string =>
  typeof value === 'string' && value.length > 0;

export const hasInboundHtlcRoute = (route: HtlcRoute): route is InboundHtlcRoute =>
  hasText(route.inboundEntity) && hasText(route.inboundLockId);

const hasOutboundHtlcRoute = (route: HtlcRoute): route is OutboundHtlcRoute =>
  hasText(route.outboundEntity) && hasText(route.outboundLockId);

export const isForwardingHtlcRoute = (
  route: HtlcRoute,
): route is ForwardingHtlcRoute => hasInboundHtlcRoute(route) && hasOutboundHtlcRoute(route);

export const isFinalRecipientHtlcRoute = (
  route: HtlcRoute,
): route is FinalRecipientHtlcRoute => hasInboundHtlcRoute(route)
  && route.originated !== true
  && route.outboundEntity === undefined
  && route.outboundLockId === undefined;

export const isSecretAckPendingHtlcRoute = (
  route: HtlcRoute,
): route is SecretAckPendingHtlcRoute => hasInboundHtlcRoute(route)
  && hasText(route.secret)
  && route.secretAckPending === true
  && Number.isSafeInteger(route.secretAckStartedAt)
  && Number.isSafeInteger(route.secretAckDeadlineAt)
  && route.secretAckDeadlineAt! >= route.secretAckStartedAt!;

export const isDisputeReadyHtlcRoute = (
  route: HtlcRoute,
  timestamp: number,
): route is DisputeReadyHtlcRoute => isSecretAckPendingHtlcRoute(route)
  && timestamp >= route.secretAckDeadlineAt;

/** Compact transitive route set one Account proposal worklist can reach. */
export const failedForwardHtlcRouteClosure = (
  routes: ReadonlyMap<string, HtlcRoute>,
  proposalAccountIds: readonly string[],
): FailedForwardHtlcRouteSummary[] => {
  const active = new Set(proposalAccountIds.map(value => value.toLowerCase()));
  const selected = new Map<string, FailedForwardHtlcRouteSummary>();
  const ordered = [...routes.entries()].toSorted(([left], [right]) => left.localeCompare(right));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [hashlock, route] of ordered) {
      if (!isForwardingHtlcRoute(route)) continue;
      const outboundAccountId = route.outboundEntity.toLowerCase();
      if (!active.has(outboundAccountId)) continue;
      const normalizedHashlock = hashlock.toLowerCase();
      if (!selected.has(normalizedHashlock)) {
        selected.set(normalizedHashlock, {
          hashlock: normalizedHashlock,
          outboundAccountId,
          outboundLockId: route.outboundLockId,
          inboundAccountId: route.inboundEntity.toLowerCase(),
          inboundLockId: route.inboundLockId,
        });
      }
      const inboundAccountId = route.inboundEntity.toLowerCase();
      if (!active.has(inboundAccountId)) {
        active.add(inboundAccountId);
        changed = true;
      }
    }
  }
  return [...selected.values()].toSorted((left, right) =>
    left.hashlock.localeCompare(right.hashlock));
};

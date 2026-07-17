import { FINANCIAL } from '../../constants';

type DirectPaymentRouteInput = Readonly<{
  sourceEntityId: string;
  targetEntityId: string;
  route: unknown;
}>;

const routeError = (code: string, detail: string): never => {
  throw new Error(`DIRECT_PAYMENT_${code}:${detail}`);
};

/** Consensus accepts only the exact route already committed by governance. */
export const requireCommittedDirectPaymentRoute = (
  input: DirectPaymentRouteInput,
): string[] => {
  if (!Array.isArray(input.route) || input.route.length === 0) {
    return routeError('ROUTE_REQUIRED', `target=${input.targetEntityId}`);
  }
  if (input.route.length > FINANCIAL.MAX_ROUTE_HOPS) {
    return routeError('ROUTE_TOO_LONG', `${input.route.length}:${FINANCIAL.MAX_ROUTE_HOPS}`);
  }
  const route = input.route.map((entityId, index) => {
    if (typeof entityId !== 'string' || entityId.length === 0) {
      return routeError('ROUTE_ENTRY_INVALID', String(index));
    }
    return entityId;
  });
  if (route[0] !== input.sourceEntityId) {
    return routeError(
      'ROUTE_START_INVALID',
      `entity=${input.sourceEntityId}:route0=${route[0] ?? ''}:target=${input.targetEntityId}`,
    );
  }
  if (route[route.length - 1] !== input.targetEntityId) {
    return routeError(
      'ROUTE_END_INVALID',
      `entity=${input.sourceEntityId}:last=${route[route.length - 1] ?? ''}:target=${input.targetEntityId}`,
    );
  }
  return route;
};

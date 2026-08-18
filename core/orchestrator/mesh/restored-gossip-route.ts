type RestoredRuntimeRoute = Readonly<{
  runtimeId?: string;
  wsUrl?: string | null;
  relays?: readonly string[];
}>;

type TrustedRuntimeRoute = Readonly<{
  runtimeId: string;
  wsUrl: string;
  relayUrls: readonly string[];
}>;

const normalizeRouteList = (routes: readonly string[] | undefined): string[] =>
  (routes ?? []).map(route => route.trim()).filter(Boolean).sort();

const sameRouteList = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((route, index) => route === right[index]);

export const restoredRuntimeRouteRelocated = (
  profiles: readonly RestoredRuntimeRoute[],
  trusted: TrustedRuntimeRoute,
): boolean => {
  const runtimeId = trusted.runtimeId.trim().toLowerCase();
  const wsUrl = trusted.wsUrl.trim();
  const relayUrls = normalizeRouteList(trusted.relayUrls);
  return profiles.some(profile =>
    String(profile.runtimeId ?? '').trim().toLowerCase() === runtimeId && (
      String(profile.wsUrl ?? '').trim() !== wsUrl ||
      !sameRouteList(normalizeRouteList(profile.relays), relayUrls)
    ));
};

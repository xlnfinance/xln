export type WalletSwapRouteOption = Readonly<{
  value: string;
  mode: 'same' | 'cross';
  label: string;
  enabled: boolean;
  disabledReason: string | null;
  sourceHubEntityId: string;
  sourceHubSignerId: string | null;
  targetEntityId: string | null;
  targetSignerId: string | null;
  targetHubEntityId: string | null;
  targetHubSignerId: string | null;
  sourceJurisdictionRef: string;
  targetJurisdictionRef: string | null;
}>;

type SwapRouteEntity = Readonly<{
  entityId: string;
  runtimeId: string;
  signerId: string | null;
  label: string;
  isHub: boolean;
  jurisdictionRef: string | null;
}>;

export const buildWalletSwapRouteOptions = (input: Readonly<{
  sourceEntityId: string;
  sourceRuntimeId: string;
  sourceJurisdictionRef: string | null;
  sourceAccountIds: readonly string[];
  directory: readonly SwapRouteEntity[];
}>): readonly WalletSwapRouteOption[] => {
  const sourceEntityId = input.sourceEntityId.trim().toLowerCase();
  const sourceRuntimeId = input.sourceRuntimeId.trim().toLowerCase();
  const sourceJurisdictionRef = String(input.sourceJurisdictionRef || '').trim().toLowerCase();
  if (!sourceEntityId) throw new Error('WALLET_SWAP_ROUTE_SOURCE_ENTITY_MISSING');
  if (!sourceRuntimeId) throw new Error('WALLET_SWAP_ROUTE_SOURCE_RUNTIME_MISSING');
  if (!sourceJurisdictionRef) throw new Error('WALLET_SWAP_ROUTE_SOURCE_JURISDICTION_MISSING');
  const directory = new Map(input.directory.map(entity => [entity.entityId.trim().toLowerCase(), entity] as const));
  const sourceHubs = [...new Set(input.sourceAccountIds.map(value => value.trim().toLowerCase()))]
    .map(accountId => directory.get(accountId))
    .filter((entity): entity is SwapRouteEntity => Boolean(entity?.isHub));
  const options: WalletSwapRouteOption[] = [];
  for (const hub of sourceHubs) {
    const hubSigner = hub.signerId?.trim().toLowerCase() || null;
    const sameJurisdiction = hub.jurisdictionRef?.trim().toLowerCase() === sourceJurisdictionRef;
    options.push(Object.freeze({
      value: `same:${sourceEntityId}:${hub.entityId}`,
      mode: 'same',
      label: `Same jurisdiction · ${hub.label}`,
      enabled: Boolean(hubSigner && sameJurisdiction),
      disabledReason: !sameJurisdiction ? 'Hub jurisdiction differs from source' : !hubSigner ? 'Hub signer unavailable' : null,
      sourceHubEntityId: hub.entityId,
      sourceHubSignerId: hubSigner,
      targetEntityId: null,
      targetSignerId: null,
      targetHubEntityId: null,
      targetHubSignerId: null,
      sourceJurisdictionRef,
      targetJurisdictionRef: null,
    }));
  }
  const targets = input.directory.filter(entity =>
    !entity.isHub &&
    entity.entityId !== sourceEntityId &&
    entity.runtimeId.trim().toLowerCase() === sourceRuntimeId &&
    Boolean(entity.jurisdictionRef) &&
    entity.jurisdictionRef!.trim().toLowerCase() !== sourceJurisdictionRef
  );
  for (const sourceHub of sourceHubs) {
    for (const target of targets) {
      const targetJurisdictionRef = target.jurisdictionRef!.trim().toLowerCase();
      const targetHubs = input.directory.filter(entity =>
        entity.isHub && entity.jurisdictionRef?.trim().toLowerCase() === targetJurisdictionRef
      );
      for (const targetHub of targetHubs) {
        const sourceHubSigner = sourceHub.signerId?.trim().toLowerCase() || null;
        const targetSigner = target.signerId?.trim().toLowerCase() || null;
        const targetHubSigner = targetHub.signerId?.trim().toLowerCase() || null;
        const enabled = Boolean(sourceHubSigner && targetSigner && targetHubSigner);
        options.push(Object.freeze({
          value: `cross:${sourceEntityId}:${sourceHub.entityId}:${target.entityId}:${targetHub.entityId}`,
          mode: 'cross',
          label: `Cross jurisdiction · ${sourceHub.label} → ${target.label} via ${targetHub.label}`,
          enabled,
          disabledReason: enabled ? null : 'Canonical signer evidence unavailable',
          sourceHubEntityId: sourceHub.entityId,
          sourceHubSignerId: sourceHubSigner,
          targetEntityId: target.entityId,
          targetSignerId: targetSigner,
          targetHubEntityId: targetHub.entityId,
          targetHubSignerId: targetHubSigner,
          sourceJurisdictionRef,
          targetJurisdictionRef,
        }));
      }
    }
  }
  return Object.freeze(options.toSorted((left, right) =>
    Number(right.enabled) - Number(left.enabled) || left.mode.localeCompare(right.mode) || left.value.localeCompare(right.value)
  ));
};

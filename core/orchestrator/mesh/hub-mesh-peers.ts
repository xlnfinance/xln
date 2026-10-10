import { requireBoundaryRecord, requireExactBoundaryKeys } from '../../protocol/boundary-validation';
import { getJurisdictionIdentityRef } from '../../jurisdiction/machine/jurisdiction-runtime';

/** An Entity the orchestrator configured as a peer, bound to its jurisdiction. */
export type ConfiguredPeerIdentity = {
  name: string;
  entityId: string;
  signerId: string;
  jurisdictionName: string;
  chainId?: number;
  depositoryAddress?: string;
  jurisdictionRef: string;
};

const parseConfiguredPeerIdentity = (rawEntry: unknown, index: number, code: string): ConfiguredPeerIdentity => {
  const entry = requireBoundaryRecord(rawEntry, `${code}_JSON_INVALID:index=${index}:expected object`);
  requireExactBoundaryKeys(
    entry,
    ['name', 'entityId', 'signerId', 'jurisdictionName'],
    ['chainId', 'depositoryAddress'],
    `${code}_JSON_FIELDS_INVALID:index=${index}`,
  );
  const rawChainId = entry['chainId'];
  const chainId = rawChainId === undefined
    ? null
    : (typeof rawChainId === 'number' && Number.isSafeInteger(rawChainId) && rawChainId > 0 ? rawChainId : null);
  if (rawChainId !== undefined && chainId === null) {
    throw new Error(`${code}_JSON_INVALID:index=${index}:chainId`);
  }
  const depositoryAddress = typeof entry['depositoryAddress'] === 'string' ? entry['depositoryAddress'].trim() : '';
  const identity: ConfiguredPeerIdentity = {
    name: typeof entry['name'] === 'string' ? entry['name'].trim() : '',
    entityId: typeof entry['entityId'] === 'string' ? entry['entityId'].trim().toLowerCase() : '',
    signerId: typeof entry['signerId'] === 'string' ? entry['signerId'].trim().toLowerCase() : '',
    jurisdictionName: typeof entry['jurisdictionName'] === 'string' ? entry['jurisdictionName'].trim() : '',
    ...(chainId !== null ? { chainId } : {}),
    ...(depositoryAddress ? { depositoryAddress } : {}),
    jurisdictionRef: getJurisdictionIdentityRef({ chainId, depositoryAddress }),
  };
  if (
    !identity.name ||
    !/^0x[0-9a-f]{64}$/.test(identity.entityId) ||
    !/^0x[0-9a-f]{40}$/.test(identity.signerId) ||
    !identity.jurisdictionName ||
    !identity.jurisdictionRef
  ) {
    throw new Error(`${code}_JSON_INVALID:index=${index}:invalid identity binding`);
  }
  return identity;
};

/** Parse an orchestrator-supplied identity list; `code` prefixes every rejection. */
export const parseConfiguredPeerIdentities = (raw: string, code: string): ConfiguredPeerIdentity[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${code}_JSON_INVALID:malformed JSON`, { cause: error });
  }
  if (!Array.isArray(parsed)) throw new Error(`${code}_JSON_INVALID:expected array`);
  return parsed.map((entry, index) => parseConfiguredPeerIdentity(entry, index, code));
};

export type HubMeshPeer<P> = { identity: ConfiguredPeerIdentity; meshIndex: number; profile: P };

export type HubMeshView<P> = {
  /** This hub's position in the configured mesh order; -1 when it is not configured. */
  ownerIndex: number;
  /** Every configured hub on the jurisdiction except this one, in mesh order. */
  configuredPeers: ConfiguredPeerIdentity[];
  /** Configured hubs, this one included, whose gossip profile is visible. */
  visibleHubs: ConfiguredPeerIdentity[];
  /** Configured peers bound to their visible gossip profile. */
  visiblePeers: HubMeshPeer<P>[];
  /** Every configured hub on the jurisdiction is visible. */
  gossipReady: boolean;
};

/**
 * Any Entity can set `isHub` on itself through its own setHubConfig, so gossip
 * only locates hubs. Mesh membership comes from the configured entityIds: an
 * unconfigured profile never becomes a peer or counts toward readiness,
 * whatever name it declares.
 */
export const bindHubMesh = <P extends { entityId: string }>(
  identities: readonly ConfiguredPeerIdentity[],
  jurisdiction: unknown,
  selfEntityId: string,
  visibleProfiles: readonly P[],
): HubMeshView<P> => {
  const jurisdictionRef = getJurisdictionIdentityRef(jurisdiction);
  const configured = jurisdictionRef
    ? identities.filter(identity => identity.jurisdictionRef === jurisdictionRef)
    : [];
  const self = selfEntityId.toLowerCase();
  const profiles = new Map(visibleProfiles.map(profile => [profile.entityId.toLowerCase(), profile] as const));
  const visiblePeers: HubMeshPeer<P>[] = [];
  configured.forEach((identity, meshIndex) => {
    const profile = profiles.get(identity.entityId);
    if (identity.entityId !== self && profile) visiblePeers.push({ identity, meshIndex, profile });
  });
  const visibleHubs = configured.filter(identity => profiles.has(identity.entityId));
  return {
    ownerIndex: configured.findIndex(identity => identity.entityId === self),
    configuredPeers: configured.filter(identity => identity.entityId !== self),
    visibleHubs,
    visiblePeers,
    gossipReady: configured.length > 0 && visibleHubs.length === configured.length,
  };
};

/** Ready only for a configured hub whose every configured pair is ready. */
export const hubMeshReady = (
  view: Pick<HubMeshView<unknown>, 'ownerIndex' | 'configuredPeers'>,
  pairs: readonly { counterpartyId: string; ready: boolean }[],
): boolean =>
  view.ownerIndex >= 0 &&
  view.configuredPeers.every(peer => pairs.some(pair => pair.counterpartyId === peer.entityId && pair.ready));

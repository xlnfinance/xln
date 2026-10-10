import { deriveSignerAddressSync } from '../../account/crypto';
import { DEFAULT_ACCOUNT_TOKEN_IDS } from '../../account/config/defaults';
import { getTokenIdsForJurisdiction } from '../../account/utils';
import {
  requireJurisdictionBlockTimeMs,
  resetMeshJurisdictionsCache,
  resolveMeshJurisdictionConfig,
  resolveSecondaryJurisdictions,
  type ResolvedMeshJurisdictionConfig,
} from '../mesh/mesh-jurisdictions';
import {
  deriveMarketMakerEntityId,
  planMarketMakerIdentityLabels,
  type MarketMakerEntityJurisdictionConfig,
} from '../mesh/mesh-common';
import { deriveManagedEntityIdentity } from '../daemon-control';
import type { Args, HubChild, MarketMakerChild } from '../orchestrator-types';

/** A managed Entity as passed to hub and MM children, which parse it back. */
export type ManagedPeerIdentity = {
  name: string;
  entityId: string;
  signerId: string;
  jurisdictionName: string;
  chainId: number;
  depositoryAddress: string;
};

type IdentityResolverDeps = {
  args: Pick<Args, 'host' | 'rpcUrl' | 'rpcUrls'>;
  marketMakerChild: Pick<MarketMakerChild, 'apiPort' | 'name' | 'seed' | 'signerLabel'>;
  hubChildren: readonly Pick<HubChild, 'name' | 'seed' | 'signerLabel'>[];
  requiredTokenCount: number;
};

export const createMarketMakerIdentityResolver = (deps: IdentityResolverDeps) => {
  const resolveLocalRpcUrl = (value: string): string => {
    const raw = String(value || '').trim();
    if (!raw.startsWith('/')) return raw;
    const match = raw.match(/^\/(?:api\/)?rpc([2-8])?(?:\?.*)?$/);
    if (match) {
      const index = match[1] ? Number(match[1]) : 1;
      const rpc = String(deps.args.rpcUrls[index] || '').trim();
      if (rpc) return rpc;
    }
    return new URL(raw, `http://${deps.args.host}:${deps.marketMakerChild.apiPort}`).toString();
  };

  const toJurisdictionConfig = (
    jurisdiction: ResolvedMeshJurisdictionConfig,
  ): MarketMakerEntityJurisdictionConfig => {
    if (!jurisdiction.contracts?.entityProvider || !jurisdiction.contracts?.depository) {
      throw new Error(`MARKET_MAKER_JURISDICTION_CONTRACTS_MISSING:${jurisdiction.name || 'unknown'}`);
    }
    return {
      name: jurisdiction.name,
      address: resolveLocalRpcUrl(jurisdiction.rpc),
      entityProviderAddress: jurisdiction.contracts.entityProvider,
      depositoryAddress: jurisdiction.contracts.depository,
      chainId: Number(jurisdiction.chainId || 0),
      blockTimeMs: requireJurisdictionBlockTimeMs(jurisdiction),
    };
  };

  const buildIdentity = (
    jurisdiction: ResolvedMeshJurisdictionConfig,
    signerLabel: string,
    name: string,
  ): ManagedPeerIdentity => {
    const signerId = deriveSignerAddressSync(deps.marketMakerChild.seed, signerLabel).toLowerCase();
    const entityId = deriveMarketMakerEntityId(signerId, toJurisdictionConfig(jurisdiction));
    return {
      name,
      entityId,
      signerId,
      jurisdictionName: jurisdiction.name,
      chainId: Number(jurisdiction.chainId || 0),
      depositoryAddress: jurisdiction.contracts.depository,
    };
  };

  const buildJurisdictionIdentities = (
    jurisdiction: ResolvedMeshJurisdictionConfig,
    signerLabel: string,
    name: string,
  ): ManagedPeerIdentity[] => {
    const configuredTokenIds = getTokenIdsForJurisdiction({
      name: jurisdiction.name,
      chainId: jurisdiction.chainId,
    });
    const tokenIds = configuredTokenIds.length >= deps.requiredTokenCount
      ? configuredTokenIds
      : [...DEFAULT_ACCOUNT_TOKEN_IDS];
    return planMarketMakerIdentityLabels(signerLabel, name, tokenIds).map(plan =>
      buildIdentity(jurisdiction, plan.signerLabel, plan.profileName));
  };

  const getMarketMakerIdentities = (): ManagedPeerIdentity[] => {
    resetMeshJurisdictionsCache();
    const primary = resolveMeshJurisdictionConfig(deps.args.rpcUrl);
    const identities = buildJurisdictionIdentities(
      primary,
      deps.marketMakerChild.signerLabel,
      deps.marketMakerChild.name,
    );
    for (const [index, secondary] of resolveSecondaryJurisdictions(primary.rpc).entries()) {
      const secondaryName = String(secondary.name || `Secondary ${index + 1}`).trim();
      if (!secondaryName) continue;
      identities.push(...buildJurisdictionIdentities(
        secondary,
        `${deps.marketMakerChild.signerLabel}:${secondaryName}`,
        `${deps.marketMakerChild.name} ${secondaryName}`,
      ));
    }
    return identities;
  };

  const buildHubIdentities = (
    jurisdiction: ResolvedMeshJurisdictionConfig,
    labelSuffix: string,
  ): ManagedPeerIdentity[] => deps.hubChildren.map(hub => {
    const identity = deriveManagedEntityIdentity({
      name: hub.name,
      seed: hub.seed,
      signerLabel: `${hub.signerLabel}${labelSuffix}`,
    });
    return {
      name: hub.name,
      entityId: identity.entityId,
      signerId: identity.signerId,
      jurisdictionName: jurisdiction.name,
      chainId: Number(jurisdiction.chainId || 0),
      depositoryAddress: jurisdiction.contracts.depository,
    };
  });

  // Every hub Entity per jurisdiction, in hub order. Hub-node signs a sibling
  // jurisdiction's Entity with `<label>:<jurisdiction name>`, and the board
  // hash does not cover the jurisdiction, so the seed alone fixes each id.
  const getHubIdentities = (): ManagedPeerIdentity[] => {
    resetMeshJurisdictionsCache();
    const primary = resolveMeshJurisdictionConfig(deps.args.rpcUrl);
    const identities = buildHubIdentities(primary, '');
    for (const [index, secondary] of resolveSecondaryJurisdictions(primary.rpc).entries()) {
      const secondaryName = String(secondary.name || `Secondary ${index + 1}`).trim();
      if (secondaryName) identities.push(...buildHubIdentities(secondary, `:${secondaryName}`));
    }
    return identities;
  };
  return {
    getMarketMakerIdentities,
    getHubIdentities,
    resolveLocalMarketMakerRpcUrl: resolveLocalRpcUrl,
  };
};

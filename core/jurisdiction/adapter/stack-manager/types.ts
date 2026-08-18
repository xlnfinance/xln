/**
 * Typed authority boundary for deploying one immutable V1 jurisdiction stack.
 * Private signer bytes exist only in the orchestration call and never in its
 * request, manifest, persistence record, logs, or publication result. [95/100]
 */

import type { JurisdictionGossipAnnouncement } from '../../gossip/announcement';

export const JURISDICTION_STACK_VERSION = 'V1' as const;

type StackPublicationScope = 'local' | 'community' | 'official';

type StablecoinDeployment =
  | Readonly<{ kind: 'existing'; address: string }>
  | Readonly<{ kind: 'test' }>;

export type DeployJurisdictionStackRequest = Readonly<{
  name: string;
  key: string;
  rpcUrl: string;
  expectedChainId: number;
  blockTimeMs: number;
  currency: string;
  explorer: string;
  description?: string;
  signerId: string;
  foundationRecipient: string;
  stablecoin: StablecoinDeployment;
  publication: StackPublicationScope;
  confirmations: number;
}>;

export type StackContractName =
  | 'account'
  | 'depositoryBounds'
  | 'hashLadderRegistry'
  | 'nftCustody'
  | 'hankoVerifier'
  | 'entityProvider'
  | 'depository'
  | 'deltaTransformer';

export type StackContractDeployment = Readonly<{
  address: string;
  deploymentBlock: number;
  transactionHash: string;
}>;

export type JurisdictionStackManifest = Readonly<{
  stackVersion: typeof JURISDICTION_STACK_VERSION;
  network: string;
  chainId: number;
  deployer: string;
  foundationRecipient: string;
  entityProviderDeploymentBlock: number;
  contracts: Readonly<Record<StackContractName, string>>;
  evmContracts: Readonly<Record<StackContractName, StackContractDeployment>> & Readonly<{
    stablecoinRegistration: Readonly<{ transactionHash: string; blockNumber: number }>;
    stablecoin?: StackContractDeployment;
  }>;
  registeredTokens: Readonly<{
    USDT: Readonly<{ address: string; tokenId: 1; decimals: 6 }>;
  }>;
}>;

type StackPublicationResult =
  | Readonly<{ status: 'not_requested'; scope: 'local' }>
  | Readonly<{
      status: 'queued' | 'published';
      scope: 'community' | 'official';
      announcement: JurisdictionGossipAnnouncement;
    }>;

export type DeployJurisdictionStackResult = Readonly<{
  manifest: JurisdictionStackManifest;
  localJurisdiction: Readonly<{ key: string; name: string }>;
  publication: StackPublicationResult;
}>;

export type StackManagerPhase =
  | 'idle'
  | 'preflight'
  | 'deploying'
  | 'verifying'
  | 'persisting'
  | 'complete'
  | 'failed';

export type StackManagerStatus = Readonly<{
  phase: StackManagerPhase;
  active: boolean;
  updatedAt: string;
  error?: string;
}>;

export type StackManagerProbe = Readonly<{
  rpcUrl: string;
  chainId: number;
  signerId: string;
  nativeBalanceWei: string;
}>;

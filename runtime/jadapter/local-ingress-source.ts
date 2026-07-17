import { ethers } from 'ethers';

import type { Env, JReplica } from '../types';
import type { JAdapter } from './types';

export type LocalJEventIngressSource = JAdapter | JReplica;

export type BoundLocalJEventIngressSource = {
  replica: JReplica;
  replicaName: string;
  chainId: number;
  depositoryAddress: string;
  entityProviderAddress: string;
};

const requireChainId = (value: unknown, context: string): number => {
  const chainId = Number(value);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error(`J_EVENT_LOCAL_SOURCE_CHAIN_ID_INVALID:${context}:${String(value)}`);
  }
  return chainId;
};

const requireAddress = (value: unknown, field: string, context: string): string => {
  const raw = String(value ?? '').trim();
  if (!ethers.isAddress(raw) || raw === ethers.ZeroAddress) {
    throw new Error(`J_EVENT_LOCAL_SOURCE_${field}_INVALID:${context}:${raw || 'missing'}`);
  }
  return ethers.getAddress(raw).toLowerCase();
};

const replicaDepository = (replica: JReplica): unknown =>
  replica.depositoryAddress ?? replica.contracts?.depository;

const replicaEntityProvider = (replica: JReplica): unknown =>
  replica.entityProviderAddress ?? replica.contracts?.entityProvider;

/**
 * Binds manual event ingress to an object reference already owned by this Env.
 * Serialized HTTP/peer data can copy fields but cannot satisfy this identity
 * check, so it cannot select or relabel a jurisdiction stack.
 */
export const bindLocalJEventIngressSource = (
  env: Env,
  source: LocalJEventIngressSource | null | undefined,
  context: string,
): BoundLocalJEventIngressSource => {
  if (!source || typeof source !== 'object') {
    throw new Error(`J_EVENT_LOCAL_SOURCE_REQUIRED:${context}`);
  }
  const matches = [...(env.jReplicas?.entries() ?? [])].filter(([, replica]) =>
    replica === source || replica.jadapter === source
  );
  if (matches.length === 0) {
    throw new Error(`J_EVENT_LOCAL_SOURCE_NOT_REGISTERED:${context}`);
  }
  if (matches.length !== 1) {
    throw new Error(`J_EVENT_LOCAL_SOURCE_AMBIGUOUS:${context}:${matches.map(([name]) => name).sort().join(',')}`);
  }

  const [replicaName, replica] = matches[0]!;
  const chainId = requireChainId(replica.chainId, context);
  const depositoryAddress = requireAddress(replicaDepository(replica), 'DEPOSITORY', context);
  const entityProviderAddress = requireAddress(replicaEntityProvider(replica), 'ENTITY_PROVIDER', context);
  const adapter = replica.jadapter;
  if (adapter) {
    const adapterChainId = requireChainId(adapter.chainId, `${context}:adapter`);
    const adapterDepository = requireAddress(adapter.addresses?.depository, 'DEPOSITORY', `${context}:adapter`);
    const adapterEntityProvider = requireAddress(adapter.addresses?.entityProvider, 'ENTITY_PROVIDER', `${context}:adapter`);
    if (adapterChainId !== chainId) {
      throw new Error(
        `J_EVENT_LOCAL_SOURCE_CHAIN_ID_MISMATCH:${context}:replica=${chainId}:adapter=${adapterChainId}`,
      );
    }
    if (adapterDepository !== depositoryAddress) {
      throw new Error(
        `J_EVENT_LOCAL_SOURCE_DEPOSITORY_MISMATCH:${context}` +
        `:replica=${depositoryAddress}:adapter=${adapterDepository}`,
      );
    }
    if (adapterEntityProvider !== entityProviderAddress) {
      throw new Error(
        `J_EVENT_LOCAL_SOURCE_ENTITY_PROVIDER_MISMATCH:${context}` +
        `:replica=${entityProviderAddress}:adapter=${adapterEntityProvider}`,
      );
    }
  }

  return {
    replica,
    replicaName,
    chainId,
    depositoryAddress,
    entityProviderAddress,
  };
};

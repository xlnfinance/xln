#!/usr/bin/env bun
/**
 * Deployment descriptors for the RPC settlement parity harness.
 *
 * A descriptor is the only thing that crosses the deploy/attach boundary: the
 * deploy phase writes one, the attach phase reads one and never deploys. That
 * keeps a parity run against a public chain from redeploying a stack whose
 * sources are already verified on that chain.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { JAdapterAddresses, JAdapterReplicaConnection } from '../jurisdiction/adapter/types';

export type ParityDeployment = {
  schemaVersion: 1;
  chainId: number;
  contracts: JAdapterAddresses;
  entityProviderDeploymentBlock: number;
};

const ADDRESS_KEYS = ['account', 'depository', 'entityProvider', 'deltaTransformer'] as const;

const assertAddress = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`PARITY_DEPLOYMENT_ADDRESS_INVALID:${label}:${String(value)}`);
  }
  return value;
};

const assertDeploymentBlock = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`PARITY_DEPLOYMENT_BLOCK_INVALID:${String(value)}`);
  }
  return Number(value);
};

export const toParityDeployment = (
  chainId: number,
  contracts: JAdapterAddresses,
  entityProviderDeploymentBlock: number,
): ParityDeployment => ({
  schemaVersion: 1,
  chainId,
  contracts: {
    account: assertAddress(contracts.account, 'account'),
    depository: assertAddress(contracts.depository, 'depository'),
    entityProvider: assertAddress(contracts.entityProvider, 'entityProvider'),
    deltaTransformer: assertAddress(contracts.deltaTransformer, 'deltaTransformer'),
  },
  entityProviderDeploymentBlock: assertDeploymentBlock(entityProviderDeploymentBlock),
});

export const writeParityDeployment = (path: string, deployment: ParityDeployment): string => {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(deployment, null, 2)}\n`);
  return target;
};

const parseDeployment = (raw: unknown, source: string): ParityDeployment => {
  if (!raw || typeof raw !== 'object') throw new Error(`PARITY_DEPLOYMENT_MALFORMED:${source}`);
  const record = raw as Record<string, unknown>;
  const contractsRaw = record['contracts'];
  if (!contractsRaw || typeof contractsRaw !== 'object') {
    throw new Error(`PARITY_DEPLOYMENT_CONTRACTS_MISSING:${source}`);
  }
  const contracts = contractsRaw as Record<string, unknown>;
  const chainId = record['chainId'];
  if (!Number.isSafeInteger(chainId) || Number(chainId) <= 0) {
    throw new Error(`PARITY_DEPLOYMENT_CHAIN_ID_INVALID:${source}:${String(chainId)}`);
  }
  const resolved = {} as JAdapterAddresses;
  for (const key of ADDRESS_KEYS) resolved[key] = assertAddress(contracts[key], `${source}:${key}`);
  return toParityDeployment(
    Number(chainId),
    resolved,
    assertDeploymentBlock(record['entityProviderDeploymentBlock']),
  );
};

export const readParityDeployment = (path: string): ParityDeployment => {
  const target = resolve(path);
  return parseDeployment(JSON.parse(readFileSync(target, 'utf8')), target);
};

/**
 * Read a canonical `jurisdictions/deployments/<network>.json` descriptor. The
 * canonical file carries richer per-contract metadata; parity only needs the
 * four adapter addresses plus the EntityProvider deployment block.
 */
export const readJurisdictionDeployment = (path: string): ParityDeployment => {
  const target = resolve(path);
  return parseDeployment(JSON.parse(readFileSync(target, 'utf8')), target);
};

export const toReplicaConnection = (deployment: ParityDeployment): JAdapterReplicaConnection => ({
  contracts: { ...deployment.contracts },
  depositoryAddress: deployment.contracts.depository,
  entityProviderAddress: deployment.contracts.entityProvider,
  entityProviderDeploymentBlock: deployment.entityProviderDeploymentBlock,
});
